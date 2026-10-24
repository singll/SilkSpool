package engine

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/singll/silkspool/internal/config"
)

// DiffEntry 描述 desired 与 actual 的一项差异。
type DiffEntry struct {
	Field   string `json:"field" yaml:"field"`
	Desired string `json:"desired,omitempty" yaml:"desired,omitempty"`
	Actual  string `json:"actual,omitempty" yaml:"actual,omitempty"`
	Detail  string `json:"detail,omitempty" yaml:"detail,omitempty"`
}

// DesiredState 是 plan 的期望状态。
type DesiredState struct {
	Components   []string      `json:"components" yaml:"components"`
	Dependencies []string      `json:"dependencies,omitempty" yaml:"dependencies,omitempty"`
	Services     []ServiceSpec `json:"services" yaml:"services"`
	LockHash     string        `json:"lock_hash" yaml:"lock_hash"`
	ComposeHash  string        `json:"compose_sha256" yaml:"compose_sha256"`
	DeployPath   string        `json:"deploy_path" yaml:"deploy_path"`
}

// ServiceState 是远端实际服务状态。
type ServiceState struct {
	Name  string `json:"name" yaml:"name"`
	Image string `json:"image,omitempty" yaml:"image,omitempty"`
	State string `json:"state,omitempty" yaml:"state,omitempty"`
}

// ActualState 是 online plan 读取的远端状态。
type ActualState struct {
	Deployed    bool           `json:"deployed" yaml:"deployed"`
	Generation  int            `json:"generation" yaml:"generation"`
	LockHash    string         `json:"lock_hash,omitempty" yaml:"lock_hash,omitempty"`
	ComposeHash string         `json:"compose_sha256,omitempty" yaml:"compose_sha256,omitempty"`
	Status      string         `json:"status,omitempty" yaml:"status,omitempty"`
	Services    []ServiceState `json:"services,omitempty" yaml:"services,omitempty"`
}

// PlanResult 是 plan 命令的完整结果。
type PlanResult struct {
	Bundle      string        `json:"bundle" yaml:"bundle"`
	Host        string        `json:"host" yaml:"host"`
	Mode        string        `json:"mode" yaml:"mode"`
	Desired     DesiredState  `json:"desired" yaml:"desired"`
	Actual      ActualState   `json:"actual" yaml:"actual"`
	Diff        []DiffEntry   `json:"diff" yaml:"diff"`
	Warnings    []string      `json:"warnings" yaml:"warnings"`
	Unsupported bool          `json:"unsupported,omitempty" yaml:"unsupported,omitempty"`
	LockPath    string        `json:"lock_path,omitempty" yaml:"lock_path,omitempty"`
	Lock        *LockSnapshot `json:"-" yaml:"-"`
	Plan        *ResolvedPlan `json:"-" yaml:"-"`
}

// PlanOptions 控制 online/offline 与输入。
type PlanOptions struct {
	Offline bool
	// NoLockWrite 为 true 时不覆盖本地 lock（--locked apply 前的预检使用）。
	NoLockWrite bool
	Inputs      map[string]string
	Secrets     map[string]string
}

// Manager 负责 plan/apply/rollback/restore。
type Manager struct {
	BaseDir string
	Config  *config.Config
	Runner  RemoteRunner
	// SyncFunc 在 apply 前推送配置（CLI 注入真实 rsync 实现；测试可为空）。
	SyncFunc func() error
	Now      func() time.Time
	// HostLockTimeout 为 0 时非阻塞：已有部署锁立即失败。
	HostLockTimeout time.Duration
}

// NewManager 创建部署管理器。
func NewManager(baseDir string, cfg *config.Config, runner RemoteRunner) *Manager {
	return &Manager{BaseDir: baseDir, Config: cfg, Runner: runner}
}

// Plan 执行 offline 静态校验或 online desired/actual diff。
func (m *Manager) Plan(ctx context.Context, bundleName, host string, opts PlanOptions) (*PlanResult, error) {
	plan, err := ResolveBundle(ctx, m.BaseDir, m.Config, bundleName, host, ResolveOptions{
		Inputs:    opts.Inputs,
		WriteLock: !opts.NoLockWrite,
	})
	if err != nil {
		return nil, err
	}

	result := &PlanResult{
		Bundle:   bundleName,
		Host:     host,
		Mode:     "online",
		Warnings: append([]string(nil), plan.Warnings...),
		LockPath: plan.LockPath,
		Lock:     plan.Lock,
		Plan:     plan,
		Desired: DesiredState{
			Components:   append([]string(nil), plan.Components...),
			Dependencies: sortedKeys(plan.Lock.Resolved.Dependencies),
			Services:     plan.Services,
			LockHash:     plan.Lock.LockHash,
			ComposeHash:  plan.Lock.Rendered.ComposeSHA256,
			DeployPath:   plan.DeployPath,
		},
		Actual: ActualState{Services: []ServiceState{}},
		Diff:   []DiffEntry{},
	}

	if opts.Offline {
		result.Mode = "offline"
		return result, nil
	}

	if plan.Manifest.Type != "compose" {
		result.Unsupported = true
		if plan.Manifest.IsScriptManifest() {
			result.Warnings = append(result.Warnings,
				"script driver: plan is unsupported; apply is executed without diff confirmation and requires --yes")
		} else {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("%s driver: plan is unsupported", plan.Manifest.Type))
		}
		return result, nil
	}

	if m.Runner == nil {
		return nil, fmt.Errorf("online plan requires a remote runner")
	}

	actual, err := m.readActual(plan)
	if err != nil {
		return nil, fmt.Errorf("read actual state: %w", err)
	}
	result.Actual = *actual
	result.Diff = diffStates(result.Desired, *actual)
	return result, nil
}

func (m *Manager) readActual(plan *ResolvedPlan) (*ActualState, error) {
	actual := &ActualState{Services: []ServiceState{}}
	baseFile := filepath.Join(plan.DeployPath, "docker-compose.yaml")
	if _, err := m.Runner.ReadFile(baseFile); err != nil {
		return actual, nil
	}
	actual.Deployed = true

	currentRaw, err := m.Runner.ReadFile(RemoteGenerationCurrentPath(plan.DeployPath))
	if err == nil {
		if gen, err := strconv.Atoi(strings.TrimSpace(currentRaw)); err == nil {
			actual.Generation = gen
		}
	}
	if actual.Generation > 0 {
		metaRaw, err := m.Runner.ReadFile(filepath.Join(GenerationDir(plan.DeployPath, actual.Generation), "meta.yaml"))
		if err == nil {
			if meta, err := ParseGenerationMeta([]byte(metaRaw)); err == nil {
				actual.LockHash = meta.LockHash
				actual.ComposeHash = meta.ComposeHash
				actual.Status = meta.Status
				images := map[string]string{}
				for _, svc := range meta.Services {
					images[svc.Name] = svc.Image
				}
				running, err := m.runningServices(plan.DeployPath)
				if err == nil {
					for _, name := range running {
						actual.Services = append(actual.Services, ServiceState{Name: name, Image: images[name], State: "running"})
					}
				}
			}
		}
	}
	if len(actual.Services) == 0 {
		running, err := m.runningServices(plan.DeployPath)
		if err == nil {
			for _, name := range running {
				actual.Services = append(actual.Services, ServiceState{Name: name, State: "running"})
			}
		}
	}
	sort.Slice(actual.Services, func(i, j int) bool { return actual.Services[i].Name < actual.Services[j].Name })
	return actual, nil
}

func (m *Manager) runningServices(deployPath string) ([]string, error) {
	if m.Runner == nil {
		return nil, fmt.Errorf("remote runner is nil")
	}
	files, err := m.remoteComposeFiles(deployPath)
	if err != nil {
		return nil, err
	}
	out, err := m.Runner.Exec(composeCommand(deployPath, files, "ps --status running --services"))
	if err != nil {
		return nil, err
	}
	var services []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			services = append(services, line)
		}
	}
	sort.Strings(services)
	return services, nil
}

func (m *Manager) remoteComposeFiles(deployPath string) ([]string, error) {
	base := filepath.Join(deployPath, "docker-compose.yaml")
	if _, err := m.Runner.ReadFile(base); err != nil {
		return nil, fmt.Errorf("docker-compose.yaml not found at %s", deployPath)
	}
	files := []string{base}
	override := filepath.Join(deployPath, "docker-compose.spool.yaml")
	if _, err := m.Runner.ReadFile(override); err == nil {
		files = append(files, override)
	}
	return files, nil
}

func diffStates(desired DesiredState, actual ActualState) []DiffEntry {
	diff := []DiffEntry{}
	if !actual.Deployed {
		return append(diff, DiffEntry{Field: "deployed", Desired: "true", Actual: "false", Detail: "bundle is not deployed on this host"})
	}
	if desired.LockHash != actual.LockHash {
		diff = append(diff, DiffEntry{Field: "lock_hash", Desired: desired.LockHash, Actual: actual.LockHash})
	}
	if desired.ComposeHash != actual.ComposeHash {
		diff = append(diff, DiffEntry{Field: "compose_sha256", Desired: desired.ComposeHash, Actual: actual.ComposeHash})
	}
	running := map[string]ServiceState{}
	for _, svc := range actual.Services {
		running[svc.Name] = svc
	}
	desiredNames := map[string]bool{}
	for _, svc := range desired.Services {
		desiredNames[svc.Name] = true
		state, ok := running[svc.Name]
		if !ok {
			diff = append(diff, DiffEntry{Field: "service." + svc.Name, Desired: "running", Actual: "missing"})
			continue
		}
		if state.Image != "" && svc.Image != "" && state.Image != svc.Image {
			diff = append(diff, DiffEntry{Field: "image." + svc.Name, Desired: svc.Image, Actual: state.Image})
		}
	}
	for name := range running {
		if !desiredNames[name] {
			diff = append(diff, DiffEntry{Field: "service." + name, Desired: "absent", Actual: "running"})
		}
	}
	sort.Slice(diff, func(i, j int) bool { return diff[i].Field < diff[j].Field })
	return diff
}
