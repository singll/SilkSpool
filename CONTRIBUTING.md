# Contributing to SilkSpool

Thank you for your interest in contributing! This guide covers the basics.

## Building / 构建

```bash
make build          # Compile binary to out/spool
make all            # Build + initialize out/ directory
make build-linux    # Cross-compile for linux/amd64
```

## Testing / 测试

```bash
make test           # Run all tests
make vet            # Run go vet
make lint           # Run golangci-lint (requires golangci-lint)
make check          # vet + test
```

## Adding a New Command / 添加新命令

1. Create `internal/cli/cmd_xxx.go` in the `cli` package
2. Add a method on `App` following the existing pattern:

```go
func (a *App) addXxxCmd(root *cobra.Command) {
    cmd := &cobra.Command{
        Use:   "xxx <args>",
        Short: "Short description / 简要描述",
        RunE: func(cmd *cobra.Command, args []string) error {
            // Implementation
            return nil
        },
    }
    root.AddCommand(cmd)
}
```

3. Register in `NewRootCmd()` in `cli.go`: `app.addXxxCmd(root)`
4. If the command needs an engine manager, create one in `internal/engine/`

## Adding a New Bundle / 添加新 Bundle

1. Create `bundles/<name>/manifest.yaml` (see `doc/bundle-development.md`)
2. Create `bundles/<name>/templates/` with compose YAML files
3. Add the bundle to a host in `silkspool.yaml`: `bundles: ["<name>"]`
4. Run `make all` to copy bundles to `out/`

## Commit Message Format / 提交格式

```
<type>: <description>
```

Types: `feat` / `fix` / `refactor` / `docs` / `chore`

Examples:
- `feat: add OBS WebSocket v5 controller`
- `fix: reverse mode priority logic`
- `refactor: extract CLI commands into internal/cli`

Multiple changes can use multi-line descriptions:
```
feat: add stack driver for binary services

- Install binaries from GitHub releases
- Push systemd service templates
- Support {ARCH} and {VERSION} placeholders
```

## Code Style / 代码风格

- Follow standard Go conventions (`gofmt`, `go vet`)
- No comments unless explicitly requested
- Use `RunE` instead of `Run` + `os.Exit(1)` for all cobra commands
- Error wrapping: use `fmt.Errorf("context: %w", err)`
- Logger: use `pkg/utils` (`utils.Info`, `utils.Error`, `utils.Success`, `utils.Step`, `utils.Warn`)

## PR Process / 提交流程

1. Fork the repository
2. Create a feature branch from `main`
3. Make changes and ensure `make check` passes
4. Open a pull request with a clear description
5. One approval required before merge

## Project Structure / 项目结构

```
cmd/spool/          # Entry point (thin wrapper)
internal/cli/       # CLI command definitions (cobra)
internal/config/    # Config loading, types, YAML parsing
internal/engine/    # Core logic: SSH, sync, DNS, bundles, services, etc.
internal/tools/     # External tool clients: n8n, TrueNAS
pkg/utils/          # Logger with timestamps and colors
pkg/sops/           # SOPS encryption wrapper
bundles/            # Bundle templates and manifests
```
