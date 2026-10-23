package main

import (
	"os"

	"github.com/singll/silkspool/internal/cli"
	"github.com/singll/silkspool/internal/engine"
)

func main() {
	defer engine.CloseGlobalPool()
	root := cli.NewRootCmd()
	if err := root.Execute(); err != nil {
		if cli.JSONMode() {
			cli.ReportError(root.OutOrStdout(), err)
		} else {
			cli.ReportError(root.ErrOrStderr(), err)
		}
		os.Exit(cli.ExitCode(err))
	}
}
