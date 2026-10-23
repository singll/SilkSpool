package cli

import (
	"fmt"
	"sort"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

type inventory struct {
	Hosts []inventoryHost `json:"hosts"`
}

type inventoryHost struct {
	Name      string             `json:"name"`
	Address   string             `json:"address,omitempty"`
	SSHPort   string             `json:"ssh_port,omitempty"`
	AppPrefix string             `json:"app_prefix,omitempty"`
	Probed    bool               `json:"probed"`
	Bundles   []inventoryBundle  `json:"bundles"`
	Services  []inventoryService `json:"services,omitempty"`
	Stack     []string           `json:"stack,omitempty"`
}

type inventoryBundle struct {
	Name       string            `json:"name"`
	Class      string            `json:"class,omitempty"`
	Version    string            `json:"version,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	DeployPath string            `json:"deploy_path,omitempty"`
	Services   []string          `json:"services,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Error      string            `json:"error,omitempty"`
}

type inventoryService struct {
	Alias   string `json:"alias"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Status  string `json:"status,omitempty"`
	Healthy bool   `json:"healthy,omitempty"`
}

func (a *App) addInventoryCmd(root *cobra.Command) {
	var probe bool
	cmd := &cobra.Command{
		Use:   "inventory",
		Short: "列出主机、Bundle 与服务清单",
		Long: `输出当前配置中的主机、Bundle、服务与部署路径。

默认只读取本地配置和 bundle manifest，不连接远程主机；
加 --probe 才会通过 SSH 探测服务状态（较慢）。

示例:
  spool inventory
  spool inventory --json
  spool inventory --probe --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runInventory(cmd, probe)
		},
	}
	cmd.Flags().BoolVar(&probe, "probe", false, "通过 SSH 探测服务状态（较慢）")
	root.AddCommand(cmd)
}

func (a *App) runInventory(cmd *cobra.Command, probe bool) error {
	if err := a.LoadConfig(); err != nil {
		return err
	}

	mgr, err := engine.NewBundleManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init bundle manager: %w", err)
	}

	var warnings []string
	hostNames := make([]string, 0, len(a.Config.Hosts))
	for name := range a.Config.Hosts {
		hostNames = append(hostNames, name)
	}
	sort.Strings(hostNames)

	hosts := make([]inventoryHost, 0, len(hostNames))
	for _, name := range hostNames {
		hostCfg := a.Config.Hosts[name]
		ih := inventoryHost{
			Name:      name,
			Address:   hostCfg.Address,
			SSHPort:   hostCfg.SSHPort,
			AppPrefix: hostCfg.AppPrefix,
			Probed:    probe,
			Stack:     hostCfg.Stack,
		}

		for _, bundleName := range hostCfg.Bundles {
			ib := inventoryBundle{
				Name:       bundleName,
				Driver:     "compose",
				DeployPath: mgr.DeployPath(bundleName),
			}
			manifest, err := engine.NewManifestLoader(a.BaseDir).Load(bundleName)
			if err != nil {
				ib.Error = err.Error()
				warnings = append(warnings, fmt.Sprintf("%s: bundle %s: %v", name, bundleName, err))
			} else {
				if manifest.Type != "" {
					ib.Driver = manifest.Type
				}
				ib.Class = manifest.Class
				ib.Version = manifest.Version
				ib.Services = manifest.Services
				ib.Labels = manifest.Labels
			}
			ih.Bundles = append(ih.Bundles, ib)
		}

		for _, svc := range hostCfg.Services {
			ih.Services = append(ih.Services, inventoryService{
				Alias: svc.Alias,
				Type:  svc.Type,
				Name:  svc.Name,
			})
		}

		if probe {
			sm, err := engine.NewServiceManager(a.BaseDir)
			if err != nil {
				return fmt.Errorf("failed to init service manager: %w", err)
			}
			statuses, err := sm.GetHostServices(name)
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("%s: probe failed: %v", name, err))
			} else {
				statusByAlias := make(map[string]engine.ServiceInfo, len(statuses))
				for _, status := range statuses {
					statusByAlias[status.Alias] = status
				}
				for i := range ih.Services {
					if status, ok := statusByAlias[ih.Services[i].Alias]; ok {
						ih.Services[i].Status = status.Status
						ih.Services[i].Healthy = status.Healthy
					}
				}
			}
		}

		hosts = append(hosts, ih)
	}

	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), inventory{Hosts: hosts}, warnings)
	}

	out := cmd.OutOrStdout()
	for _, host := range hosts {
		fmt.Fprintf(out, "%s (%s)\n", host.Name, host.Address)
		for _, bundle := range host.Bundles {
			class := bundle.Class
			if class == "" {
				class = "-"
			}
			version := bundle.Version
			if version == "" {
				version = "-"
			}
			fmt.Fprintf(out, "  bundle %s [%s] %s driver=%s deploy=%s\n", bundle.Name, class, version, bundle.Driver, bundle.DeployPath)
			if bundle.Error != "" {
				fmt.Fprintf(out, "    error: %s\n", bundle.Error)
			}
		}
		for _, svc := range host.Services {
			if svc.Status != "" {
				fmt.Fprintf(out, "  service %s (%s) %s\n", svc.Alias, svc.Name, svc.Status)
			} else {
				fmt.Fprintf(out, "  service %s (%s)\n", svc.Alias, svc.Name)
			}
		}
	}
	for _, warning := range warnings {
		fmt.Fprintf(out, "warning: %s\n", warning)
	}
	return nil
}
