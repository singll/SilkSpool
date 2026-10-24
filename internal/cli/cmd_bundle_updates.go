package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) newBundleCheckUpdatesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "check-updates <name>",
		Short: "列出固定 digest 镜像的可更新版本（不修改 manifest）",
		Long: `扫描 bundle 及其 components/dependencies 中的固定 digest 镜像，查询 registry tag。

只输出建议，不自动修改 manifest，也不自动 apply。更新流程：
  1. 用 Renovate/Dependabot 或人工更新镜像 tag/digest
  2. spool plan <bundle> <host> --offline
  3. spool plan <bundle> <host> && spool apply <bundle> <host> --locked --yes`,
		RunE: a.runBundleCheckUpdates,
	}
	return cmd
}

func (a *App) runBundleCheckUpdates(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool bundle check-updates <name> [--json]")
	}
	if err := a.LoadConfig(); err != nil {
		return err
	}
	client := engine.RegistryClientFactory()
	report, err := engine.CheckUpdates(context.Background(), a.BaseDir, a.Config, args[0], client)
	if err != nil {
		return newExitError(ExitFailed, "execution_failed", err)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), report, report.Warnings)
	}
	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "bundle %s: %d pinned image(s)\n", report.Bundle, len(report.Images))
	for _, image := range report.Images {
		status := "up-to-date"
		if image.UpdateAvailable {
			status = "update available: " + image.LatestTag
		}
		fmt.Fprintf(out, "  %s\n    current=%s digest=%s -> %s\n", image.Image, image.CurrentTag, image.CurrentDigest, status)
	}
	for _, warning := range report.Warnings {
		fmt.Fprintf(out, "  warning: %s\n", warning)
	}
	if report.Suggested != "" {
		fmt.Fprintf(out, "  suggestion: %s\n", report.Suggested)
	}
	return nil
}
