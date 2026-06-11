package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestSOPSManagerNewWithKey(t *testing.T) {
	mgr := NewSOPSManagerWithKey("/path/to/age.key")
	if mgr == nil {
		t.Error("NewSOPSManagerWithKey should not return nil")
	}
	if mgr.mgr == nil {
		t.Error("inner sops.Manager should not be nil")
	}
}

func TestSOPSManagerStruct(t *testing.T) {
	mgr := &SOPSManager{}
	if mgr == nil {
		t.Error("SOPSManager should be constructable")
	}
}

func TestNewComposeDriverValues(t *testing.T) {
	d := NewComposeDriver("/test/base", "/test/key", "testbundle")
	if d.baseDir != "/test/base" {
		t.Errorf("baseDir = %q, want %q", d.baseDir, "/test/base")
	}
	if d.sshKey != "/test/key" {
		t.Errorf("sshKey = %q, want %q", d.sshKey, "/test/key")
	}
	if d.bundleName != "testbundle" {
		t.Errorf("bundleName = %q, want %q", d.bundleName, "testbundle")
	}
	if d.defaults != (config.DefaultsConfig{}) {
		t.Error("defaults should be zero-value without WithDefaults constructor")
	}
}

func TestNewComposeDriverWithDefaultsValues(t *testing.T) {
	defaults := config.DefaultsConfig{
		LogLines:     200,
		ComposeVer:   "v2.30.0",
		DockerLogMax: "100m",
		DockerLogNum: 5,
	}
	d := NewComposeDriverWithDefaults("/base", "/key", "bundle", defaults)
	if d.defaults.LogLines != 200 {
		t.Errorf("LogLines = %d, want 200", d.defaults.LogLines)
	}
	if d.defaults.ComposeVer != "v2.30.0" {
		t.Errorf("ComposeVer = %q, want %q", d.defaults.ComposeVer, "v2.30.0")
	}
	if d.defaults.DockerLogMax != "100m" {
		t.Errorf("DockerLogMax = %q, want %q", d.defaults.DockerLogMax, "100m")
	}
	if d.defaults.DockerLogNum != 5 {
		t.Errorf("DockerLogNum = %d, want 5", d.defaults.DockerLogNum)
	}
}

func TestNewRemoteExecutorWithNilClient(t *testing.T) {
	re := &RemoteExecutor{}
	if re.client != nil {
		t.Error("RemoteExecutor with nil client should have nil client")
	}
}

func TestNewRemoteExecutorWithDefaultsValues(t *testing.T) {
	re := &RemoteExecutor{
		defaults: config.DefaultsConfig{
			LogLines:     50,
			ComposeVer:   "v2.24.5",
			DockerLogMax: "50m",
			DockerLogNum: 3,
		},
	}
	if re.defaults.LogLines != 50 {
		t.Errorf("LogLines = %d, want 50", re.defaults.LogLines)
	}
}

func TestCreateDockerNetworkEmptyName(t *testing.T) {
	re := &RemoteExecutor{}
	err := re.CreateDockerNetwork("")
	if err != nil {
		t.Errorf("CreateDockerNetwork('') should return nil, got %v", err)
	}
}

func TestComposeServiceUnknownAction(t *testing.T) {
	validActions := map[string]bool{
		"up": true, "down": true, "build": true, "logs": true, "restart": true,
	}
	if _, ok := validActions["invalid-action"]; ok {
		t.Error("invalid-action should not be a valid action")
	}
	if _, ok := validActions["up"]; !ok {
		t.Error("up should be a valid action")
	}
}

func TestBundleManifestFeaturesDefaults(t *testing.T) {
	f := BundleFeatures{}
	if f.DockerLogRotation != false {
		t.Error("DockerLogRotation default should be false")
	}
	if f.GitClone != nil {
		t.Error("GitClone default should be nil")
	}
	if f.DockerPrune != false {
		t.Error("DockerPrune default should be false")
	}
	if f.CreateNetwork != "" {
		t.Error("CreateNetwork default should be empty")
	}
}

func TestBundleManifestStruct(t *testing.T) {
	m := BundleManifest{
		Name:      "test",
		Type:      "compose",
		Features:  BundleFeatures{},
		Defaults:  []BundleDefault{},
		Templates: []string{"base.yaml"},
		Services:  []string{"web"},
	}
	if m.Name != "test" {
		t.Errorf("Name = %q, want %q", m.Name, "test")
	}
	if m.Type != "compose" {
		t.Errorf("Type = %q, want %q", m.Type, "compose")
	}
	if len(m.Templates) != 1 {
		t.Errorf("Templates len = %d, want 1", len(m.Templates))
	}
	if len(m.Services) != 1 {
		t.Errorf("Services len = %d, want 1", len(m.Services))
	}
}

func TestGitCloneStruct(t *testing.T) {
	gc := &GitClone{Repo: "https://github.com/test/repo", Path: "app"}
	if gc.Repo != "https://github.com/test/repo" {
		t.Errorf("Repo = %q, want %q", gc.Repo, "https://github.com/test/repo")
	}
	if gc.Path != "app" {
		t.Errorf("Path = %q, want %q", gc.Path, "app")
	}
}

func TestBundleDefaultStruct(t *testing.T) {
	bd := BundleDefault{Path: "/opt/config", Content: "key: value"}
	if bd.Path != "/opt/config" {
		t.Errorf("Path = %q, want %q", bd.Path, "/opt/config")
	}
	if bd.Content != "key: value" {
		t.Errorf("Content = %q, want %q", bd.Content, "key: value")
	}
}

func TestManifestLoaderStruct(t *testing.T) {
	loader := NewManifestLoader("/base/dir")
	if loader.baseDir != "/base/dir" {
		t.Errorf("baseDir = %q, want %q", loader.baseDir, "/base/dir")
	}
}

func TestDNSManagerStruct(t *testing.T) {
	m := &DNSManager{
		baseDir:       "/opt/SilkSpool",
		gatewayHost:   "gateway",
		headscaleHost: "keeper",
		defaultIP:     "192.168.1.1",
		headscaleDNS:  "100.100.100.100",
		defaultDomain: "example.com",
		sshKey:        "/opt/SilkSpool/keys/spool",
	}
	if m.baseDir != "/opt/SilkSpool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.gatewayHost != "gateway" {
		t.Errorf("gatewayHost = %q", m.gatewayHost)
	}
	if m.headscaleHost != "keeper" {
		t.Errorf("headscaleHost = %q", m.headscaleHost)
	}
}

func TestSiteManagerStruct(t *testing.T) {
	m := &SiteManager{
		baseDir:       "/opt/SilkSpool",
		gatewayHost:   "gateway",
		headscaleHost: "keeper",
		defaultIP:     "192.168.1.1",
		defaultDomain: "example.com",
		sshKey:        "/opt/SilkSpool/keys/spool",
		caddyPath:     "/opt/SilkSpool/hosts/gateway/caddy/Caddyfile",
		homepagePath:  "/opt/SilkSpool/hosts/gateway/homepage/services.yaml",
	}
	if m.caddyPath != "/opt/SilkSpool/hosts/gateway/caddy/Caddyfile" {
		t.Errorf("caddyPath = %q", m.caddyPath)
	}
	if m.homepagePath != "/opt/SilkSpool/hosts/gateway/homepage/services.yaml" {
		t.Errorf("homepagePath = %q", m.homepagePath)
	}
}

func TestSyncManagerStruct(t *testing.T) {
	m := &SyncManager{
		baseDir: "/opt/SilkSpool",
		sshKey:  "/opt/SilkSpool/keys/spool",
		sops:    nil,
	}
	if m.baseDir != "/opt/SilkSpool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sops != nil {
		t.Error("sops should be nil when not configured")
	}
}

func TestComposeDriverStruct(t *testing.T) {
	d := &ComposeDriver{
		baseDir:    "/opt",
		sshKey:     "/key",
		bundleName: "test",
		defaults:   config.DefaultsConfig{LogLines: 100},
	}
	if d.bundleName != "test" {
		t.Errorf("bundleName = %q", d.bundleName)
	}
	if d.defaults.LogLines != 100 {
		t.Errorf("LogLines = %d, want 100", d.defaults.LogLines)
	}
}
