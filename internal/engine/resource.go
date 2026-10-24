package engine

import (
	"context"
	"fmt"
	"sort"

	"github.com/singll/silkspool/internal/config"
)

// Resource 是统一资源模型的最小接口。
type Resource interface {
	Kind() string
	Name() string
	Status(ctx context.Context) (ResourceStatus, error)
}

// PlanApplier 是资源 plan/apply 动词。
type PlanApplier interface {
	Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error)
	Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error)
}

// Backupable 是资源备份/恢复动词。
type Backupable interface {
	Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error)
	Restore(ctx context.Context, ref BackupRef) error
}

// ResourceStatus 是资源的统一状态输出。
type ResourceStatus struct {
	Kind       string            `json:"kind"`
	Name       string            `json:"name"`
	Host       string            `json:"host,omitempty"`
	Status     string            `json:"status,omitempty"`
	Generation int               `json:"generation,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Outputs    map[string]string `json:"outputs,omitempty"`
}

// ResourceOptions 同时承载 plan/apply/服务动作参数。
type ResourceOptions struct {
	Host              string
	Bundle            string
	Inputs            map[string]string
	Secrets           map[string]string
	Offline           bool
	DryRun            bool
	Yes               bool
	Locked            bool
	AllowIrreversible bool
	Action            string
	Domain            string
	IP                string
	Backend           string
	Name              string
	Description       string
	Icon              string
	Delete            bool
}

// BackupRef 指向一次备份产物。
type BackupRef struct {
	Host      string `json:"host"`
	Bundle    string `json:"bundle"`
	Path      string `json:"path,omitempty"`
	Manual    bool   `json:"manual,omitempty"`
	Reference string `json:"reference,omitempty"`
}

// UnsupportedError 表示资源不支持某个动词，绝不静默成功。
type UnsupportedError struct {
	Kind string
	Op   string
}

func (e *UnsupportedError) Error() string {
	return fmt.Sprintf("%s: %s is unsupported", e.Kind, e.Op)
}

// BundleResource 包装 BundleManager/Manager。
type BundleResource struct {
	Manager *Manager
	Bundle  string
	Host    string
}

// NewBundleResource 创建 bundle 资源。
func NewBundleResource(manager *Manager, bundle, host string) *BundleResource {
	return &BundleResource{Manager: manager, Bundle: bundle, Host: host}
}

// Kind 返回资源类型。
func (r *BundleResource) Kind() string { return "Bundle" }

// Name 返回资源名。
func (r *BundleResource) Name() string { return r.Bundle }

// Status 读取本地 state/lock（不连接远端）。
func (r *BundleResource) Status(ctx context.Context) (ResourceStatus, error) {
	status := ResourceStatus{
		Kind:    r.Kind(),
		Name:    r.Bundle,
		Host:    r.Host,
		Status:  "declared",
		Labels:  map[string]string{},
		Outputs: map[string]string{},
	}
	if r.Manager == nil {
		return status, nil
	}
	if manifest, err := NewManifestLoader(r.Manager.BaseDir).Load(r.Bundle); err == nil {
		status.Labels = manifest.Labels
	}
	state, err := ReadLocalState(r.Manager.BaseDir, r.Host, r.Bundle)
	if err == nil {
		status.Generation = state.Generation
		status.Status = state.Status
	}
	if lock, err := LoadLock(r.Manager.BaseDir, r.Host, r.Bundle); err == nil {
		status.Outputs = LockOutputs(lock)
	} else if manifest, err := NewManifestLoader(r.Manager.BaseDir).Load(r.Bundle); err == nil {
		status.Outputs = ManifestLogicalOutputs(manifest)
	}
	return status, nil
}

// Plan 委托给 Manager.Plan。
func (r *BundleResource) Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error) {
	if r.Manager == nil {
		return nil, fmt.Errorf("bundle resource manager is nil")
	}
	return r.Manager.Plan(ctx, r.Bundle, r.Host, PlanOptions{Offline: opts.Offline, Inputs: opts.Inputs, Secrets: opts.Secrets})
}

// Apply 委托给 Manager.Apply。
func (r *BundleResource) Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error) {
	if r.Manager == nil {
		return nil, fmt.Errorf("bundle resource manager is nil")
	}
	return r.Manager.Apply(ctx, r.Bundle, r.Host, ApplyOptions{
		Locked:            opts.Locked,
		DryRun:            opts.DryRun,
		Yes:               opts.Yes,
		AllowIrreversible: opts.AllowIrreversible,
		Inputs:            opts.Inputs,
		Secrets:           opts.Secrets,
	})
}

// Backup 执行产品 backup.hook。
func (r *BundleResource) Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error) {
	if r.Manager == nil {
		return BackupRef{}, fmt.Errorf("bundle resource manager is nil")
	}
	path, err := r.Manager.Backup(ctx, r.Bundle, r.Host, opts.Inputs, opts.Secrets)
	if err != nil {
		return BackupRef{}, err
	}
	return BackupRef{Host: r.Host, Bundle: r.Bundle, Path: path}, nil
}

// Restore 执行 restore.hook 或明确返回人工恢复。
func (r *BundleResource) Restore(ctx context.Context, ref BackupRef) error {
	if r.Manager == nil {
		return fmt.Errorf("bundle resource manager is nil")
	}
	_, err := r.Manager.Restore(ctx, r.Bundle, r.Host, ref.Path)
	return err
}

// ServiceResource 包装 ServiceManager。
type ServiceResource struct {
	BaseDir string
	Host    string
	Alias   string
}

// NewServiceResource 创建 service 资源。
func NewServiceResource(baseDir, host, alias string) *ServiceResource {
	return &ServiceResource{BaseDir: baseDir, Host: host, Alias: alias}
}

// Kind 返回资源类型。
func (r *ServiceResource) Kind() string { return "Service" }

// Name 返回资源名。
func (r *ServiceResource) Name() string { return r.Alias }

// Status 查询服务状态。
func (r *ServiceResource) Status(ctx context.Context) (ResourceStatus, error) {
	manager, err := NewServiceManager(r.BaseDir)
	if err != nil {
		return ResourceStatus{}, err
	}
	status, err := manager.GetServiceStatus(r.Host, r.Alias)
	if err != nil {
		return ResourceStatus{}, err
	}
	return ResourceStatus{Kind: r.Kind(), Name: r.Alias, Host: r.Host, Status: status, Labels: map[string]string{}, Outputs: map[string]string{}}, nil
}

// Plan 明确 unsupported：service 没有声明式 diff。
func (r *ServiceResource) Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error) {
	return nil, &UnsupportedError{Kind: r.Kind(), Op: "plan"}
}

// Apply 映射到 start/stop/restart（默认 start）。
func (r *ServiceResource) Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error) {
	manager, err := NewServiceManager(r.BaseDir)
	if err != nil {
		return nil, err
	}
	action := opts.Action
	if action == "" {
		action = "start"
	}
	switch action {
	case "start", "up":
		err = manager.StartService(r.Host, r.Alias)
	case "stop", "down":
		err = manager.StopService(r.Host, r.Alias)
	case "restart":
		err = manager.RestartService(r.Host, r.Alias)
	default:
		return nil, &UnsupportedError{Kind: r.Kind(), Op: "apply action " + action}
	}
	if err != nil {
		return nil, err
	}
	return &ApplyResult{Bundle: r.Alias, Host: r.Host, Status: "succeeded", Warnings: []string{}}, nil
}

// Backup 明确 unsupported。
func (r *ServiceResource) Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error) {
	return BackupRef{}, &UnsupportedError{Kind: r.Kind(), Op: "backup"}
}

// Restore 明确 unsupported。
func (r *ServiceResource) Restore(ctx context.Context, ref BackupRef) error {
	return &UnsupportedError{Kind: r.Kind(), Op: "restore"}
}

// Backup 执行 bundle 级 backup.hook（不改变 generation）。
func (m *Manager) Backup(ctx context.Context, bundleName, host string, inputs, secrets map[string]string) (string, error) {
	plan, err := ResolveBundle(ctx, m.BaseDir, m.Config, bundleName, host, ResolveOptions{Inputs: inputs, Secrets: secrets})
	if err != nil {
		return "", err
	}
	if m.Runner == nil {
		return "", fmt.Errorf("backup requires a remote runner")
	}
	specs := plan.BackupHooks()
	if len(specs) == 0 {
		return "", &UnsupportedError{Kind: "Bundle", Op: "backup (no backup.hook declared)"}
	}
	if secrets == nil {
		secrets = LoadSecrets(m.BaseDir, host, bundleName)
	}
	current, _ := m.currentGeneration(plan.DeployPath)
	return m.runBackupHooks(ctx, plan, current, specs, secrets)
}

// ManifestLogicalOutputs 返回未解析的逻辑 outputs（用于 inventory）。
func ManifestLogicalOutputs(manifest *BundleManifest) map[string]string {
	outputs := map[string]string{}
	if manifest == nil {
		return outputs
	}
	for _, name := range sortedKeys(manifest.Outputs) {
		output := manifest.Outputs[name]
		if output.IsEndpoint() {
			outputs[name] = fmt.Sprintf("endpoint:%s:%d", output.Service, output.Port)
		} else if output.Sensitive {
			outputs[name] = "secret://" + name
		} else {
			outputs[name] = output.Value
		}
	}
	return outputs
}

// LockOutputs 展平 lock 中的 resolved outputs。
func LockOutputs(lock *LockSnapshot) map[string]string {
	outputs := map[string]string{}
	if lock == nil {
		return outputs
	}
	for key, comp := range lock.Resolved.Components {
		for name, out := range comp.Outputs {
			outputs["components."+key+"."+name] = formatResolvedOutput(out)
		}
	}
	for key, dep := range lock.Resolved.Dependencies {
		for name, out := range dep.Outputs {
			outputs["dependencies."+key+"."+name] = formatResolvedOutput(out)
		}
	}
	return outputs
}

func formatResolvedOutput(output ResolvedOutput) string {
	if output.Sensitive || (output.Value != "" && len(output.Value) > 8 && output.Value[:9] == "secret://") {
		return "***"
	}
	if output.Kind == "endpoint" {
		return fmt.Sprintf("%s:%d", output.Host, output.Port)
	}
	return output.Value
}

// ListResourceStatuses 返回主机上已注册 Bundle/Service 的统一状态。
func ListResourceStatuses(baseDir string, cfg *config.Config, manager *Manager) []ResourceStatus {
	if cfg == nil {
		return nil
	}
	var statuses []ResourceStatus
	for _, host := range sortedKeys(cfg.Hosts) {
		hostCfg := cfg.Hosts[host]
		for _, bundle := range hostCfg.Bundles {
			resource := NewBundleResource(manager, bundle, host)
			status, err := resource.Status(context.Background())
			if err != nil {
				status = ResourceStatus{Kind: "Bundle", Name: bundle, Host: host, Status: "error"}
			}
			statuses = append(statuses, status)
		}
		for _, svc := range hostCfg.Services {
			status := ResourceStatus{
				Kind:    "Service",
				Name:    svc.Alias,
				Host:    host,
				Status:  "declared",
				Labels:  map[string]string{},
				Outputs: map[string]string{},
			}
			if state, err := ReadLocalState(baseDir, host, svc.Alias); err == nil {
				status.Status = state.Status
			}
			statuses = append(statuses, status)
		}
	}
	gatewayHost := cfg.Global.DNSGatewayHost
	if gatewayHost == "" {
		gatewayHost = "local"
	}
	if dnsManager, err := NewDNSManager(baseDir); err == nil {
		if records, err := dnsManager.ListDNSRecords(); err == nil {
			seen := map[string]bool{}
			for _, record := range records {
				if seen[record.Domain] {
					continue
				}
				seen[record.Domain] = true
				statuses = append(statuses, ResourceStatus{
					Kind:    "DNSRecord",
					Name:    record.Domain,
					Host:    gatewayHost,
					Status:  "present",
					Labels:  map[string]string{},
					Outputs: map[string]string{"ip": record.IP},
				})
			}
		}
	}
	if siteManager, err := NewSiteManager(baseDir); err == nil {
		if sites, err := siteManager.ListSites(); err == nil {
			for _, site := range sites {
				statuses = append(statuses, ResourceStatus{
					Kind:    "Site",
					Name:    site.Domain,
					Host:    gatewayHost,
					Status:  "present",
					Labels:  map[string]string{},
					Outputs: map[string]string{"backend": site.Backend, "name": site.Name},
				})
			}
		}
	}
	sort.Slice(statuses, func(i, j int) bool {
		if statuses[i].Host != statuses[j].Host {
			return statuses[i].Host < statuses[j].Host
		}
		if statuses[i].Kind != statuses[j].Kind {
			return statuses[i].Kind < statuses[j].Kind
		}
		return statuses[i].Name < statuses[j].Name
	})
	return statuses
}

// DNSRecordResource 包装 DNSManager。
type DNSRecordResource struct {
	BaseDir string
	Host    string
	Domain  string
	IP      string
}

// NewDNSRecordResource 创建 DNS 资源。
func NewDNSRecordResource(baseDir, host, domain, ip string) *DNSRecordResource {
	return &DNSRecordResource{BaseDir: baseDir, Host: host, Domain: domain, IP: ip}
}

// Kind 返回资源类型。
func (r *DNSRecordResource) Kind() string { return "DNSRecord" }

// Name 返回域名。
func (r *DNSRecordResource) Name() string { return r.Domain }

// Status 查询本地 DNS provider 配置。
func (r *DNSRecordResource) Status(ctx context.Context) (ResourceStatus, error) {
	manager, err := NewDNSManager(r.BaseDir)
	if err != nil {
		return ResourceStatus{}, err
	}
	records, err := manager.ListDNSRecords()
	if err != nil {
		return ResourceStatus{}, err
	}
	status := ResourceStatus{Kind: r.Kind(), Name: r.Domain, Host: r.Host, Status: "absent", Labels: map[string]string{}, Outputs: map[string]string{}}
	for _, record := range records {
		if record.Domain == r.Domain {
			status.Status = "present"
			status.Outputs["ip"] = record.IP
			break
		}
	}
	return status, nil
}

// Plan 输出 DNS 记录的 desired/actual diff。
func (r *DNSRecordResource) Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error) {
	status, err := r.Status(ctx)
	if err != nil {
		return nil, err
	}
	desiredIP := opts.IP
	if desiredIP == "" {
		desiredIP = r.IP
	}
	result := &PlanResult{Bundle: "dns", Host: r.Host, Mode: "offline", Diff: []DiffEntry{}}
	result.Desired.Components = []string{r.Domain}
	result.Desired.LockHash = "dns:" + desiredIP
	result.Actual.LockHash = status.Outputs["ip"]
	result.Actual.Status = status.Status
	if status.Status == "absent" {
		result.Diff = append(result.Diff, DiffEntry{Field: "dns." + r.Domain, Desired: desiredIP, Actual: "absent"})
	} else if desiredIP != "" && status.Outputs["ip"] != desiredIP {
		result.Diff = append(result.Diff, DiffEntry{Field: "dns." + r.Domain, Desired: desiredIP, Actual: status.Outputs["ip"]})
	}
	return result, nil
}

// Apply 添加/删除 DNS 记录。
func (r *DNSRecordResource) Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error) {
	manager, err := NewDNSManager(r.BaseDir)
	if err != nil {
		return nil, err
	}
	domain := r.Domain
	if domain == "" {
		domain = opts.Domain
	}
	if domain == "" {
		return nil, fmt.Errorf("dns apply: domain is required")
	}
	if opts.Delete {
		if err := manager.RemoveDomain(domain); err != nil {
			return nil, err
		}
	} else {
		ip := opts.IP
		if ip == "" {
			ip = r.IP
		}
		if err := manager.AddDomain(domain, ip); err != nil {
			return nil, err
		}
	}
	return &ApplyResult{Bundle: "dns", Host: r.Host, Status: "succeeded", Warnings: []string{}}, nil
}

// Backup 明确 unsupported。
func (r *DNSRecordResource) Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error) {
	return BackupRef{}, &UnsupportedError{Kind: r.Kind(), Op: "backup"}
}

// Restore 明确 unsupported。
func (r *DNSRecordResource) Restore(ctx context.Context, ref BackupRef) error {
	return &UnsupportedError{Kind: r.Kind(), Op: "restore"}
}

// SiteResource 包装 SiteManager。
type SiteResource struct {
	BaseDir string
	Host    string
	Domain  string
}

// NewSiteResource 创建站点资源。
func NewSiteResource(baseDir, host, domain string) *SiteResource {
	return &SiteResource{BaseDir: baseDir, Host: host, Domain: domain}
}

// Kind 返回资源类型。
func (r *SiteResource) Kind() string { return "Site" }

// Name 返回域名。
func (r *SiteResource) Name() string { return r.Domain }

// Status 查询本地 Caddy/Homepage 配置。
func (r *SiteResource) Status(ctx context.Context) (ResourceStatus, error) {
	manager, err := NewSiteManager(r.BaseDir)
	if err != nil {
		return ResourceStatus{}, err
	}
	sites, err := manager.ListSites()
	if err != nil {
		return ResourceStatus{}, err
	}
	status := ResourceStatus{Kind: r.Kind(), Name: r.Domain, Host: r.Host, Status: "absent", Labels: map[string]string{}, Outputs: map[string]string{}}
	for _, site := range sites {
		if site.Domain == r.Domain {
			status.Status = "present"
			status.Outputs["backend"] = site.Backend
			status.Outputs["name"] = site.Name
			break
		}
	}
	return status, nil
}

// Plan 输出站点 desired/actual diff。
func (r *SiteResource) Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error) {
	status, err := r.Status(ctx)
	if err != nil {
		return nil, err
	}
	backend := opts.Backend
	result := &PlanResult{Bundle: "site", Host: r.Host, Mode: "offline", Diff: []DiffEntry{}}
	result.Desired.Components = []string{r.Domain}
	result.Desired.LockHash = "site:" + backend
	result.Actual.LockHash = status.Outputs["backend"]
	result.Actual.Status = status.Status
	if status.Status == "absent" {
		result.Diff = append(result.Diff, DiffEntry{Field: "site." + r.Domain, Desired: backend, Actual: "absent"})
	} else if backend != "" && status.Outputs["backend"] != backend {
		result.Diff = append(result.Diff, DiffEntry{Field: "site." + r.Domain, Desired: backend, Actual: status.Outputs["backend"]})
	}
	return result, nil
}

// Apply 添加/删除站点配置。
func (r *SiteResource) Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error) {
	manager, err := NewSiteManager(r.BaseDir)
	if err != nil {
		return nil, err
	}
	domain := r.Domain
	if domain == "" {
		domain = opts.Domain
	}
	if domain == "" {
		return nil, fmt.Errorf("site apply: domain is required")
	}
	if opts.Delete {
		if err := manager.RemoveSite(domain); err != nil {
			return nil, err
		}
	} else {
		name := opts.Name
		if name == "" {
			name = domain
		}
		if err := manager.AddSite(domain, opts.Backend, name, opts.Description, opts.Icon); err != nil {
			return nil, err
		}
	}
	return &ApplyResult{Bundle: "site", Host: r.Host, Status: "succeeded", Warnings: []string{}}, nil
}

// Backup 明确 unsupported。
func (r *SiteResource) Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error) {
	return BackupRef{}, &UnsupportedError{Kind: r.Kind(), Op: "backup"}
}

// Restore 明确 unsupported。
func (r *SiteResource) Restore(ctx context.Context, ref BackupRef) error {
	return &UnsupportedError{Kind: r.Kind(), Op: "restore"}
}
