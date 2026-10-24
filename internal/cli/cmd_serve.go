package cli

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/api"
)

func (a *App) addServeCmd(root *cobra.Command) {
	var (
		socket   string
		token    string
		auditLog string
	)
	cmd := &cobra.Command{
		Use:   "serve --socket /run/spool.sock",
		Short: "启动本地 HTTP/JSON 服务（Unix socket，可选）",
		Long: `启动可选的本地 HTTP/JSON 服务，不引入常驻控制面。

端点:
  GET  /v1/inventory
  GET  /v1/hosts/{host}/bundles/{bundle}
  GET  /v1/hosts/{host}/bundles/{bundle}/outputs
  POST /v1/actions
  GET  /v1/jobs/{id}

安全:
  - socket 权限固定 0600
  - 可选 --token：设置后所有请求需 Authorization: Bearer <token>
  - apply/rollback 需 options.yes=true，或 X-Spool-Approval: <token>
  - 审计日志默认 .spool/audit.log（JSON Lines）`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runServe(socket, token, auditLog)
		},
	}
	cmd.Flags().StringVar(&socket, "socket", "", "Unix socket 路径（必填）")
	cmd.Flags().StringVar(&token, "token", "", "可选 bearer token（admin scope）")
	cmd.Flags().StringVar(&auditLog, "audit-log", "", "审计日志路径（默认 .spool/audit.log）")
	root.AddCommand(cmd)
}

func (a *App) runServe(socket, token, auditLogPath string) error {
	if socket == "" {
		return newExitError(ExitUsage, "usage", fmt.Errorf("--socket is required"))
	}
	if err := a.LoadConfig(); err != nil {
		return err
	}
	if auditLogPath == "" {
		auditLogPath = filepath.Join(a.BaseDir, ".spool", "audit.log")
	}
	if err := os.MkdirAll(filepath.Dir(auditLogPath), 0755); err != nil {
		return err
	}
	auditFile, err := os.OpenFile(auditLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer auditFile.Close()

	runner := &api.EngineRunner{
		BaseDir:    a.BaseDir,
		Config:     a.Config,
		SSHKey:     api.ResolveSSHKey(a.BaseDir, a.Config),
		KnownHosts: api.KnownHostsPath(a.BaseDir),
	}
	server := api.NewServer(a.BaseDir, a.Config, runner, token, api.NewAuditLogger(auditFile))
	listener, err := api.ListenUnix(socket)
	if err != nil {
		return err
	}
	defer listener.Close()

	httpServer := &http.Server{Handler: server.Handler()}
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()
	fmt.Fprintf(os.Stderr, "spool serve listening on %s (socket mode 0600)\n", socket)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-signals:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpServer.Shutdown(ctx)
	}
}
