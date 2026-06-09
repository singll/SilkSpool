package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/internal/tools"
	"github.com/singll/silkspool/pkg/utils"
)

// Version 信息
var (
	Version   = "2.0.0"
	BuildTime = "unknown"
	GitCommit = "unknown"
)

// BaseDir 项目根目录（运行时通过 resolveBaseDir 解析）
var BaseDir string

// ============ 命令定义 ============

// RootCmd 代表根命令
var RootCmd = &cobra.Command{
	Use:   "spool",
	Short: "SilkSpool V2 - 云基础设施编排 CLI 工具",
	Long: `SilkSpool (丝轴) - 云基础设施编排工具
基于 Go 重构，提供跨平台支持

主要功能:
  - 配置文件同步 (sync pull/push)
  - DNS 记录管理 (dns add/remove/push)
  - 站点快速部署 (site deploy)
  - Bundle 编排 (bundle <name> <action> <host>)
  - n8n 工作流管理 (n8n list/import/export)
  - TrueNAS 存储管理 (nas info/pool/dataset)
  - 主机接入/下线 (init / decommission)
  - SSH 管控密钥轮换 (key rotate/status)

使用 ./spool --help 查看完整帮助`,
	SilenceUsage: true,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		BaseDir = resolveBaseDir()
	},
}

// 全局标志
var (
	verboseFlag bool
	configFlag  string
)

func init() {
	// 全局 flags
	RootCmd.PersistentFlags().BoolVarP(&verboseFlag, "verbose", "v", false, "verbose output")
	RootCmd.PersistentFlags().StringVar(&configFlag, "config", "", "config file path (default: silkspool.yaml)")

	// 版本信息
	RootCmd.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "显示版本信息",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Printf("SilkSpool V%s\n", Version)
			fmt.Printf("  Build: %s (%s)\n", GitCommit, BuildTime)
		},
	})

	// 添加子命令
	addInitCmd()
	addSyncCmd()
	addDNSCmd()
	addSiteCmd()
	addBundleCmd()
	addStackCmd()
	addServiceCmd()
	addN8NCmd()
	addNASCmd()
	addBackupCmd()
	addExecCmd()
	addKeyCmd()
	addDecommissionCmd()
}

// ============ 子命令定义 ============

func addInitCmd() {
	cmd := &cobra.Command{
		Use:   "init [host]",
		Short: "初始化主机 (SSH 信任 + Docker 权限)",
		Long: `初始化远程主机的 SSH 信任关系和 Docker 操作权限。

示例:
  ./spool init keeper      # 初始化 keeper 主机
  ./spool init --all       # 初始化所有主机`,
		Run: runInit,
	}
	cmd.Flags().Bool("all", false, "初始化所有主机")
	RootCmd.AddCommand(cmd)
}

func addSyncCmd() {
	cmd := &cobra.Command{
		Use:   "sync <pull|push> [host]",
		Short: "同步配置文件",
		Long: `在本地 hosts/ 目录与远程服务器之间同步文件。

pull: 拉取远程配置到本地
push: 推送本地配置到远程

示例:
  ./spool sync pull keeper    # 拉取 keeper 配置
  ./spool sync push all       # 推送所有主机配置
  ./spool pull keeper         # 快捷方式
  ./spool push keeper         # 快捷方式`,
		Run: runSync,
	}
	RootCmd.AddCommand(cmd)

	// 快捷方式
	RootCmd.AddCommand(&cobra.Command{
		Use:   "pull [host]",
		Short: "同步拉取 (sync pull 的快捷方式)",
		Run:   runSyncPull,
	})

	RootCmd.AddCommand(&cobra.Command{
		Use:   "push [host]",
		Short: "同步推送 (sync push 的快捷方式)",
		Run:   runSyncPush,
	})
}

func addDNSCmd() {
	cmd := &cobra.Command{
		Use:   "dns <command>",
		Short: "DNS 记录管理",
		Long: `管理内网域名解析，同时更新多个 DNS 配置源。

命令:
  list              列出所有 DNS 记录
  add <domain> [ip] 添加域名 (默认指向网关 IP)
  remove <domain>   删除域名
  push              推送配置到远程服务器
  deploy <domain>   一键部署 (添加+推送+重启服务)

示例:
  ./spool dns list
  ./spool dns add myapp.singll.net
  ./spool dns deploy myapp.singll.net
  ./spool dns sync-caddy    # 从 Caddyfile 同步域名`,
		Run: runDNS,
	}
	RootCmd.AddCommand(cmd)
}

func addSiteCmd() {
	cmd := &cobra.Command{
		Use:   "site <command>",
		Short: "站点快速部署",
		Long: `一键部署站点: DNS + Caddy 反向代理 + Homepage 仪表盘。

命令:
  list              列出所有站点
  add <domain> <backend> <name> [desc] [icon]
  deploy <domain> <backend> <name>  一键部署
  push              推送所有站点配置

示例:
  ./spool site deploy myapp.singll.net 192.168.7.100:8080 MyApp 'My Application'`,
		Run: runSite,
	}
	RootCmd.AddCommand(cmd)
}

func addBundleCmd() {
	cmd := &cobra.Command{
		Use:   "bundle <name> <action> <host>",
		Short: "Bundle 编排",
		Long: `执行 Bundle 业务包编排操作。

Actions:
  init              初始化默认配置 (下载到 hosts/<host>/)
  setup             安装 + 推送配置 + 初始化
  up                启动服务
  down              停止服务
  status            查看服务状态
  service <svc> <action>  管理单个服务

示例:
  ./spool bundle keeper init keeper
  ./spool bundle keeper up keeper
  ./spool bundle keeper service keeper bellkeeper up`,
		Run: runBundle,
	}
	cmd.Flags().Bool("yes", false, "跳过危险操作 (down/cleanup) 的二次确认")
	RootCmd.AddCommand(cmd)
}

func addStackCmd() {
	cmd := &cobra.Command{
		Use:   "stack <host>",
		Short: "安装二进制服务栈 (caddy, headscale, etc.)",
		Long: `安装主机配置的基础二进制服务栈。

示例:
  ./spool stack txhk`,
		Run: runStack,
	}
	RootCmd.AddCommand(cmd)
}

func addServiceCmd() {
	cmd := &cobra.Command{
		Use:   "service <host> <action> [service]",
		Short: "服务控制",
		Long: `管理远程服务 (Docker 容器 / Systemd 服务 / OpenWrt init.d)

Actions:
  status [svc]      查看服务状态
  start [svc]      启动服务
  stop [svc]       停止服务
  restart [svc]    重启服务
  logs [svc] [N]   查看日志 (默认 50 行)

示例:
  ./spool service keeper status
  ./spool service keeper restart n8n
  ./spool service keeper logs n8n 100`,
		Run: runService,
	}
	RootCmd.AddCommand(cmd)

	// 快捷方式
	RootCmd.AddCommand(&cobra.Command{
		Use:   "status [host]",
		Short: "查看服务状态",
		Run:   runStatus,
	})
	RootCmd.AddCommand(&cobra.Command{
		Use:   "restart <host> [service]",
		Short: "重启服务",
		Run:   runRestart,
	})
	RootCmd.AddCommand(&cobra.Command{
		Use:   "logs <host> <service> [lines]",
		Short: "查看服务日志",
		Run:   runLogs,
	})
}

func addN8NCmd() {
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
		RunE: func(cmd *cobra.Command, args []string) error {
			runN8NGo(cmd, args)
			return nil
		},
	}
	RootCmd.AddCommand(cmd)
}

func addNASCmd() {
	cmd := &cobra.Command{
		Use:   "nas <command>",
		Short: "TrueNAS 存储管理",
		Long: `通过 TrueNAS WebSocket JSON-RPC 管理存储。

命令:
  info              显示系统信息
  pool list         列出存储池
  dataset list      列出数据集
  snapshot list     列出快照

示例:
  ./spool nas info
  ./spool nas pool list`,
		RunE: func(cmd *cobra.Command, args []string) error {
			runNASGo(cmd, args)
			return nil
		},
	}
	RootCmd.AddCommand(cmd)
}

func addBackupCmd() {
	cmd := &cobra.Command{
		Use:   "backup <host>",
		Short: "备份主机数据",
		Long: `备份远程主机的 Docker 卷和配置目录。

示例:
  ./spool backup keeper
  ./spool backup all`,
		Run: runBackup,
	}
	RootCmd.AddCommand(cmd)
}

func addExecCmd() {
	cmd := &cobra.Command{
		Use:   "exec <host> <command...>",
		Short: "在远程主机执行命令",
		Long: `在远程主机上执行任意命令。

示例:
  ./spool exec keeper docker ps
  ./spool exec txhk "systemctl status headscale"`,
		Run: runExec,
	}
	RootCmd.AddCommand(cmd)
}

func addKeyCmd() {
	cmd := &cobra.Command{
		Use:   "key <command>",
		Short: "SSH 管控密钥管理",
		Long: `管理 spool 用于访问受管控主机的 SSH 密钥。

命令:
  rotate            在所有受管控主机上轮换 SSH 密钥 (旧 -> 新)
  status [host]     检查每台主机是否已授权当前公钥

rotate 采用两阶段、全有或全无的安全时序: 先在每台主机部署并验证新密钥，
全部通过后才切换本地密钥并移除远程旧密钥，过程中不会把自己锁在门外。
若有主机已永久失联，请先 decommission 该主机再 rotate。

示例:
  ./spool key status --all
  ./spool key rotate --dry-run     # 预演 (不修改任何内容)
  ./spool key rotate               # 自动生成新 ed25519 密钥并轮换
  ./spool key rotate --new ./keys/id_new --keep-old-remote`,
		Run: runKey,
	}
	cmd.Flags().String("new", "", "指定新私钥路径 (默认自动生成 ed25519)")
	cmd.Flags().Bool("keep-old-remote", false, "保留远程旧公钥作为兜底 (不移除)")
	cmd.Flags().Bool("dry-run", false, "仅验证可达性并打印计划，不修改任何内容")
	cmd.Flags().Bool("all", false, "key status: 检查所有主机")
	cmd.Flags().Bool("yes", false, "跳过危险操作二次确认")
	RootCmd.AddCommand(cmd)
}

func addDecommissionCmd() {
	cmd := &cobra.Command{
		Use:     "decommission <host>",
		Aliases: []string{"unmanage"},
		Short:   "解除主机管控 (吊销 SSH 访问)",
		Long: `把主机从 SilkSpool 管控中下线: 从远程 authorized_keys 移除 spool 公钥，
使 spool 不再能登录该主机。与 init (接入) 对称。

默认不修改配置文件，只打印需手动清理的内容。
加 --purge-config 才会从 silkspool.yaml 删除该主机块 (保留其它主机注释，先写 .bak 备份)。

示例:
  ./spool decommission bili-node
  ./spool decommission bili-node --purge-config --yes`,
		Run: runDecommission,
	}
	cmd.Flags().Bool("purge-config", false, "同时从 silkspool.yaml 删除该主机块")
	cmd.Flags().Bool("yes", false, "跳过危险操作二次确认")
	RootCmd.AddCommand(cmd)
}

// ============ 命令处理函数 (Phase 3: Go Engine) ============

func runSync(cmd *cobra.Command, args []string) {
	if len(args) < 2 {
		fmt.Println("Usage: spool sync <pull|push> <host|all>")
		os.Exit(1)
	}

	direction := args[0]
	host := args[1]

	mgr, err := engine.NewSyncManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init sync manager: %v", err)
		os.Exit(1)
	}

	var err2 error
	if host == "all" {
		err2 = mgr.SyncAll(direction)
	} else {
		err2 = mgr.SyncHost(host, direction)
	}

	if err2 != nil {
		utils.Error("Sync failed: %v", err2)
		os.Exit(1)
	}
}

func runSyncPull(cmd *cobra.Command, args []string) {
	runSync(cmd, append([]string{"pull"}, args...))
}

func runSyncPush(cmd *cobra.Command, args []string) {
	runSync(cmd, append([]string{"push"}, args...))
}

func runDNS(cmd *cobra.Command, args []string) {
	// Phase 3: 使用 Go 原生 DNS 引擎
	runDNSGo(args)
}

// ============ DNS 命令 (Go 原生) ============

func runDNSGo(args []string) {
	if len(args) == 0 {
		dnsHelp()
		return
	}

	mgr, err := engine.NewDNSManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init DNS manager: %v", err)
		os.Exit(1)
	}

	switch args[0] {
	case "list", "ls":
		runDNSList(mgr)
	case "add":
		if len(args) < 2 {
			utils.Error("Usage: dns add <domain> [ip]")
			os.Exit(1)
		}
		domain := args[1]
		ip := ""
		if len(args) > 2 {
			ip = args[2]
		}
		if err := mgr.AddDomain(domain, ip); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "remove", "rm":
		if len(args) < 2 {
			utils.Error("Usage: dns remove <domain>")
			os.Exit(1)
		}
		if err := mgr.RemoveDomain(args[1]); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "push":
		if err := mgr.PushDNS(); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "sync-caddy":
		if err := mgr.SyncFromCaddyfile(); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "deploy":
		if len(args) < 2 {
			utils.Error("Usage: dns deploy <domain> [ip]")
			os.Exit(1)
		}
		domain := args[1]
		ip := ""
		if len(args) > 2 {
			ip = args[2]
		}
		if err := mgr.DeployDomain(domain, ip); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "pull":
		if err := mgr.PullDNS(); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	default:
		dnsHelp()
	}
}

func runDNSList(mgr *engine.DNSManager) {
	records, err := mgr.ListDNSRecords()
	if err != nil {
		utils.Error("Failed: %v", err)
		return
	}

	utils.Info("DNS Records:")
	for _, r := range records {
		utils.Info("  %s -> %s", r.Domain, r.IP)
	}
}

func dnsHelp() {
	fmt.Println(`DNS Management

Usage: ./spool dns <command>

Commands:
  list              List DNS records
  add <domain> [ip] Add DNS record
  remove <domain>   Remove DNS record
  push              Push DNS config to remote
  pull              Pull DNS config from remote
  deploy <domain>   One-click deploy (add + push + restart)
  sync-caddy        Sync domains from Caddyfile

Examples:
  ./spool dns list
  ./spool dns add myapp.singll.net
  ./spool dns deploy myapp.singll.net`)
}

// ============ Bundle 命令 ============

func runBundle(cmd *cobra.Command, args []string) {
	if len(args) < 3 {
		fmt.Println("Usage: spool bundle <name> <action> <host> [service] [svc-action]")
		os.Exit(1)
	}

	name := args[0]
	action := args[1]
	host := args[2]

	// 危险操作二次确认 (down / cleanup)
	if action == "down" || action == "cleanup" {
		assumeYes, _ := cmd.Flags().GetBool("yes")
		if !engine.ConfirmDestructive(action, fmt.Sprintf("bundle %s on %s", name, host), assumeYes) {
			utils.Warn("Aborted")
			return
		}
	}

	mgr, err := engine.NewBundleManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init bundle manager: %v", err)
		os.Exit(1)
	}

	// service 子命令需要额外参数
	if action == "service" {
		if len(args) < 5 {
			fmt.Println("Usage: spool bundle <name> service <host> <service> <action>")
			os.Exit(1)
		}
		svc := args[3]
		svcAction := args[4]
		if err := mgr.SetupBundleService(name, host, svc, svcAction); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
		return
	}

	if err := mgr.SetupBundle(name, host, action); err != nil {
		utils.Error("Failed: %v", err)
		os.Exit(1)
	}
}

// ============ Stack 命令 ============

func runStack(cmd *cobra.Command, args []string) {
	if len(args) < 1 {
		utils.Error("Usage: spool stack <host>")
		os.Exit(1)
	}

	host := args[0]

	mgr, err := engine.NewInstallManager(BaseDir)
	if err != nil {
		utils.Error("Failed: %v", err)
		os.Exit(1)
	}

	if err := mgr.InstallStack(host); err != nil {
		utils.Error("Failed: %v", err)
		os.Exit(1)
	}
}

// ============ Service 命令 ============

func runService(cmd *cobra.Command, args []string) {
	if len(args) < 2 {
		fmt.Println("Usage: spool service <host> <action> [service]")
		os.Exit(1)
	}

	host := args[0]
	action := args[1]
	service := ""
	if len(args) > 2 {
		service = args[2]
	}

	mgr, err := engine.NewServiceManager(BaseDir)
	if err != nil {
		utils.Error("Failed: %v", err)
		os.Exit(1)
	}

	switch action {
	case "status":
		if service == "" {
			runServiceList(mgr, host)
		} else {
			runServiceStatus(mgr, host, service)
		}
	case "start":
		if service == "" {
			utils.Error("Usage: spool service <host> start <service>")
			os.Exit(1)
		}
		if err := mgr.StartService(host, service); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "stop":
		if service == "" {
			utils.Error("Usage: spool service <host> stop <service>")
			os.Exit(1)
		}
		if err := mgr.StopService(host, service); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "restart":
		if service == "" {
			utils.Error("Usage: spool service <host> restart <service>")
			os.Exit(1)
		}
		if err := mgr.RestartService(host, service); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "logs":
		if service == "" {
			utils.Error("Usage: spool service <host> logs <service> [lines]")
			os.Exit(1)
		}
		lines := 50
		if len(args) > 3 {
			fmt.Sscanf(args[3], "%d", &lines)
		}
		output, err := mgr.GetServiceLogs(host, service, lines)
		if err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
		fmt.Print(output)
	default:
		fmt.Println("Usage: spool service <host> <action> [service]")
		os.Exit(1)
	}
}

func runServiceList(mgr *engine.ServiceManager, host string) {
	services, err := mgr.GetHostServices(host)
	if err != nil {
		utils.Error("Failed: %v", err)
		return
	}

	utils.Info("Services on %s:", host)
	for _, s := range services {
		status := "running"
		if !s.Healthy {
			status = "stopped"
		}
		utils.Info("  %s (%s) - %s", s.Alias, s.Name, status)
	}
}

func runServiceStatus(mgr *engine.ServiceManager, host, service string) {
	status, err := mgr.GetServiceStatus(host, service)
	if err != nil {
		utils.Error("Failed: %v", err)
		os.Exit(1)
	}
	utils.Info("%s: %s", service, status)
}

func runStatus(cmd *cobra.Command, args []string) {
	if len(args) < 1 {
		utils.Error("Usage: spool status <host>")
		os.Exit(1)
	}
	runService(cmd, append(args, "status"))
}

func runRestart(cmd *cobra.Command, args []string) {
	if len(args) < 2 {
		utils.Error("Usage: spool restart <host> [service]")
		os.Exit(1)
	}
	runService(cmd, []string{args[0], "restart", args[1]})
}

func runLogs(cmd *cobra.Command, args []string) {
	if len(args) < 2 {
		utils.Error("Usage: spool logs <host> <service> [lines]")
		os.Exit(1)
	}
	lines := 50
	if len(args) > 2 {
		fmt.Sscanf(args[2], "%d", &lines)
	}
	runService(cmd, []string{args[0], "logs", args[1], fmt.Sprintf("%d", lines)})
}

func runInit(cmd *cobra.Command, args []string) {
	mgr, err := engine.NewInitManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init: %v", err)
		os.Exit(1)
	}

	if all, _ := cmd.Flags().GetBool("all"); all {
		if err := mgr.RunAll(); err != nil {
			utils.Error("Init failed: %v", err)
			os.Exit(1)
		}
		return
	}

	if len(args) < 1 {
		utils.Error("Usage: spool init <host> (or --all)")
		os.Exit(1)
	}
	if err := mgr.Run(args[0]); err != nil {
		utils.Error("Init failed: %v", err)
		os.Exit(1)
	}
}

func runSite(cmd *cobra.Command, args []string) {
	if len(args) == 0 {
		siteHelp()
		return
	}

	mgr, err := engine.NewSiteManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init site manager: %v", err)
		os.Exit(1)
	}

	switch args[0] {
	case "list", "ls":
		sites, err := mgr.ListSites()
		if err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
		utils.Info("Configured sites:")
		for _, s := range sites {
			utils.Info("  %s -> %s", s.Domain, s.Backend)
		}
	case "add":
		if len(args) < 4 {
			utils.Error("Usage: site add <domain> <backend> <name> [desc] [icon]")
			os.Exit(1)
		}
		desc, icon := "", ""
		if len(args) > 4 {
			desc = args[4]
		}
		if len(args) > 5 {
			icon = args[5]
		}
		if err := mgr.AddSite(args[1], args[2], args[3], desc, icon); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "remove", "rm":
		if len(args) < 2 {
			utils.Error("Usage: site remove <domain>")
			os.Exit(1)
		}
		if err := mgr.RemoveSite(args[1]); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "deploy":
		if len(args) < 4 {
			utils.Error("Usage: site deploy <domain> <backend> <name> [desc] [icon]")
			os.Exit(1)
		}
		desc, icon := "", ""
		if len(args) > 4 {
			desc = args[4]
		}
		if len(args) > 5 {
			icon = args[5]
		}
		if err := mgr.DeploySite(args[1], args[2], args[3], desc, icon); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "push":
		if err := mgr.PushSites(); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	default:
		siteHelp()
	}
}

func siteHelp() {
	fmt.Println(`Site Management

Usage: ./spool site <command>

Commands:
  list                                            List all sites
  add <domain> <backend> <name> [desc] [icon]     Add site (DNS + Caddy + Homepage)
  remove <domain>                                 Remove site
  deploy <domain> <backend> <name> [desc] [icon]  One-click deploy (add + push + restart)
  push                                            Push all site configs

Examples:
  ./spool site deploy myapp.singll.net 192.168.7.100:8080 MyApp 'My Application'`)
}

func runBackup(cmd *cobra.Command, args []string) {
	if len(args) < 1 {
		utils.Error("Usage: spool backup <host|all>")
		os.Exit(1)
	}

	cfg, err := config.LoadConfig(BaseDir)
	if err != nil {
		utils.Error("Failed to load config: %v", err)
		os.Exit(1)
	}
	sshKey := filepath.Join(BaseDir, cfg.Global.SSHKeyPath)

	runOne := func(host string, hostCfg *config.HostConfig) {
		if len(hostCfg.Backups) == 0 {
			utils.Warn("No backup rules for %s, skipping", host)
			return
		}
		mgr := engine.NewBackupManagerFromConfig(host, hostCfg)
		client, err := engine.NewSSHClient(hostCfg.Address, sshKey)
		if err != nil {
			utils.Error("SSH client failed for %s: %v", host, err)
			return
		}
		defer client.Close()
		mgr.SetSSHClient(client)

		results, err := mgr.Run(context.Background())
		if err != nil {
			utils.Error("Backup %s failed: %v", host, err)
			return
		}
		utils.Success("Backup %s -> %s (%d items)", host, mgr.LocalDir(), len(results))
	}

	if args[0] == "all" {
		for host := range cfg.Hosts {
			hc := cfg.GetHost(host)
			runOne(host, hc)
		}
	} else {
		hc := cfg.GetHost(args[0])
		if hc == nil {
			utils.Error("Unknown host: %s", args[0])
			os.Exit(1)
		}
		runOne(args[0], hc)
	}
}

func runExec(cmd *cobra.Command, args []string) {
	if len(args) < 2 {
		utils.Error("Usage: spool exec <host> <command...>")
		os.Exit(1)
	}

	host := args[0]
	cfg, err := config.LoadConfig(BaseDir)
	if err != nil {
		utils.Error("Failed to load config: %v", err)
		os.Exit(1)
	}
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		utils.Error("Unknown host: %s", host)
		os.Exit(1)
	}

	// 用本地 ssh 透传 (支持交互式命令)，密钥与同步一致
	sshKey := filepath.Join(BaseDir, cfg.Global.SSHKeyPath)
	sshArgs := []string{"-i", sshKey, "-o", "ConnectTimeout=10", "-t", hostCfg.Address}
	sshArgs = append(sshArgs, args[1:]...)

	c := exec.Command("ssh", sshArgs...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if err := c.Run(); err != nil {
		os.Exit(1)
	}
}

// ============ Key / Decommission 命令 ============

func runKey(cmd *cobra.Command, args []string) {
	if len(args) == 0 {
		_ = cmd.Help()
		return
	}

	mgr, err := engine.NewKeyManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init key manager: %v", err)
		os.Exit(1)
	}

	switch args[0] {
	case "rotate":
		newKey, _ := cmd.Flags().GetString("new")
		keepOld, _ := cmd.Flags().GetBool("keep-old-remote")
		dryRun, _ := cmd.Flags().GetBool("dry-run")
		assumeYes, _ := cmd.Flags().GetBool("yes")
		if err := mgr.Rotate(engine.RotateOptions{
			NewKeyPath:    newKey,
			KeepOldRemote: keepOld,
			DryRun:        dryRun,
			AssumeYes:     assumeYes,
		}); err != nil {
			utils.Error("%v", err)
			os.Exit(1)
		}
	case "status":
		var hosts []string
		if all, _ := cmd.Flags().GetBool("all"); !all && len(args) > 1 {
			hosts = args[1:]
		}
		if err := mgr.Status(hosts); err != nil {
			utils.Error("%v", err)
			os.Exit(1)
		}
	default:
		_ = cmd.Help()
	}
}

func runDecommission(cmd *cobra.Command, args []string) {
	if len(args) < 1 {
		utils.Error("Usage: spool decommission <host> [--purge-config] [--yes]")
		os.Exit(1)
	}

	mgr, err := engine.NewKeyManager(BaseDir)
	if err != nil {
		utils.Error("Failed to init key manager: %v", err)
		os.Exit(1)
	}

	purge, _ := cmd.Flags().GetBool("purge-config")
	assumeYes, _ := cmd.Flags().GetBool("yes")
	if err := mgr.Decommission(args[0], engine.DecommissionOptions{
		PurgeConfig: purge,
		AssumeYes:   assumeYes,
	}); err != nil {
		utils.Error("%v", err)
		os.Exit(1)
	}
}

// ============ Phase 2: Go 原生实现 ============

func runN8NGo(cmd *cobra.Command, args []string) {
	if len(args) == 0 {
		n8nHelp()
		return
	}

	ctx := context.Background()

	manager, err := tools.NewN8NManager(BaseDir)
	if err != nil {
		utils.Error("Failed to initialize n8n client: %v", err)
		os.Exit(1)
	}
	defer manager.Close()

	switch args[0] {
	case "list":
		runN8NList(ctx, manager, args[1:])
	case "import", "push-import":
		runN8NImport(ctx, manager, args[1:])
	case "export":
		runN8NExport(ctx, manager, args[1:])
	case "update", "push-update":
		runN8NUpdate(ctx, manager, args[1:])
	case "activate":
		runN8NActivate(ctx, manager, args[1:])
	case "deactivate":
		runN8NDeactivate(ctx, manager, args[1:])
	case "delete":
		runN8NDelete(ctx, manager, args[1:])
	default:
		n8nHelp()
	}
}

func runN8NList(ctx context.Context, m *tools.N8NManager, args []string) {
	workflowDir, err := tools.GetN8NWorkflowDir(BaseDir)
	if err != nil {
		utils.Error("Failed to get workflow dir: %v", err)
		return
	}

	// 列出本地文件
	utils.Info("Local workflow files (%s):", workflowDir)
	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		utils.Error("Failed to list local workflows: %v", err)
	} else {
		for _, f := range files {
			utils.Info("  - %s", filepath.Base(f))
		}
	}

	// 列出 n8n 中的工作流
	client, _ := tools.NewN8NClient(BaseDir, "")
	if client != nil {
		workflows, err := client.ListWorkflows(ctx)
		if err != nil {
			utils.Error("Failed to list n8n workflows: %v", err)
		} else {
			utils.Info("\nWorkflows in n8n:")
			for _, wf := range workflows {
				status := "Inactive"
				if wf.Active {
					status = "Active"
				}
				utils.Info("  - %s (%s)", wf.Name, status)
			}
		}
	}
}

func runN8NImport(ctx context.Context, m *tools.N8NManager, args []string) {
	workflowDir, err := tools.GetN8NWorkflowDir(BaseDir)
	if err != nil {
		utils.Error("Failed to get workflow dir: %v", err)
		os.Exit(1)
	}

	if err := m.ImportWorkflows(ctx, workflowDir); err != nil {
		utils.Error("Import failed: %v", err)
		os.Exit(1)
	}
}

func runN8NExport(ctx context.Context, m *tools.N8NManager, args []string) {
	backupDir, err := tools.GetN8NBackupDir(BaseDir)
	if err != nil {
		utils.Error("Failed to get backup dir: %v", err)
		os.Exit(1)
	}

	if err := m.ExportWorkflows(ctx, backupDir); err != nil {
		utils.Error("Export failed: %v", err)
		os.Exit(1)
	}
	utils.Success("Exported to: %s", backupDir)
}

func runN8NUpdate(ctx context.Context, m *tools.N8NManager, args []string) {
	workflowDir, err := tools.GetN8NWorkflowDir(BaseDir)
	if err != nil {
		utils.Error("Failed to get workflow dir: %v", err)
		os.Exit(1)
	}
	if err := m.UpdateWorkflows(ctx, workflowDir, args...); err != nil {
		utils.Error("Update failed: %v", err)
		os.Exit(1)
	}
}

func runN8NActivate(ctx context.Context, m *tools.N8NManager, args []string) {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	if err := m.ActivateWorkflow(ctx, name); err != nil {
		utils.Error("Activate failed: %v", err)
		os.Exit(1)
	}
}

func runN8NDeactivate(ctx context.Context, m *tools.N8NManager, args []string) {
	if len(args) == 0 {
		utils.Error("Usage: n8n deactivate <workflow-name>")
		os.Exit(1)
	}
	if err := m.DeactivateWorkflow(ctx, args[0]); err != nil {
		utils.Error("Deactivate failed: %v", err)
		os.Exit(1)
	}
}

func runN8NDelete(ctx context.Context, m *tools.N8NManager, args []string) {
	if len(args) == 0 {
		utils.Error("Usage: n8n delete <workflow-name>")
		os.Exit(1)
	}
	if err := m.DeleteWorkflow(ctx, args[0]); err != nil {
		utils.Error("Delete failed: %v", err)
		os.Exit(1)
	}
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

func runNASGo(cmd *cobra.Command, args []string) {
	if len(args) == 0 {
		nasHelp()
		return
	}

	manager, err := tools.NewTrueNASManager(BaseDir)
	if err != nil {
		utils.Error("Failed to connect to TrueNAS: %v", err)
		os.Exit(1)
	}
	defer manager.Close()

	switch args[0] {
	case "info":
		if err := manager.CmdInfo(); err != nil {
			utils.Error("Failed: %v", err)
			os.Exit(1)
		}
	case "pool":
		if len(args) > 1 && args[1] == "list" {
			if err := manager.CmdPoolList(); err != nil {
				utils.Error("Failed: %v", err)
				os.Exit(1)
			}
		} else {
			nasHelp()
		}
	case "dataset":
		if len(args) > 1 && args[1] == "list" {
			if err := manager.CmdDatasetList(); err != nil {
				utils.Error("Failed: %v", err)
				os.Exit(1)
			}
		} else {
			nasHelp()
		}
	case "snapshot":
		if len(args) > 1 && args[1] == "list" {
			pool := ""
			if len(args) > 2 {
				pool = args[2]
			}
			if err := manager.CmdSnapshotList(pool); err != nil {
				utils.Error("Failed: %v", err)
				os.Exit(1)
			}
		} else {
			nasHelp()
		}
	default:
		nasHelp()
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

// ============ BaseDir 解析 ============

// resolveBaseDir 解析项目根目录，优先级：
// 1. --config 参数指定的目录
// 2. 可执行文件所在目录（如果是有效 Spool 目录）
// 3. 当前工作目录（fallback）
func resolveBaseDir() string {
	// 1. --config 参数指定了完整路径
	if configFlag != "" {
		if filepath.IsAbs(configFlag) {
			return filepath.Dir(configFlag)
		}
		cwd, err := os.Getwd()
		if err == nil {
			return filepath.Dir(filepath.Join(cwd, configFlag))
		}
		return filepath.Dir(configFlag)
	}

	// 2. 可执行文件所在目录
	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		if isValidSpoolDir(exeDir) {
			return exeDir
		}
	}

	// 3. 当前工作目录
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}

	return "."
}

// isValidSpoolDir 判断目录是否包含 Spool 运行所需的标识文件/目录
func isValidSpoolDir(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "bundles")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(dir, "silkspool.yaml")); err == nil {
		return true
	}
	return false
}

// ============ main 函数 ============

func main() {
	defer engine.CloseGlobalPool()
	if err := RootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
