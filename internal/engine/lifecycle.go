package engine

import (
	"fmt"
	"sort"
	"strings"
)

// HookSpec 是 apply/backup/restore 时需要执行的单个 hook。
type HookSpec struct {
	Scope  string
	Root   string
	Path   string
	Env    map[string]string
	Assets []BundleBackupAsset
}

func validateUpgradeStrategy(scope string, upgrade BundleUpgrade) error {
	switch upgrade.Strategy {
	case "", "recreate", "rolling", "backup-then-recreate":
		return nil
	default:
		return fmt.Errorf("%s: unsupported upgrade strategy %q", scope, upgrade.Strategy)
	}
}

func validateEffectiveLifecycle(plan *ResolvedPlan) error {
	if plan == nil || plan.Manifest == nil {
		return nil
	}
	bundleBackup := strings.TrimSpace(plan.Manifest.Backup.Hook) != "" || len(plan.Manifest.Backup.Assets) > 0
	hasAnyBackup := bundleBackup
	for key, lifecycle := range plan.Lifecycles {
		if err := validateUpgradeStrategy("component "+key, lifecycle.Upgrade); err != nil {
			return err
		}
		if strings.TrimSpace(lifecycle.Backup.Hook) != "" || len(lifecycle.Backup.Assets) > 0 {
			hasAnyBackup = true
		}
	}

	// bundle 自身的不可逆迁移必须由 bundle 自身的备份 hook 覆盖。
	if plan.Manifest.Lifecycle.Upgrade.Irreversible && !bundleBackup {
		return fmt.Errorf("bundle %s: irreversible upgrade requires spec.backup.hook (bundle scope)", plan.Manifest.Name)
	}
	// 组件的不可逆迁移必须由该组件自己的备份 hook 覆盖；无关组件的备份不能替代。
	for key, lifecycle := range plan.Lifecycles {
		if !lifecycle.Upgrade.Irreversible {
			continue
		}
		if strings.TrimSpace(lifecycle.Backup.Hook) == "" && len(lifecycle.Backup.Assets) == 0 {
			return fmt.Errorf("bundle %s: component %s has irreversible upgrade but missing spec.backup.hook (component scope)", plan.Manifest.Name, key)
		}
	}
	if plan.NeedsBackupBeforeApply() && !hasAnyBackup {
		return fmt.Errorf("bundle %s: irreversible/backup-then-recreate upgrade requires spec.backup.hook (bundle or component)", plan.Manifest.Name)
	}
	return nil
}

// IsIrreversibleEffective 返回 bundle 或任一组件是否声明不可逆迁移。
func (p *ResolvedPlan) IsIrreversibleEffective() bool {
	if p == nil {
		return false
	}
	if p.Manifest != nil && p.Manifest.Lifecycle.Upgrade.Irreversible {
		return true
	}
	for _, lifecycle := range p.Lifecycles {
		if lifecycle.Upgrade.Irreversible {
			return true
		}
	}
	return false
}

// NeedsBackupBeforeApply 返回是否需要在 apply 前执行一致性备份。
func (p *ResolvedPlan) NeedsBackupBeforeApply() bool {
	if p == nil {
		return false
	}
	if p.IsIrreversibleEffective() {
		return true
	}
	if p.Manifest != nil && p.Manifest.Lifecycle.Upgrade.Strategy == "backup-then-recreate" {
		return true
	}
	for _, lifecycle := range p.Lifecycles {
		if lifecycle.Upgrade.Strategy == "backup-then-recreate" {
			return true
		}
	}
	return false
}

// BackupHooks 返回 bundle 级与组件级的备份 hook（按确定性顺序）。
func (p *ResolvedPlan) BackupHooks() []HookSpec {
	if p == nil {
		return nil
	}
	var specs []HookSpec
	if p.Manifest != nil && (strings.TrimSpace(p.Manifest.Backup.Hook) != "" || len(p.Manifest.Backup.Assets) > 0) {
		specs = append(specs, HookSpec{
			Scope:  "bundle",
			Root:   p.BundleRoot,
			Path:   p.Manifest.Backup.Hook,
			Assets: append([]BundleBackupAsset(nil), p.Manifest.Backup.Assets...),
		})
	}
	for _, key := range p.lifecycleKeys() {
		lifecycle := p.Lifecycles[key]
		if strings.TrimSpace(lifecycle.Backup.Hook) == "" && len(lifecycle.Backup.Assets) == 0 {
			continue
		}
		specs = append(specs, HookSpec{
			Scope:  "component-" + key,
			Root:   lifecycle.Root,
			Path:   lifecycle.Backup.Hook,
			Env:    cloneStringMap(lifecycle.Env),
			Assets: append([]BundleBackupAsset(nil), lifecycle.Backup.Assets...),
		})
	}
	return specs
}

// RestoreHooks 返回 bundle 级与组件级的 restore hook。
func (p *ResolvedPlan) RestoreHooks() []HookSpec {
	if p == nil {
		return nil
	}
	var specs []HookSpec
	if p.Manifest != nil && strings.TrimSpace(p.Manifest.Lifecycle.Restore.Hook) != "" {
		specs = append(specs, HookSpec{
			Scope: "bundle",
			Root:  p.BundleRoot,
			Path:  p.Manifest.Lifecycle.Restore.Hook,
		})
	}
	for _, key := range p.lifecycleKeys() {
		lifecycle := p.Lifecycles[key]
		if strings.TrimSpace(lifecycle.Restore.Hook) == "" {
			continue
		}
		specs = append(specs, HookSpec{
			Scope: "component-" + key,
			Root:  lifecycle.Root,
			Path:  lifecycle.Restore.Hook,
			Env:   cloneStringMap(lifecycle.Env),
		})
	}
	return specs
}

// UpgradeHooks 返回指定阶段（pre_upgrade/post_upgrade）的 hook。
func (p *ResolvedPlan) UpgradeHooks(phase string) []HookSpec {
	if p == nil {
		return nil
	}
	var specs []HookSpec
	add := func(scope, root string, hooks BundleHooks, env map[string]string) {
		var hook string
		switch phase {
		case "pre_upgrade":
			hook = hooks.PreUpgrade
		case "post_upgrade":
			hook = hooks.PostUpgrade
		}
		if strings.TrimSpace(hook) == "" {
			return
		}
		specs = append(specs, HookSpec{Scope: scope, Root: root, Path: hook, Env: cloneStringMap(env)})
	}
	if p.Manifest != nil {
		add("bundle", p.BundleRoot, p.Manifest.Lifecycle.Hooks, nil)
	}
	for _, key := range p.lifecycleKeys() {
		lifecycle := p.Lifecycles[key]
		add("component-"+key, lifecycle.Root, lifecycle.Hooks, lifecycle.Env)
	}
	return specs
}

func (p *ResolvedPlan) lifecycleKeys() []string {
	keys := make([]string, 0, len(p.Lifecycles))
	seen := map[string]bool{}
	// plan.Components 已按 after 拓扑排序；hook 顺序必须与启动顺序一致。
	for _, key := range p.Components {
		if _, ok := p.Lifecycles[key]; ok && !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	rest := make([]string, 0, len(p.Lifecycles)-len(keys))
	for key := range p.Lifecycles {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	return append(keys, rest...)
}
