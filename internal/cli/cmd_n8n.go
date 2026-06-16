package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/internal/tools"
	"github.com/singll/silkspool/pkg/utils"
)

type engineSSHProvider struct{}

func (p *engineSSHProvider) Execute(address, sshKey, cmd string) (string, error) {
	return engine.SSHExecute(address, sshKey, cmd)
}

func (a *App) addN8NCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "n8n <command>",
		Short: "n8n 工作流管理",
		Long: `通过 n8n REST API 管理工作流。

命令:
  list              列出工作流文件 (本地 + 远程 + n8n)
  import            导入新工作流到 n8n
  export            导出 n8n 工作流到本地备份 (--to-source 回写源目录)
  update [name]     更新现有工作流 (推送前展示 diff, --dry-run 仅预览, --yes 跳过确认)
  activate [name]   激活工作流
  deactivate <name> 停用工作流
  delete <name>     删除工作流

示例:
  ./spool n8n list
  ./spool n8n export --to-source   # 从 n8n 无损回写到 git 源目录
  ./spool n8n update --dry-run     # 仅预览将推送的 diff
  ./spool n8n push-import          # 推送 + 导入
  ./spool n8n push-update          # 推送 + 更新`,
		RunE: a.runN8N,
	}
	cmd.Flags().Bool("to-source", false, "export: 回写到 git 源目录 (hosts/<host>/n8n-workflows/) 而非备份目录")
	cmd.Flags().Bool("dry-run", false, "update: 仅展示 diff 不推送")
	cmd.Flags().Bool("yes", false, "update: 跳过有变更时的二次确认")
	root.AddCommand(cmd)
}

func (a *App) runN8N(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		n8nHelp()
		return nil
	}

	ctx := context.Background()

	manager, err := tools.NewN8NManager(a.BaseDir, &engineSSHProvider{})
	if err != nil {
		return fmt.Errorf("failed to initialize n8n client: %w", err)
	}
	defer manager.Close()

	switch args[0] {
	case "list":
		return a.runN8NList(ctx, manager, args[1:])
	case "import", "push-import":
		return a.runN8NImport(ctx, manager, args[1:])
	case "export":
		return a.runN8NExport(cmd, ctx, manager, args[1:])
	case "update", "push-update":
		return a.runN8NUpdate(cmd, ctx, manager, args[1:])
	case "activate":
		return a.runN8NActivate(ctx, manager, args[1:])
	case "deactivate":
		return a.runN8NDeactivate(ctx, manager, args[1:])
	case "delete":
		return a.runN8NDelete(ctx, manager, args[1:])
	default:
		n8nHelp()
		return nil
	}
}

func (a *App) runN8NList(ctx context.Context, m *tools.N8NManager, args []string) error {
	workflowDir, err := tools.GetN8NWorkflowDir(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to get workflow dir: %w", err)
	}

	utils.Info("Local workflow files (%s):", workflowDir)
	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		utils.Error("Failed to list local workflows: %v", err)
	} else {
		for _, f := range files {
			utils.Info("  - %s", filepath.Base(f))
		}
	}

	client, err := tools.NewN8NClient(a.BaseDir, "", &engineSSHProvider{})
	if err != nil {
		utils.Warn("Failed to create n8n client: %v", err)
		return nil
	}
	workflows, err := client.ListWorkflows(ctx)
	if err != nil {
		utils.Error("Failed to list n8n workflows: %v", err)
		return nil
	}
	utils.Info("\nWorkflows in n8n:")
	for _, wf := range workflows {
		status := "Inactive"
		if wf.Active {
			status = "Active"
		}
		utils.Info("  - %s (%s)", wf.Name, status)
	}
	return nil
}

func (a *App) runN8NImport(ctx context.Context, m *tools.N8NManager, args []string) error {
	workflowDir, err := tools.GetN8NWorkflowDir(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to get workflow dir: %w", err)
	}
	return m.ImportWorkflows(ctx, workflowDir)
}

func (a *App) runN8NExport(cmd *cobra.Command, ctx context.Context, m *tools.N8NManager, args []string) error {
	if toSource, _ := cmd.Flags().GetBool("to-source"); toSource {
		workflowDir, err := tools.GetN8NWorkflowDir(a.BaseDir)
		if err != nil {
			return fmt.Errorf("failed to get workflow dir: %w", err)
		}
		if err := m.ExportWorkflowsToSource(ctx, workflowDir); err != nil {
			return err
		}
		utils.Success("Exported to source: %s", workflowDir)
		return nil
	}

	backupDir, err := tools.GetN8NBackupDir(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to get backup dir: %w", err)
	}

	if err := m.ExportWorkflows(ctx, backupDir); err != nil {
		return err
	}
	utils.Success("Exported to: %s", backupDir)
	return nil
}

func (a *App) runN8NUpdate(cmd *cobra.Command, ctx context.Context, m *tools.N8NManager, args []string) error {
	workflowDir, err := tools.GetN8NWorkflowDir(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to get workflow dir: %w", err)
	}

	plan, err := m.PlanUpdate(ctx, workflowDir, args...)
	if err != nil {
		return err
	}
	plan.Render()

	if !plan.HasChanges() {
		utils.Info("无变更, 无需推送")
		return nil
	}

	if dryRun, _ := cmd.Flags().GetBool("dry-run"); dryRun {
		utils.Info("--dry-run: 未推送任何更改")
		return nil
	}

	if assumeYes, _ := cmd.Flags().GetBool("yes"); !assumeYes {
		if !confirmN8NPush() {
			utils.Warn("已取消, 未推送")
			return nil
		}
	}

	return m.ApplyUpdate(ctx, plan)
}

// confirmN8NPush 推送前的二次确认 (非破坏性, 简单 y/N)。非交互式终端拒绝。
func confirmN8NPush() bool {
	fi, err := os.Stdin.Stat()
	if err != nil || (fi.Mode()&os.ModeCharDevice) == 0 {
		fmt.Fprintln(os.Stderr, "[!] 非交互式终端拒绝推送 (传 --yes 以确认, 或 --dry-run 预览)")
		return false
	}
	fmt.Print("\n将以上改动推送到 n8n? [y/N]: ")
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	return strings.EqualFold(strings.TrimSpace(input), "y") || strings.EqualFold(strings.TrimSpace(input), "yes")
}

func (a *App) runN8NActivate(ctx context.Context, m *tools.N8NManager, args []string) error {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	return m.ActivateWorkflow(ctx, name)
}

func (a *App) runN8NDeactivate(ctx context.Context, m *tools.N8NManager, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: n8n deactivate <workflow-name>")
	}
	return m.DeactivateWorkflow(ctx, args[0])
}

func (a *App) runN8NDelete(ctx context.Context, m *tools.N8NManager, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: n8n delete <workflow-name>")
	}
	return m.DeleteWorkflow(ctx, args[0])
}

func n8nHelp() {
	fmt.Println(`n8n Workflow Management

Usage: ./spool n8n <command>

Commands:
  list              List workflow files (local + n8n)
  import            Import workflows to n8n
  export            Export workflows from n8n to backup
  update [name]     Update workflows
  activate [name]   Activate workflow
  deactivate <name> Deactivate workflow
  delete <name>     Delete workflow

Examples:
  ./spool n8n list
  ./spool n8n import`)
}
