package engine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

var (
	// ErrApprovalRequired 表示危险操作缺少显式确认。
	ErrApprovalRequired = errors.New("approval required")
	// ErrLockMissing 表示 --locked 但本地没有 lock 快照。
	ErrLockMissing = errors.New("lock snapshot not found; run spool plan first")
	// ErrLockMismatch 表示当前 plan 与 lock 不一致。
	ErrLockMismatch = errors.New("lock snapshot does not match current plan; refusing to apply")
	// ErrGenerationNotFound 表示远端 generation 不存在。
	ErrGenerationNotFound = errors.New("generation not found")
)

// ManualRestoreError 表示未声明 restore.hook，只能人工恢复。
type ManualRestoreError struct {
	BackupDirs []string
}

func (e *ManualRestoreError) Error() string {
	if len(e.BackupDirs) == 0 {
		return "manual restore required: no lifecycle.restore.hook declared and no backup artifacts found"
	}
	return "manual restore required: no lifecycle.restore.hook declared; artifacts: " + strings.Join(e.BackupDirs, ", ")
}

// ApplyOptions 控制 apply 行为。
type ApplyOptions struct {
	Locked            bool
	DryRun            bool
	Yes               bool
	AllowIrreversible bool
	Inputs            map[string]string
	Secrets           map[string]string
}

// ApplyResult 描述一次 apply 的结果。
type ApplyResult struct {
	Bundle         string      `json:"bundle"`
	Host           string      `json:"host"`
	Generation     int         `json:"generation"`
	Status         string      `json:"status"`
	Diff           []DiffEntry `json:"diff,omitempty"`
	Warnings       []string    `json:"warnings"`
	RolledBack     bool        `json:"rolled_back,omitempty"`
	NeedsAttention bool        `json:"needs_attention,omitempty"`
	BackupDir      string      `json:"backup_dir,omitempty"`
	LockPath       string      `json:"lock_path,omitempty"`
	Unsupported    bool        `json:"unsupported,omitempty"`
}

// RollbackResult 描述一次 rollback 的结果。
type RollbackResult struct {
	Bundle     string   `json:"bundle"`
	Host       string   `json:"host"`
	Generation int      `json:"generation"`
	Status     string   `json:"status"`
	Warnings   []string `json:"warnings"`
}

// RestoreResult 描述 restore hook 的结果。
type RestoreResult struct {
	Bundle    string   `json:"bundle"`
	Host      string   `json:"host"`
	BackupDir string   `json:"backup_dir,omitempty"`
	Status    string   `json:"status"`
	Warnings  []string `json:"warnings"`
}

// Apply 执行单 host apply（components only）。
func (m *Manager) Apply(ctx context.Context, bundleName, host string, opts ApplyOptions) (*ApplyResult, error) {
	secrets := opts.Secrets
	if secrets == nil {
		secrets = LoadSecrets(m.BaseDir, host, bundleName)
	}

	plan, err := ResolveBundle(ctx, m.BaseDir, m.Config, bundleName, host, ResolveOptions{
		Inputs: opts.Inputs,
	})
	if err != nil {
		return nil, err
	}

	result := &ApplyResult{
		Bundle:   bundleName,
		Host:     host,
		Warnings: append([]string(nil), plan.Warnings...),
		LockPath: plan.LockPath,
	}

	if opts.Locked {
		existing, err := LoadLock(m.BaseDir, host, bundleName)
		if err != nil {
			if os.IsNotExist(err) {
				return result, ErrLockMissing
			}
			return result, fmt.Errorf("load lock: %w", err)
		}
		if !LocksEqual(existing, plan.Lock) {
			return result, ErrLockMismatch
		}
		plan.Lock = existing
		plan.Compose = []byte(existing.Rendered.Compose)
		plan.Override = []byte(existing.Rendered.Override)
		plan.LockPath = LockPath(m.BaseDir, host, bundleName)
		result.LockPath = plan.LockPath
	}

	if plan.Manifest.IsScriptManifest() {
		return m.applyScript(ctx, plan, opts, result)
	}
	if plan.Manifest.Type != "compose" {
		return result, fmt.Errorf("apply is unsupported for driver %q (bundle %s)", plan.Manifest.Type, bundleName)
	}
	if m.Runner == nil {
		return result, fmt.Errorf("apply requires a remote runner")
	}

	if opts.DryRun {
		actual, err := m.readActual(ctx, plan)
		if err != nil {
			return result, err
		}
		result.Diff = diffStates(desiredStateFromPlan(plan), *actual)
		result.Status = "dry_run"
		return result, nil
	}

	release, err := AcquireHostLock(m.BaseDir, host, m.HostLockTimeout)
	if err != nil {
		return result, err
	}
	defer release()

	// 审批和备份条件必须在任何远端写入之前完成。读取 actual 仅供 diff 使用。
	actual, err := m.readActual(ctx, plan)
	if err != nil {
		return result, err
	}
	result.Diff = diffStates(desiredStateFromPlan(plan), *actual)
	if len(result.Diff) > 0 && !opts.Yes {
		return result, fmt.Errorf("%w: plan has %d change(s); re-run with --yes to apply", ErrApprovalRequired, len(result.Diff))
	}

	irreversible := plan.IsIrreversibleEffective()
	if irreversible && !opts.AllowIrreversible {
		return result, fmt.Errorf("%w: lifecycle.upgrade.irreversible=true requires --allow-irreversible", ErrApprovalRequired)
	}

	currentGen, err := m.currentGeneration(plan.DeployPath)
	if err != nil {
		return result, err
	}
	generation := currentGen + 1
	result.Generation = generation
	result.Status = "applying"

	// 接管既有部署（没有 generation 但已有 compose 文件）同样可能含历史数据。
	hasExistingState := currentGen > 0 || actual.Deployed
	needsBackup := plan.NeedsBackupBeforeApply() && hasExistingState
	if needsBackup {
		if len(plan.BackupHooks()) == 0 {
			return result, fmt.Errorf("backup-then-recreate/irreversible upgrade requires a backup hook")
		}
	}

	if !opts.Locked {
		path, err := WriteLock(m.BaseDir, plan.Lock)
		if err != nil {
			return result, err
		}
		plan.LockPath = path
		result.LockPath = path
	} else {
		result.LockPath = plan.LockPath
	}

	if m.SyncFunc != nil {
		if err := m.SyncFunc(); err != nil {
			return result, fmt.Errorf("sync config: %w", err)
		}
	}

	backupDir := ""
	if needsBackup {
		backupDir, err = m.runBackupHooks(ctx, plan, generation, plan.BackupHooks(), secrets)
		if err != nil {
			return result, fmt.Errorf("backup hook failed: %w", err)
		}
		result.BackupDir = backupDir
	}

	if err := m.runUpgradeHooks(ctx, plan, "pre_upgrade", generation, "", secrets); err != nil {
		return result, err
	}

	runtimeOverride, err := renderRuntimeOverride(plan.Override, secrets, generation, plan.Lock.LockHash)
	if err != nil {
		return result, err
	}
	envContent := readBundleEnv(m.BaseDir, host, bundleName, plan.Manifest)

	if err := m.ensureDeployDirs(ctx, plan.DeployPath); err != nil {
		return result, err
	}
	if err := m.uploadPlanFiles(ctx, plan, runtimeOverride, envContent); err != nil {
		return result, err
	}

	meta := &GenerationMeta{
		Version:     LockVersion,
		Bundle:      bundleName,
		Host:        host,
		Generation:  generation,
		LockHash:    plan.Lock.LockHash,
		ComposeHash: hashRendered(plan.Compose, plan.Uploads, plan.Override),
		Status:      "applying",
		CreatedAt:   nowUTC(m.Now),
		BackupDir:   backupDir,
		Services:    plan.Services,
		Files:       managedFiles(plan, envContent),
	}
	if err := m.writeGenerationSnapshot(ctx, plan, generation, runtimeOverride, envContent, meta); err != nil {
		return result, err
	}

	if err := m.composeBuild(ctx, plan); err != nil {
		utils.Warn("compose build failed (continuing with prebuilt images): %v", err)
	}
	if err := m.composeUp(ctx, plan); err != nil {
		return m.handleApplyFailure(ctx, plan, result, currentGen, generation, backupDir, irreversible, fmt.Errorf("compose up failed: %w", err))
	}
	if err := m.healthGate(ctx, plan, result); err != nil {
		return m.handleApplyFailure(ctx, plan, result, currentGen, generation, backupDir, irreversible, fmt.Errorf("health gate failed: %w", err))
	}
	if err := m.reconnectConfirm(ctx); err != nil {
		return m.handleApplyFailure(ctx, plan, result, currentGen, generation, backupDir, irreversible, fmt.Errorf("reconnect confirmation failed: %w", err))
	}

	if err := m.writeCurrentGeneration(plan.DeployPath, generation); err != nil {
		return m.handleApplyFailure(ctx, plan, result, currentGen, generation, backupDir, irreversible, fmt.Errorf("write current generation: %w", err))
	}
	meta.Status = "healthy"
	if err := m.writeGenerationMeta(plan.DeployPath, generation, meta); err != nil {
		return result, err
	}
	if err := m.runUpgradeHooks(ctx, plan, "post_upgrade", generation, "", secrets); err != nil {
		return result, err
	}
	if err := m.pruneGenerations(ctx, plan.DeployPath, generation); err != nil {
		result.Warnings = append(result.Warnings, err.Error())
	}
	if err := WriteLocalState(m.BaseDir, &LocalState{
		Host:        host,
		Bundle:      bundleName,
		Generation:  generation,
		Status:      "healthy",
		LockHash:    plan.Lock.LockHash,
		ComposeHash: meta.ComposeHash,
		BackupDir:   backupDir,
		UpdatedAt:   nowUTC(m.Now),
	}); err != nil {
		result.Warnings = append(result.Warnings, "write local state: "+err.Error())
	}

	result.Status = "healthy"
	return result, nil
}

func (m *Manager) applyScript(ctx context.Context, plan *ResolvedPlan, opts ApplyOptions, result *ApplyResult) (*ApplyResult, error) {
	result.Unsupported = false
	result.Warnings = append(result.Warnings, "script driver: apply is executed without diff confirmation")
	if !opts.Yes {
		return result, fmt.Errorf("%w: script driver apply requires --yes", ErrApprovalRequired)
	}
	if m.Runner == nil {
		return result, fmt.Errorf("apply requires a remote runner")
	}
	if opts.DryRun {
		result.Status = "dry_run"
		return result, nil
	}
	release, err := AcquireHostLock(m.BaseDir, plan.Lock.Host, m.HostLockTimeout)
	if err != nil {
		return result, err
	}
	defer release()
	if m.SyncFunc != nil {
		if err := m.SyncFunc(); err != nil {
			return result, fmt.Errorf("sync config: %w", err)
		}
	}
	if err := m.ensureDeployDirs(ctx, plan.DeployPath); err != nil {
		return result, err
	}
	for _, tmpl := range plan.Manifest.Templates {
		data, err := os.ReadFile(templateFilePath(plan.BundleRoot, tmpl))
		if err != nil {
			return result, fmt.Errorf("read script template %s: %w", tmpl, err)
		}
		content := strings.ReplaceAll(string(data), "{{BASE_DIR}}", plan.DeployPath)
		remotePath := filepath.Join(plan.DeployPath, filepath.Base(tmpl))
		if err := m.Runner.Upload(content, remotePath); err != nil {
			return result, fmt.Errorf("upload %s: %w", tmpl, err)
		}
		if strings.HasSuffix(tmpl, ".sh") {
			if _, err := execRunner(ctx, m.Runner, "chmod +x "+shellQuote(remotePath)); err != nil {
				return result, err
			}
		}
	}
	if containsString(plan.Manifest.Templates, "setup.sh") {
		if _, err := execRunner(ctx, m.Runner, "cd "+shellQuote(plan.DeployPath)+" && bash setup.sh"); err != nil {
			return result, fmt.Errorf("setup.sh failed: %w", err)
		}
	}
	if plan.Manifest.Lifecycle.Health != nil {
		for _, key := range plan.Components {
			comp := plan.Lock.Resolved.Components[key]
			if comp.Health == nil {
				continue
			}
			if err := m.waitComponentHealth(ctx, plan, key, comp, nil); err != nil {
				if comp.Optional {
					result.Warnings = append(result.Warnings, fmt.Sprintf("optional component %s unhealthy: %v", key, err))
					continue
				}
				result.NeedsAttention = true
				result.Status = "needs_attention"
				return result, fmt.Errorf("health gate failed: %w", err)
			}
		}
	} else {
		result.Warnings = append(result.Warnings, "script driver: no health declared; --yes treated as manual confirmation")
	}
	result.Generation = 0
	result.Status = "succeeded"
	return result, nil
}

func (m *Manager) handleApplyFailure(ctx context.Context, plan *ResolvedPlan, result *ApplyResult, currentGen, generation int, backupDir string, irreversible bool, cause error) (*ApplyResult, error) {
	if irreversible {
		result.NeedsAttention = true
		result.Status = "needs_attention"
		_ = WriteLocalState(m.BaseDir, &LocalState{
			Host:       result.Host,
			Bundle:     result.Bundle,
			Generation: currentGen,
			Status:     "needs_attention",
			LockHash:   plan.Lock.LockHash,
			BackupDir:  backupDir,
			UpdatedAt:  nowUTC(m.Now),
		})
		message := fmt.Sprintf("%v; irreversible migration applied, automatic rollback disabled", cause)
		if backupDir != "" {
			message += "; backup at " + backupDir
		}
		message += fmt.Sprintf("; inspect with spool plan %s %s and rollback manually with spool rollback %s %s %d",
			result.Bundle, result.Host, result.Bundle, result.Host, currentGen)
		return result, errors.New(message)
	}

	if currentGen <= 0 {
		result.Status = "failed"
		_ = WriteLocalState(m.BaseDir, &LocalState{
			Host:       result.Host,
			Bundle:     result.Bundle,
			Generation: currentGen,
			Status:     "failed",
			LockHash:   plan.Lock.LockHash,
			UpdatedAt:  nowUTC(m.Now),
		})
		return result, cause
	}

	if err := m.restoreGeneration(ctx, plan, currentGen); err != nil {
		result.Status = "failed"
		result.NeedsAttention = true
		_ = WriteLocalState(m.BaseDir, &LocalState{
			Host:       result.Host,
			Bundle:     result.Bundle,
			Generation: currentGen,
			Status:     "needs_attention",
			LockHash:   plan.Lock.LockHash,
			UpdatedAt:  nowUTC(m.Now),
		})
		return result, fmt.Errorf("%v; automatic rollback to generation %d failed: %v", cause, currentGen, err)
	}
	_ = m.removeGeneration(ctx, plan.DeployPath, generation)
	_ = m.pruneGenerations(ctx, plan.DeployPath, currentGen)
	_ = m.writeCurrentGeneration(plan.DeployPath, currentGen)
	_ = m.syncLocalLock(plan, currentGen)
	_ = WriteLocalState(m.BaseDir, &LocalState{
		Host:       result.Host,
		Bundle:     result.Bundle,
		Generation: currentGen,
		Status:     "rolled_back",
		LockHash:   plan.Lock.LockHash,
		UpdatedAt:  nowUTC(m.Now),
	})
	result.RolledBack = true
	result.Status = "rolled_back"
	return result, fmt.Errorf("%v; rolled back to generation %d", cause, currentGen)
}

// Rollback 按远端 generation 快照恢复 compose/env 并健康检查。
func (m *Manager) Rollback(ctx context.Context, bundleName, host string, generation int) (*RollbackResult, error) {
	if m.Runner == nil {
		return nil, fmt.Errorf("rollback requires a remote runner")
	}
	plan, err := ResolveBundle(ctx, m.BaseDir, m.Config, bundleName, host, ResolveOptions{})
	if err != nil {
		return nil, err
	}
	release, err := AcquireHostLock(m.BaseDir, host, m.HostLockTimeout)
	if err != nil {
		return nil, err
	}
	defer release()

	current, err := m.currentGeneration(plan.DeployPath)
	if err != nil {
		return nil, err
	}
	target := generation
	if target <= 0 {
		target = current - 1
	}
	if target < 1 {
		return nil, fmt.Errorf("%w: no previous generation (current=%d)", ErrGenerationNotFound, current)
	}
	if err := m.restoreGeneration(ctx, plan, target); err != nil {
		return nil, err
	}
	if err := m.writeCurrentGeneration(plan.DeployPath, target); err != nil {
		return nil, err
	}
	_ = m.syncLocalLock(plan, target)
	if meta, err := m.readGenerationMeta(plan.DeployPath, target); err == nil {
		meta.Status = "rolled_back"
		_ = m.writeGenerationMeta(plan.DeployPath, target, meta)
	}
	_ = m.pruneGenerations(ctx, plan.DeployPath, target)
	if err := WriteLocalState(m.BaseDir, &LocalState{
		Host:       host,
		Bundle:     bundleName,
		Generation: target,
		Status:     "rolled_back",
		UpdatedAt:  nowUTC(m.Now),
	}); err != nil {
		return nil, err
	}
	return &RollbackResult{Bundle: bundleName, Host: host, Generation: target, Status: "rolled_back"}, nil
}

func (m *Manager) restoreGeneration(ctx context.Context, plan *ResolvedPlan, generation int) error {
	genDir := GenerationDir(plan.DeployPath, generation)
	compose, err := m.Runner.ReadFile(filepath.Join(genDir, "docker-compose.yaml"))
	if err != nil {
		return fmt.Errorf("%w: %d", ErrGenerationNotFound, generation)
	}
	override, err := m.Runner.ReadFile(filepath.Join(genDir, "docker-compose.spool.yaml"))
	if err != nil {
		return fmt.Errorf("%w: generation %d has no override", ErrGenerationNotFound, generation)
	}
	env, envErr := m.Runner.ReadFile(filepath.Join(genDir, ".env"))
	if envErr != nil {
		env = ""
	}

	// 恢复健康/生命周期契约必须使用目标 generation 自己保存的锁定快照，
	// 而不是当前（可能已变更）的 bundle 定义。
	restorePlan := plan
	restoreManifestName := plan.Manifest.Name
	restoreHost := plan.Lock.Host
	if lockData, err := m.Runner.ReadFile(filepath.Join(genDir, "lock.yaml")); err == nil {
		var lock LockSnapshot
		if err := yaml.Unmarshal([]byte(lockData), &lock); err == nil {
			keys := make([]string, 0, len(lock.Resolved.Components))
			for key := range lock.Resolved.Components {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			restorePlan = &ResolvedPlan{
				Manifest:   plan.Manifest,
				BundleRoot: plan.BundleRoot,
				DeployPath: plan.DeployPath,
				Components: keys,
				Lock:       &lock,
			}
			restoreHost = lock.Host
		}
	}
	if err := m.ensureDeployDirs(ctx, plan.DeployPath); err != nil {
		return err
	}
	if err := m.Runner.Upload(compose, filepath.Join(plan.DeployPath, "docker-compose.yaml")); err != nil {
		return err
	}
	overridePath := filepath.Join(plan.DeployPath, "docker-compose.spool.yaml")
	if err := m.Runner.Upload(override, overridePath); err != nil {
		return err
	}
	if _, err := execRunner(ctx, m.Runner, "chmod 600 "+shellQuote(overridePath)); err != nil {
		return err
	}
	if env != "" {
		envPath := filepath.Join(plan.DeployPath, ".env")
		if err := m.Runner.Upload(env, envPath); err != nil {
			return err
		}
		if _, err := execRunner(ctx, m.Runner, "chmod 600 "+shellQuote(envPath)); err != nil {
			return err
		}
	}
	// 目标 generation 不存在的受管理文件必须删除，避免新版 .env/模板残留。
	if meta, err := m.readGenerationMeta(plan.DeployPath, generation); err == nil {
		targetFiles := map[string]bool{}
		for _, file := range meta.Files {
			targetFiles[filepath.ToSlash(file)] = true
		}
		if len(targetFiles) == 0 {
			// 兼容旧快照：目录里实际存在的文件即为目标文件集合。
			if raw, err := execRunner(ctx, m.Runner, "cd "+shellQuote(genDir)+" && find files -type f 2>/dev/null; test -f .env && echo .env || true"); err == nil {
				for _, line := range strings.Split(raw, "\n") {
					line = strings.TrimSpace(line)
					if line == "" {
						continue
					}
					targetFiles[strings.TrimPrefix(line, "files/")] = true
				}
			}
			targetFiles["docker-compose.yaml"] = true
			targetFiles["docker-compose.spool.yaml"] = true
		}
		// 当前 plan 与当前 generation 记录的文件都可能是残留；取并集清理。
		currentSet := map[string]bool{}
		for _, file := range managedFiles(plan, "") {
			currentSet[filepath.ToSlash(file)] = true
		}
		if currentGen, err := m.currentGeneration(plan.DeployPath); err == nil && currentGen > 0 {
			if currentMeta, err := m.readGenerationMeta(plan.DeployPath, currentGen); err == nil {
				for _, file := range currentMeta.Files {
					currentSet[filepath.ToSlash(file)] = true
				}
			}
		}
		currentFiles := make([]string, 0, len(currentSet))
		for file := range currentSet {
			currentFiles = append(currentFiles, file)
		}
		sort.Strings(currentFiles)
		for _, file := range currentFiles {
			if targetFiles[filepath.ToSlash(file)] {
				continue
			}
			if _, err := execRunner(ctx, m.Runner, "rm -rf "+shellQuote(filepath.Join(plan.DeployPath, filepath.FromSlash(file)))); err != nil {
				return err
			}
		}
		if env == "" && !targetFiles[".env"] {
			if _, err := execRunner(ctx, m.Runner, "rm -rf "+shellQuote(filepath.Join(plan.DeployPath, ".env"))); err != nil {
				return err
			}
		}
	}
	// 恢复同一 generation 的组件模板（若快照包含）。
	if _, err := execRunner(ctx, m.Runner, fmt.Sprintf("cp -a %s/. %s/ 2>/dev/null || true",
		shellQuote(filepath.Join(genDir, "files")), shellQuote(plan.DeployPath))); err != nil {
		return err
	}
	if err := m.composeUp(ctx, restorePlan); err != nil {
		return fmt.Errorf("rollback compose up failed: %w", err)
	}
	result := &ApplyResult{Bundle: restoreManifestName, Host: restoreHost, Warnings: []string{}}
	if err := m.healthGate(ctx, restorePlan, result); err != nil {
		return fmt.Errorf("rollback health gate failed: %w", err)
	}
	return nil
}

// managedFiles 返回 deploy_path 下由 spool 管理的文件（相对路径）。
func managedFiles(plan *ResolvedPlan, envContent string) []string {
	if plan == nil {
		return nil
	}
	files := []string{"docker-compose.yaml", "docker-compose.spool.yaml"}
	if envContent != "" {
		files = append(files, ".env")
	}
	for path := range plan.Uploads {
		files = append(files, filepath.ToSlash(path))
	}
	sort.Strings(files)
	return files
}

// Restore 执行显式 restore hook；未声明时明确走人工流程。
func (m *Manager) Restore(ctx context.Context, bundleName, host, ref string) (*RestoreResult, error) {
	plan, err := ResolveBundle(ctx, m.BaseDir, m.Config, bundleName, host, ResolveOptions{})
	if err != nil {
		return nil, err
	}
	result := &RestoreResult{Bundle: bundleName, Host: host, BackupDir: ref, Warnings: []string{}}
	if len(plan.RestoreHooks()) == 0 {
		dirs := m.listBackupDirs(ctx, plan.DeployPath)
		result.Warnings = append(result.Warnings, "no lifecycle.restore.hook; manual restore required")
		return result, &ManualRestoreError{BackupDirs: dirs}
	}
	if m.Runner == nil {
		return nil, fmt.Errorf("restore requires a remote runner")
	}
	release, err := AcquireHostLock(m.BaseDir, host, m.HostLockTimeout)
	if err != nil {
		return nil, err
	}
	defer release()
	if ref == "" {
		dirs := m.listBackupDirs(ctx, plan.DeployPath)
		if len(dirs) == 0 {
			return nil, fmt.Errorf("no backup artifacts found under %s", filepath.Join(plan.DeployPath, "backups"))
		}
		ref = filepath.Join(plan.DeployPath, "backups", dirs[len(dirs)-1])
		result.BackupDir = ref
	}
	secrets := LoadSecrets(m.BaseDir, host, bundleName)
	if err := m.runRestoreHooks(ctx, plan, ref, secrets); err != nil {
		return result, err
	}
	if err := m.healthGate(ctx, plan, &ApplyResult{Bundle: bundleName, Host: host}); err != nil {
		return result, fmt.Errorf("restore health gate failed: %w", err)
	}
	result.Status = "restored"
	_ = WriteLocalState(m.BaseDir, &LocalState{
		Host:      host,
		Bundle:    bundleName,
		Status:    "restored",
		BackupDir: ref,
		UpdatedAt: nowUTC(m.Now),
	})
	return result, nil
}

func desiredStateFromPlan(plan *ResolvedPlan) DesiredState {
	return DesiredState{
		Components:   append([]string(nil), plan.Components...),
		Dependencies: sortedKeys(plan.Lock.Resolved.Dependencies),
		Services:     plan.Services,
		LockHash:     plan.Lock.LockHash,
		ComposeHash:  plan.Lock.Rendered.ComposeSHA256,
		DeployPath:   plan.DeployPath,
	}
}

func (m *Manager) ensureDeployDirs(ctx context.Context, deployPath string) error {
	dirs := []string{
		deployPath,
		filepath.Join(deployPath, ".spool-gen"),
		filepath.Join(deployPath, ".spool-hooks"),
		filepath.Join(deployPath, "backups"),
		filepath.Join(deployPath, ".spool", "components"),
	}
	for _, dir := range dirs {
		if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(dir)); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}
	return nil
}

func (m *Manager) uploadPlanFiles(ctx context.Context, plan *ResolvedPlan, override, envContent string) error {
	if err := m.Runner.Upload(string(plan.Compose), filepath.Join(plan.DeployPath, "docker-compose.yaml")); err != nil {
		return err
	}
	overridePath := filepath.Join(plan.DeployPath, "docker-compose.spool.yaml")
	if err := m.Runner.Upload(override, overridePath); err != nil {
		return err
	}
	if _, err := execRunner(ctx, m.Runner, "chmod 600 "+shellQuote(overridePath)); err != nil {
		return err
	}
	if envContent != "" {
		envPath := filepath.Join(plan.DeployPath, ".env")
		if err := m.Runner.Upload(envContent, envPath); err != nil {
			return err
		}
		if _, err := execRunner(ctx, m.Runner, "chmod 600 "+shellQuote(envPath)); err != nil {
			return err
		}
	}
	paths := make([]string, 0, len(plan.Uploads))
	for path := range plan.Uploads {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		remotePath := filepath.Join(plan.DeployPath, filepath.FromSlash(path))
		if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(filepath.Dir(remotePath))); err != nil {
			return err
		}
		if err := m.Runner.Upload(string(plan.Uploads[path]), remotePath); err != nil {
			return fmt.Errorf("upload %s: %w", path, err)
		}
	}
	return nil
}

func (m *Manager) writeGenerationSnapshot(ctx context.Context, plan *ResolvedPlan, generation int, override, envContent string, meta *GenerationMeta) error {
	genDir := GenerationDir(plan.DeployPath, generation)
	if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(genDir)); err != nil {
		return err
	}
	digest := digestFile(plan.Services)
	files := map[string]string{
		"docker-compose.yaml":       string(plan.Compose),
		"docker-compose.spool.yaml": override,
		"digest":                    digest,
	}
	if envContent != "" {
		files[".env"] = envContent
	}
	for path, content := range plan.Uploads {
		files[filepath.Join("files", filepath.FromSlash(path))] = string(content)
	}
	metaData, err := yaml.Marshal(meta)
	if err != nil {
		return err
	}
	files["meta.yaml"] = string(metaData)
	if lockData, err := yaml.Marshal(plan.Lock); err == nil {
		files["lock.yaml"] = string(lockData)
	}
	for name, content := range files {
		target := filepath.Join(genDir, name)
		if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(filepath.Dir(target))); err != nil {
			return err
		}
		if err := m.Runner.Upload(content, target); err != nil {
			return fmt.Errorf("snapshot %s: %w", name, err)
		}
		switch name {
		case ".env", "docker-compose.spool.yaml", "lock.yaml":
			if _, err := execRunner(ctx, m.Runner, "chmod 600 "+shellQuote(target)); err != nil {
				return err
			}
		}
	}
	return nil
}

func digestFile(services []ServiceSpec) string {
	lines := make([]string, 0, len(services))
	for _, svc := range services {
		lines = append(lines, fmt.Sprintf("%s %s", svc.Name, svc.Image))
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n") + "\n"
}

func (m *Manager) writeGenerationMeta(deployPath string, generation int, meta *GenerationMeta) error {
	data, err := yaml.Marshal(meta)
	if err != nil {
		return err
	}
	return m.Runner.Upload(string(data), filepath.Join(GenerationDir(deployPath, generation), "meta.yaml"))
}

func (m *Manager) syncLocalLock(plan *ResolvedPlan, generation int) error {
	data, err := m.Runner.ReadFile(filepath.Join(GenerationDir(plan.DeployPath, generation), "lock.yaml"))
	if err != nil {
		return err
	}
	var lock LockSnapshot
	if err := yaml.Unmarshal([]byte(data), &lock); err != nil {
		return err
	}
	_, err = WriteLock(m.BaseDir, &lock)
	return err
}

func (m *Manager) readGenerationMeta(deployPath string, generation int) (*GenerationMeta, error) {
	data, err := m.Runner.ReadFile(filepath.Join(GenerationDir(deployPath, generation), "meta.yaml"))
	if err != nil {
		return nil, err
	}
	return ParseGenerationMeta([]byte(data))
}

func (m *Manager) currentGeneration(deployPath string) (int, error) {
	raw, err := m.Runner.ReadFile(RemoteGenerationCurrentPath(deployPath))
	if err != nil {
		return 0, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid current generation %q", strings.TrimSpace(raw))
	}
	return value, nil
}

func (m *Manager) writeCurrentGeneration(deployPath string, generation int) error {
	return m.Runner.Upload(strconv.Itoa(generation)+"\n", RemoteGenerationCurrentPath(deployPath))
}

func (m *Manager) removeGeneration(ctx context.Context, deployPath string, generation int) error {
	_, err := execRunner(ctx, m.Runner, "rm -rf "+shellQuote(GenerationDir(deployPath, generation)))
	return err
}

func (m *Manager) pruneGenerations(ctx context.Context, deployPath string, current int) error {
	out, err := execRunner(ctx, m.Runner, "ls -1 "+shellQuote(filepath.Join(deployPath, ".spool-gen"))+" 2>/dev/null || true")
	if err != nil {
		return err
	}
	keep := map[int]bool{}
	if current > 0 {
		keep[current] = true
		if current > 1 {
			keep[current-1] = true
		}
	}
	for _, line := range strings.Split(out, "\n") {
		gen, ok := generationNumber(line)
		if !ok {
			continue
		}
		if keep[gen] {
			continue
		}
		if err := m.removeGeneration(ctx, deployPath, gen); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) composeBuild(ctx context.Context, plan *ResolvedPlan) error {
	files, err := m.remoteComposeFilesContext(ctx, plan.DeployPath)
	if err != nil {
		return err
	}
	_, err = execRunner(ctx, m.Runner, composeCommand(plan.DeployPath, files, "build"))
	return err
}

func (m *Manager) composeUp(ctx context.Context, plan *ResolvedPlan) error {
	files, err := m.remoteComposeFilesContext(ctx, plan.DeployPath)
	if err != nil {
		return err
	}
	_, err = execRunner(ctx, m.Runner, composeCommand(plan.DeployPath, files, "up -d --remove-orphans"))
	return err
}

func (m *Manager) reconnectConfirm(ctx context.Context) error {
	if m.Runner == nil {
		return fmt.Errorf("remote runner is nil")
	}
	if reconnectable, ok := m.Runner.(Reconnectable); ok {
		if err := reconnectable.Reconnect(); err != nil {
			return err
		}
	}
	_, err := execRunner(ctx, m.Runner, "true")
	return err
}

func (m *Manager) healthGate(ctx context.Context, plan *ResolvedPlan, result *ApplyResult) error {
	files, err := m.remoteComposeFilesContext(ctx, plan.DeployPath)
	if err != nil {
		return err
	}
	for _, key := range plan.Components {
		comp := plan.Lock.Resolved.Components[key]
		if len(comp.Services) == 0 {
			continue
		}
		var checkErr error
		if comp.Health != nil {
			checkErr = m.waitComponentHealth(ctx, plan, key, comp, files)
		} else {
			checkErr = m.checkDefaultHealth(ctx, comp, files)
		}
		if checkErr == nil {
			continue
		}
		if comp.Optional {
			result.Warnings = append(result.Warnings, fmt.Sprintf("optional component %s unhealthy: %v", key, checkErr))
			continue
		}
		return fmt.Errorf("component %s: %w", key, checkErr)
	}
	return nil
}

func (m *Manager) checkDefaultHealth(ctx context.Context, comp ResolvedComponent, files []string) error {
	running, err := m.runningServicesFromFiles(ctx, comp, files)
	if err != nil {
		return err
	}
	for _, svc := range comp.Services {
		if !containsString(running, svc) {
			return fmt.Errorf("service %s is not running", svc)
		}
	}
	return nil
}

func (m *Manager) runningServicesFromFiles(ctx context.Context, comp ResolvedComponent, files []string) ([]string, error) {
	deployPath := ""
	if len(files) > 0 {
		deployPath = filepath.Dir(files[0])
	}
	out, err := execRunner(ctx, m.Runner, composeCommand(deployPath, files, "ps --status running --services"))
	if err != nil {
		return nil, err
	}
	var running []string
	for _, line := range strings.Split(out, "\n") {
		if value := strings.TrimSpace(line); value != "" {
			running = append(running, value)
		}
	}
	return running, nil
}

func (m *Manager) waitComponentHealth(ctx context.Context, plan *ResolvedPlan, key string, comp ResolvedComponent, files []string) error {
	timeout := config.ParseDuration(comp.Health.Timeout, 60*time.Second)
	deadline := time.Now().Add(timeout)
	for {
		var attemptCtx context.Context
		var cancel context.CancelFunc
		if timeout > 0 {
			attemptCtx, cancel = context.WithTimeout(ctx, time.Until(deadline))
		} else {
			attemptCtx, cancel = context.WithCancel(ctx)
		}
		err := m.runHealthCheck(attemptCtx, comp, files)
		cancel()
		if err == nil {
			return nil
		}
		if timeout <= 0 || time.Now().After(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

func (m *Manager) runHealthCheck(ctx context.Context, comp ResolvedComponent, files []string) error {
	health := comp.Health
	from := health.From
	if from == "" {
		from = "container"
	}
	deployPath := ""
	if len(files) > 0 {
		deployPath = filepath.Dir(files[0])
	}
	switch from {
	case "host":
		switch {
		case health.HTTP != "":
			cmd := fmt.Sprintf("curl -fsS --max-time 5 %s >/dev/null 2>&1 || wget -q -O /dev/null %s", shellQuote(health.HTTP), shellQuote(health.HTTP))
			_, err := execRunner(ctx, m.Runner, cmd)
			return err
		case health.TCP != "":
			host, port, err := net.SplitHostPort(health.TCP)
			if err != nil {
				return fmt.Errorf("invalid tcp health target %q: %w", health.TCP, err)
			}
			_, err = execRunner(ctx, m.Runner, fmt.Sprintf("nc -z %s %s", shellQuote(host), shellQuote(port)))
			return err
		case len(health.Command) > 0:
			_, err := execRunner(ctx, m.Runner, joinQuoted(health.Command))
			return err
		default:
			return fmt.Errorf("health check has no http/tcp/command")
		}
	case "container":
		service := health.ExecIn
		if service == "" {
			service = comp.ExecIn
		}
		if service == "" && len(comp.Services) > 0 {
			service = comp.Services[0]
		}
		if service == "" {
			return fmt.Errorf("container health check requires exec_in or a service")
		}
		switch {
		case health.HTTP != "":
			inner := fmt.Sprintf("curl -fsS --max-time 5 %s >/dev/null 2>&1 || wget -q -O /dev/null %s", shellQuote(health.HTTP), shellQuote(health.HTTP))
			_, err := execRunner(ctx, m.Runner, composeCommand(deployPath, files, fmt.Sprintf("exec -T %s sh -c %s", shellQuote(service), shellQuote(inner))))
			return err
		case health.TCP != "":
			host, port, err := net.SplitHostPort(health.TCP)
			if err != nil {
				return fmt.Errorf("invalid tcp health target %q: %w", health.TCP, err)
			}
			inner := fmt.Sprintf("nc -z %s %s", shellQuote(host), shellQuote(port))
			_, err = execRunner(ctx, m.Runner, composeCommand(deployPath, files, fmt.Sprintf("exec -T %s sh -c %s", shellQuote(service), shellQuote(inner))))
			return err
		case len(health.Command) > 0:
			_, err := execRunner(ctx, m.Runner, composeCommand(deployPath, files, "exec -T "+shellQuote(service)+" "+joinQuoted(health.Command)))
			return err
		default:
			return fmt.Errorf("health check has no http/tcp/command")
		}
	default:
		return fmt.Errorf("unknown health from context %q", from)
	}
}

func joinQuoted(values []string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, shellQuote(value))
	}
	return strings.Join(parts, " ")
}

func (m *Manager) runBackupHooks(ctx context.Context, plan *ResolvedPlan, generation int, specs []HookSpec, secrets map[string]string) (string, error) {
	backupDir := filepath.Join(plan.DeployPath, "backups", fmt.Sprintf("gen-%d-%s", generation, time.Now().UTC().Format("20060102T150405Z")))
	if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(backupDir)); err != nil {
		return "", err
	}
	type backupEntry struct {
		Scope  string              `yaml:"scope"`
		Dir    string              `yaml:"dir"`
		Hook   string              `yaml:"hook,omitempty"`
		Assets []BundleBackupAsset `yaml:"assets,omitempty"`
	}
	entries := make([]backupEntry, 0, len(specs))
	manifestCreated := false
	for _, spec := range specs {
		scopeDir := filepath.Join(backupDir, sanitizeHookScope(spec.Scope))
		if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(scopeDir)); err != nil {
			return "", err
		}
		if !manifestCreated {
			// 先占位，避免备份 hook 因目录不存在失败；内容在所有 scope 完成后写入。
			if err := m.Runner.Upload("", filepath.Join(backupDir, "manifest.yaml")); err != nil {
				return "", err
			}
			manifestCreated = true
		}
		if strings.TrimSpace(spec.Path) != "" {
			if err := m.runHookFile(ctx, plan.DeployPath, spec, generation, scopeDir, "", "backup", secrets); err != nil {
				return "", err
			}
		}
		for _, asset := range spec.Assets {
			if err := m.backupAsset(ctx, plan, scopeDir, asset); err != nil {
				return "", err
			}
		}
		entries = append(entries, backupEntry{
			Scope:  spec.Scope,
			Dir:    sanitizeHookScope(spec.Scope),
			Hook:   spec.Path,
			Assets: spec.Assets,
		})
	}
	manifest := struct {
		Bundle     string        `yaml:"bundle"`
		Generation int           `yaml:"generation"`
		Scopes     []backupEntry `yaml:"scopes"`
	}{Bundle: plan.Manifest.Name, Generation: generation, Scopes: entries}
	if data, err := yaml.Marshal(manifest); err == nil {
		if err := m.Runner.Upload(string(data), filepath.Join(backupDir, "manifest.yaml")); err != nil {
			return "", err
		}
	}
	return backupDir, nil
}

func (m *Manager) backupAsset(ctx context.Context, plan *ResolvedPlan, backupDir string, asset BundleBackupAsset) error {
	name := filepath.Base(asset.Source)
	switch asset.Type {
	case "volume":
		cmd := fmt.Sprintf("docker run --rm -v %s:/data:ro -v %s:/backup alpine tar czf /backup/%s.tar.gz -C /data .",
			shellQuote(asset.Source), shellQuote(backupDir), name)
		_, err := execRunner(ctx, m.Runner, cmd)
		return err
	case "dir":
		parent := filepath.Dir(asset.Source)
		cmd := fmt.Sprintf("tar czf %s -C %s %s",
			shellQuote(filepath.Join(backupDir, name+".tar.gz")), shellQuote(parent), shellQuote(name))
		_, err := execRunner(ctx, m.Runner, cmd)
		return err
	default:
		return fmt.Errorf("unknown backup asset type %q", asset.Type)
	}
}

func (m *Manager) runUpgradeHooks(ctx context.Context, plan *ResolvedPlan, phase string, generation int, backupDir string, secrets map[string]string) error {
	for _, spec := range plan.UpgradeHooks(phase) {
		if err := m.runHookFile(ctx, plan.DeployPath, spec, generation, backupDir, "", phase, secrets); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) runRestoreHooks(ctx context.Context, plan *ResolvedPlan, ref string, secrets map[string]string) error {
	current, _ := m.currentGeneration(plan.DeployPath)
	for _, spec := range plan.RestoreHooks() {
		// 备份时所有 scope 都写入 <backupRef>/<scope>，恢复必须使用同一映射。
		specRef := filepath.Join(ref, sanitizeHookScope(spec.Scope))
		if _, err := execRunner(ctx, m.Runner, "test -d "+shellQuote(specRef)); err != nil {
			// 兼容旧备份：bundle scope 可能直接写在 backupRef 根目录。
			if spec.Scope == "bundle" {
				specRef = ref
			}
		}
		if err := m.runHookFile(ctx, plan.DeployPath, spec, current, "", specRef, "restore", secrets); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) runHookFile(ctx context.Context, deployPath string, spec HookSpec, generation int, backupDir, restoreRef, name string, secrets map[string]string) error {
	if strings.TrimSpace(spec.Path) == "" {
		return nil
	}
	localPath := spec.Path
	if !filepath.IsAbs(localPath) {
		localPath = filepath.Join(spec.Root, filepath.FromSlash(localPath))
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return fmt.Errorf("%s hook %s: %w", name, spec.Path, err)
	}
	remotePath := filepath.Join(deployPath, ".spool-hooks", sanitizeHookScope(spec.Scope)+"-"+filepath.Base(spec.Path))
	if _, err := execRunner(ctx, m.Runner, "mkdir -p "+shellQuote(filepath.Dir(remotePath))); err != nil {
		return err
	}
	if err := m.Runner.Upload(string(data), remotePath); err != nil {
		return err
	}
	if _, err := execRunner(ctx, m.Runner, "chmod +x "+shellQuote(remotePath)); err != nil {
		return err
	}

	envParts := []string{
		"SPOOL_GENERATION=" + shellQuote(strconv.Itoa(generation)),
		"SPOOL_SCOPE=" + shellQuote(spec.Scope),
	}
	if backupDir != "" {
		envParts = append(envParts, "SPOOL_BACKUP_DIR="+shellQuote(backupDir))
	}
	if restoreRef != "" {
		envParts = append(envParts, "SPOOL_RESTORE_REF="+shellQuote(restoreRef))
		envParts = append(envParts, "SPOOL_BACKUP_DIR="+shellQuote(restoreRef))
	}
	for _, key := range sortedKeys(spec.Env) {
		value, err := renderHookValue(spec.Env[key], secrets)
		if err != nil {
			return fmt.Errorf("%s hook env %s: %w", name, key, err)
		}
		envParts = append(envParts, key+"="+shellQuote(value))
	}
	cmd := fmt.Sprintf("cd %s && %s bash %s", shellQuote(deployPath), strings.Join(envParts, " "), shellQuote(remotePath))
	_, err = execRunner(ctx, m.Runner, cmd)
	return err
}

func renderHookValue(value string, secrets map[string]string) (string, error) {
	matches := secretPlaceholderPattern.FindAllStringSubmatch(value, -1)
	result := value
	for _, match := range matches {
		secretValue, ok := secrets[match[1]]
		if !ok {
			return "", fmt.Errorf("secret %q is not available for hook", match[1])
		}
		result = strings.ReplaceAll(result, match[0], secretValue)
	}
	return result, nil
}

func sanitizeHookScope(scope string) string {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return "bundle"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", " ", "-", ":", "-")
	return replacer.Replace(scope)
}

func (m *Manager) listBackupDirs(ctx context.Context, deployPath string) []string {
	if m.Runner == nil {
		return nil
	}
	out, err := m.Runner.Exec("ls -1 " + shellQuote(filepath.Join(deployPath, "backups")) + " 2>/dev/null || true")
	if err != nil {
		return nil
	}
	var dirs []string
	for _, line := range strings.Split(out, "\n") {
		if value := strings.TrimSpace(line); value != "" {
			dirs = append(dirs, value)
		}
	}
	sort.Strings(dirs)
	return dirs
}

var secretPlaceholderPattern = regexp.MustCompile(`secret://([A-Za-z0-9_.-]+)`)

func renderRuntimeOverride(override []byte, secrets map[string]string, generation int, lockHash string) (string, error) {
	if len(override) == 0 {
		return "", nil
	}
	var doc map[string]interface{}
	if err := yaml.Unmarshal(override, &doc); err != nil {
		return "", err
	}
	services, _ := doc["services"].(map[string]interface{})
	for _, raw := range services {
		entry, _ := raw.(map[string]interface{})
		labels, _ := entry["labels"].(map[string]interface{})
		if labels == nil {
			labels = map[string]interface{}{}
			entry["labels"] = labels
		}
		labels["io.silkspool.generation"] = strconv.Itoa(generation)
		if lockHash != "" {
			labels["io.silkspool.lock-hash"] = lockHash
		}
	}
	replaced, err := replaceSecretsInValue(doc, secrets)
	if err != nil {
		return "", err
	}
	data, err := yaml.Marshal(replaced)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func replaceSecretsInValue(value interface{}, secrets map[string]string) (interface{}, error) {
	switch typed := value.(type) {
	case string:
		matches := secretPlaceholderPattern.FindAllStringSubmatch(typed, -1)
		result := typed
		for _, match := range matches {
			secretValue, ok := secrets[match[1]]
			if !ok {
				return nil, fmt.Errorf("secret %q is not available for apply", match[1])
			}
			result = strings.ReplaceAll(result, match[0], secretValue)
		}
		// override 中写入的是最终字面值；Compose 会对 $ 再做一次插值，
		// 因此必须转义，避免凭据被截断或意外展开。
		result = strings.ReplaceAll(result, "$", "$$")
		return result, nil
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			replaced, err := replaceSecretsInValue(item, secrets)
			if err != nil {
				return nil, err
			}
			out[key] = replaced
		}
		return out, nil
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, item := range typed {
			replaced, err := replaceSecretsInValue(item, secrets)
			if err != nil {
				return nil, err
			}
			out[i] = replaced
		}
		return out, nil
	default:
		return value, nil
	}
}

// LoadSecrets 读取 hosts/<host>/.env 与 hosts/<host>/<bundle>/.env。
// 后者覆盖前者；小写别名在合并完成后统一重建，避免 bundle 覆盖后仍读到主机旧值。
func LoadSecrets(baseDir, host, bundle string) map[string]string {
	merged := map[string]string{}
	paths := []string{
		filepath.Join(baseDir, "hosts", host, ".env"),
		filepath.Join(baseDir, "hosts", host, bundle, ".env"),
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for key, value := range parseEnv(string(data)) {
			merged[key] = value
		}
	}
	secrets := make(map[string]string, len(merged)*2)
	for key, value := range merged {
		secrets[key] = value
	}
	for key, value := range merged {
		lower := strings.ToLower(key)
		if _, exists := merged[lower]; !exists {
			secrets[lower] = value
		}
	}
	return secrets
}

func readBundleEnv(baseDir, host, bundle string, manifest *BundleManifest) string {
	paths := []string{}
	if manifest != nil {
		paths = append(paths, filepath.Join(BundleConfigDir(baseDir, host, bundle, manifest), ".env"))
	}
	paths = append(paths, filepath.Join(baseDir, "hosts", host, bundle, ".env"), filepath.Join(baseDir, "hosts", host, ".env"))
	for _, path := range paths {
		if data, err := os.ReadFile(path); err == nil {
			return string(data)
		}
	}
	return ""
}

func parseEnv(content string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		// dotenv 语法中的成对引号只是引用符，不属于凭据值。
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				quote := value[0]
				value = value[1 : len(value)-1]
				if quote == '"' {
					value = strings.ReplaceAll(value, `\"`, `"`)
					value = strings.ReplaceAll(value, `\\`, `\`)
				}
			}
		}
		values[key] = value
	}
	return values
}
