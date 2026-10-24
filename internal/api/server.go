package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
)

// ActorHeader 允许调用方声明审计 actor。
const ActorHeader = "X-Spool-Actor"

// ApprovalHeader 可作为显式审批 token（与服务 token 相同）。
const ApprovalHeader = "X-Spool-Approval"

// Target 是 action 的目标。
type Target struct {
	Host   string `json:"host"`
	Bundle string `json:"bundle"`
}

// ActionOptions 是 action 的选项。
type ActionOptions struct {
	Offline           bool              `json:"offline,omitempty"`
	DryRun            bool              `json:"dry_run,omitempty"`
	Locked            bool              `json:"locked,omitempty"`
	Yes               bool              `json:"yes,omitempty"`
	AllowIrreversible bool              `json:"allow_irreversible,omitempty"`
	Generation        int               `json:"generation,omitempty"`
	Inputs            map[string]string `json:"inputs,omitempty"`
}

// ActionRequest 是 POST /v1/actions 的请求体。
type ActionRequest struct {
	Action         string        `json:"action"`
	Target         Target        `json:"target"`
	Options        ActionOptions `json:"options"`
	IdempotencyKey string        `json:"idempotency_key,omitempty"`
}

// ActionRunner 执行一个 action；HTTP 层和 engine 解耦，测试可注入 fake。
type ActionRunner interface {
	Run(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error)
}

// Server 是本机 Unix socket HTTP 服务。
type Server struct {
	BaseDir string
	Config  *config.Config
	Token   string
	Jobs    *JobManager
	Audit   *AuditLogger
}

// NewServer 创建 API server。
func NewServer(baseDir string, cfg *config.Config, runner ActionRunner, token string, audit *AuditLogger) *Server {
	if audit == nil {
		audit = NewAuditLogger(nil)
	}
	return &Server{
		BaseDir: baseDir,
		Config:  cfg,
		Token:   token,
		Audit:   audit,
		Jobs:    NewJobManager(runner, audit),
	}
}

// Handler 返回 HTTP handler。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /v1/inventory", s.handleInventory)
	mux.HandleFunc("GET /v1/hosts/{host}/bundles/{bundle}", s.handleBundle)
	mux.HandleFunc("GET /v1/hosts/{host}/bundles/{bundle}/outputs", s.handleOutputs)
	mux.HandleFunc("POST /v1/actions", s.handleActions)
	mux.HandleFunc("GET /v1/jobs/{id}", s.handleJob)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" && !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or missing bearer token")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	if s.Token == "" {
		return true
	}
	return r.Header.Get("Authorization") == "Bearer "+s.Token
}

func (s *Server) actor(r *http.Request) string {
	if actor := strings.TrimSpace(r.Header.Get(ActorHeader)); actor != "" {
		return actor
	}
	if s.Token != "" {
		return "token"
	}
	return "local"
}

// HostInventory 是 inventory 中的主机视图。
type HostInventory struct {
	Name      string           `json:"name"`
	Address   string           `json:"address,omitempty"`
	MagicDNS  string           `json:"magicdns,omitempty"`
	AppPrefix string           `json:"app_prefix,omitempty"`
	Bundles   []BundleSummary  `json:"bundles"`
	Services  []ServiceSummary `json:"services,omitempty"`
}

// BundleSummary 是 inventory 中的 bundle 视图。
type BundleSummary struct {
	Kind       string            `json:"kind"`
	Name       string            `json:"name"`
	Host       string            `json:"host"`
	Class      string            `json:"class,omitempty"`
	Version    string            `json:"version,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	DeployPath string            `json:"deploy_path,omitempty"`
	Services   []string          `json:"services,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Status     string            `json:"status,omitempty"`
	Generation int               `json:"generation,omitempty"`
	Outputs    map[string]string `json:"outputs,omitempty"`
}

// ServiceSummary 是 inventory 中的服务视图。
type ServiceSummary struct {
	Kind   string `json:"kind"`
	Alias  string `json:"alias"`
	Type   string `json:"type"`
	Name   string `json:"name"`
	Host   string `json:"host"`
	Status string `json:"status,omitempty"`
}

// Inventory 是 GET /v1/inventory 的输出。
type Inventory struct {
	Hosts     []HostInventory         `json:"hosts"`
	Resources []engine.ResourceStatus `json:"resources"`
}

func (s *Server) handleInventory(w http.ResponseWriter, r *http.Request) {
	inventory := Inventory{Hosts: []HostInventory{}, Resources: []engine.ResourceStatus{}}
	if s.Config == nil {
		writeJSON(w, http.StatusOK, inventory)
		return
	}
	names := make([]string, 0, len(s.Config.Hosts))
	for name := range s.Config.Hosts {
		names = append(names, name)
	}
	sort.Strings(names)
	repo := engine.NewBundleRepository(s.BaseDir, s.Config)
	for _, name := range names {
		hostCfg := s.Config.Hosts[name]
		host := HostInventory{
			Name:      name,
			Address:   hostCfg.Address,
			MagicDNS:  hostCfg.MagicDNS,
			AppPrefix: hostCfg.AppPrefix,
			Bundles:   []BundleSummary{},
			Services:  []ServiceSummary{},
		}
		for _, bundleName := range hostCfg.Bundles {
			host.Bundles = append(host.Bundles, s.bundleSummary(r.Context(), repo, name, bundleName))
		}
		for _, svc := range hostCfg.Services {
			host.Services = append(host.Services, ServiceSummary{Kind: "Service", Alias: svc.Alias, Type: svc.Type, Name: svc.Name, Host: name})
		}
		inventory.Hosts = append(inventory.Hosts, host)
	}
	manager := engine.NewManager(s.BaseDir, s.Config, nil)
	inventory.Resources = engine.ListResourceStatuses(s.BaseDir, s.Config, manager)
	writeJSON(w, http.StatusOK, inventory)
}

func (s *Server) bundleSummary(ctx context.Context, repo *engine.BundleRepository, host, bundleName string) BundleSummary {
	summary := BundleSummary{
		Kind:       "Bundle",
		Name:       bundleName,
		Host:       host,
		Status:     "declared",
		Outputs:    map[string]string{},
		DeployPath: engine.ResolveDeployPath(s.BaseDir, s.Config, bundleName, nil),
	}
	if loaded, err := repo.Load(ctx, bundleName, nil); err == nil {
		manifest := loaded.Manifest
		summary.Class = manifest.Class
		summary.Version = manifest.Version
		summary.Driver = manifest.Type
		summary.Services = append([]string(nil), manifest.Services...)
		summary.Labels = manifest.Labels
		summary.DeployPath = engine.ResolveDeployPath(s.BaseDir, s.Config, bundleName, manifest)
		summary.Outputs = engine.ManifestLogicalOutputs(manifest)
	}
	if state, err := engine.ReadLocalState(s.BaseDir, host, bundleName); err == nil {
		summary.Status = state.Status
		summary.Generation = state.Generation
	}
	if lock, err := engine.LoadLock(s.BaseDir, host, bundleName); err == nil {
		summary.Outputs = engine.LockOutputs(lock)
	}
	return summary
}

// BundleDetail 是 GET /v1/hosts/{host}/bundles/{bundle} 的输出。
type BundleDetail struct {
	Kind            string            `json:"kind"`
	Name            string            `json:"name"`
	Host            string            `json:"host"`
	Class           string            `json:"class,omitempty"`
	Version         string            `json:"version,omitempty"`
	Owner           string            `json:"owner,omitempty"`
	Driver          string            `json:"driver,omitempty"`
	DeployPath      string            `json:"deploy_path"`
	AliasOf         string            `json:"alias_of,omitempty"`
	DeprecatedAlias string            `json:"deprecated_alias,omitempty"`
	Components      []string          `json:"components,omitempty"`
	Dependencies    []string          `json:"dependencies,omitempty"`
	Services        []string          `json:"services,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	Outputs         map[string]string `json:"outputs,omitempty"`
	ResolvedOutputs map[string]string `json:"resolved_outputs,omitempty"`
	Status          string            `json:"status,omitempty"`
	Generation      int               `json:"generation,omitempty"`
}

func (s *Server) handleBundle(w http.ResponseWriter, r *http.Request) {
	host := r.PathValue("host")
	bundleName := r.PathValue("bundle")
	if s.Config == nil || s.Config.GetHost(host) == nil {
		writeError(w, http.StatusNotFound, "unknown_host", "host not found: "+host)
		return
	}
	repo := engine.NewBundleRepository(s.BaseDir, s.Config)
	loaded, err := repo.Load(r.Context(), bundleName, nil)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown_bundle", err.Error())
		return
	}
	manifest := loaded.Manifest
	detail := BundleDetail{
		Kind:            "Bundle",
		Name:            bundleName,
		Host:            host,
		Class:           manifest.Class,
		Version:         manifest.Version,
		Owner:           manifest.Owner,
		Driver:          manifest.Type,
		DeployPath:      engine.ResolveDeployPath(s.BaseDir, s.Config, bundleName, manifest),
		AliasOf:         loaded.AliasOf,
		DeprecatedAlias: manifest.DeprecatedAlias,
		Components:      engine.SortedComponentKeys(manifest.Components),
		Dependencies:    engine.SortedDependencyKeys(manifest.Dependencies),
		Services:        append([]string(nil), manifest.Services...),
		Labels:          manifest.Labels,
		Outputs:         engine.ManifestLogicalOutputs(manifest),
		ResolvedOutputs: map[string]string{},
	}
	if state, err := engine.ReadLocalState(s.BaseDir, host, bundleName); err == nil {
		detail.Status = state.Status
		detail.Generation = state.Generation
	}
	if lock, err := engine.LoadLock(s.BaseDir, host, bundleName); err == nil {
		detail.ResolvedOutputs = engine.LockOutputs(lock)
	}
	writeJSON(w, http.StatusOK, detail)
}

// OutputsResponse 是 GET .../outputs 的输出。
type OutputsResponse struct {
	Host     string            `json:"host"`
	Bundle   string            `json:"bundle"`
	Resolved bool              `json:"resolved"`
	Outputs  map[string]string `json:"outputs"`
}

func (s *Server) handleOutputs(w http.ResponseWriter, r *http.Request) {
	host := r.PathValue("host")
	bundleName := r.PathValue("bundle")
	if s.Config == nil || s.Config.GetHost(host) == nil {
		writeError(w, http.StatusNotFound, "unknown_host", "host not found: "+host)
		return
	}
	repo := engine.NewBundleRepository(s.BaseDir, s.Config)
	loaded, err := repo.Load(r.Context(), bundleName, nil)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown_bundle", err.Error())
		return
	}
	response := OutputsResponse{Host: host, Bundle: bundleName, Outputs: engine.ManifestLogicalOutputs(loaded.Manifest)}
	if r.URL.Query().Get("resolved") == "true" {
		if lock, err := engine.LoadLock(s.BaseDir, host, bundleName); err == nil {
			response.Resolved = true
			response.Outputs = engine.LockOutputs(lock)
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleActions(w http.ResponseWriter, r *http.Request) {
	var request ActionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := validateActionRequest(request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if s.Config == nil || s.Config.GetHost(request.Target.Host) == nil {
		writeError(w, http.StatusNotFound, "unknown_host", "host not found: "+request.Target.Host)
		return
	}
	if isDangerous(request.Action) && !request.Options.Yes && !s.approvalToken(r) {
		writeError(w, http.StatusForbidden, "approval_required", "dangerous action requires options.yes=true or approval token")
		return
	}
	job, reused := s.Jobs.Submit(request, s.actor(r))
	response := map[string]interface{}{"job_id": job.ID, "state": job.State}
	if reused {
		response["idempotent_reuse"] = true
	}
	writeJSON(w, http.StatusAccepted, response)
}

func (s *Server) approvalToken(r *http.Request) bool {
	if s.Token == "" {
		return false
	}
	return r.Header.Get(ApprovalHeader) == s.Token
}

func validateActionRequest(request ActionRequest) error {
	switch request.Action {
	case "bundle.plan", "bundle.apply", "bundle.rollback":
	default:
		return fmt.Errorf("unsupported action %q (want bundle.plan|bundle.apply|bundle.rollback)", request.Action)
	}
	if strings.TrimSpace(request.Target.Host) == "" || strings.TrimSpace(request.Target.Bundle) == "" {
		return fmt.Errorf("target.host and target.bundle are required")
	}
	if request.Action == "bundle.rollback" && request.Options.Generation < 0 {
		return fmt.Errorf("options.generation must be >= 0")
	}
	return nil
}

func isDangerous(action string) bool {
	return action == "bundle.apply" || action == "bundle.rollback"
}

func (s *Server) handleJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.Jobs.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "job_not_found", "job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]interface{}{
		"error": map[string]string{"code": code, "message": message},
	})
}

// ListenUnix 创建权限为 0600 的 Unix socket。
func ListenUnix(path string) (net.Listener, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("socket path is required")
	}
	if info, err := os.Stat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}
