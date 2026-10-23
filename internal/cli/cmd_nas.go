package cli

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/tools"
)

func (a *App) addNASCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "nas <command>",
		Short: "TrueNAS 存储管理",
		Long: `通过 TrueNAS WebSocket JSON-RPC 管理存储。

命令:
  info              显示系统信息
  pool list         列出存储池
  dataset list      列出数据集
  snapshot list     列出快照
  rpc METHOD JSON   存储维护API白名单（数据集/备份账号/NFS/服务，不含数据集删除）

示例:
  ./spool nas info
  ./spool nas pool list`,
		RunE: a.runNAS,
	}
	root.AddCommand(cmd)
}

func (a *App) runNAS(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		nasHelp()
		return nil
	}

	if args[0] == "rpc" {
		if len(args) != 3 {
			return fmt.Errorf("usage: spool nas rpc METHOD JSON_ARRAY")
		}
		if err := tools.ValidateMaintenanceRPC(args[1], json.RawMessage(args[2])); err != nil {
			return err
		}
	}
	manager, err := tools.NewTrueNASManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to connect to TrueNAS: %w", err)
	}
	defer manager.Close()

	switch args[0] {
	case "rpc":
		return manager.CmdMaintenanceRPC(args[1], json.RawMessage(args[2]))
	case "info":
		if jsonFlag {
			info, err := manager.SystemInfo()
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), info, nil)
		}
		return manager.CmdInfo()
	case "pool":
		if len(args) > 1 && args[1] == "list" {
			if jsonFlag {
				pools, err := manager.Pools()
				if err != nil {
					return err
				}
				return writeJSON(cmd.OutOrStdout(), map[string]interface{}{"pools": pools}, nil)
			}
			return manager.CmdPoolList()
		}
		nasHelp()
		return nil
	case "dataset":
		if len(args) > 1 && args[1] == "list" {
			if jsonFlag {
				datasets, err := manager.Datasets()
				if err != nil {
					return err
				}
				return writeJSON(cmd.OutOrStdout(), map[string]interface{}{"datasets": datasets}, nil)
			}
			return manager.CmdDatasetList()
		}
		nasHelp()
		return nil
	case "snapshot":
		if len(args) > 1 && args[1] == "list" {
			pool := ""
			if len(args) > 2 {
				pool = args[2]
			}
			if jsonFlag {
				snapshots, err := manager.Snapshots(pool)
				if err != nil {
					return err
				}
				return writeJSON(cmd.OutOrStdout(), map[string]interface{}{"snapshots": snapshots}, nil)
			}
			return manager.CmdSnapshotList(pool)
		}
		nasHelp()
		return nil
	default:
		nasHelp()
		return nil
	}
}

func nasHelp() {
	fmt.Println(`TrueNAS Management

Usage: ./spool nas <command>

Commands:
  info              Show system information
  pool list        List storage pools
  dataset list     List datasets
  snapshot list    List snapshots

Examples:
  ./spool nas info
  ./spool nas pool list
  ./spool nas snapshot list tank`)
}
