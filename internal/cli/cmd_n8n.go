package cli

import (
	"context"
	"fmt"
	"path/filepath"

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
  export            导出 n8n 工作流到本地备份
  update [name]     更新现有工作流
  activate [name]   激活工作流
  deactivate <name> 停用工作流
  delete <name>     删除工作流

示例:
  ./spool n8n list
  ./spool n8n push-import      # 推送 + 导入
  ./spool n8n push-update      # 推送 + 更新`,
		RunE: a.runN8N,
	}
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
		return a.runN8NExport(ctx, manager, args[1:])
	case "update", "push-update":
		return a.runN8NUpdate(ctx, manager, args[1:])
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

func (a *App) runN8NExport(ctx context.Context, m *tools.N8NManager, args []string) error {
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

func (a *App) runN8NUpdate(ctx context.Context, m *tools.N8NManager, args []string) error {
	workflowDir, err := tools.GetN8NWorkflowDir(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to get workflow dir: %w", err)
	}
	return m.UpdateWorkflows(ctx, workflowDir, args...)
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
