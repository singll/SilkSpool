package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// AdoptOptions 控制既有 stack 纳管行为。
type AdoptOptions struct {
	Bundle string
	Class  string
	DryRun bool
	Force  bool
}

// AdoptContainer 描述一个已存在的 compose 容器。
type AdoptContainer struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Service  string            `json:"service"`
	Image    string            `json:"image,omitempty"`
	State    string            `json:"state,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	Volumes  []string          `json:"volumes,omitempty"`
	Networks []string          `json:"networks,omitempty"`
	Stateful bool              `json:"stateful"`
}

// AdoptVolume 描述一个被发现的卷。
type AdoptVolume struct {
	Name   string            `json:"name"`
	Driver string            `json:"driver,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
}

// AdoptNetwork 描述一个被发现的网络。
type AdoptNetwork struct {
	Name   string            `json:"name"`
	Driver string            `json:"driver,omitempty"`
	Scope  string            `json:"scope,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
}

// AdoptReport 是 spool adopt 的结果。
type AdoptReport struct {
	Host         string           `json:"host"`
	Bundle       string           `json:"bundle"`
	Project      string           `json:"project"`
	DeployPath   string           `json:"deploy_path"`
	Containers   []AdoptContainer `json:"containers"`
	Volumes      []AdoptVolume    `json:"volumes"`
	Networks     []AdoptNetwork   `json:"networks"`
	Stateful     []string         `json:"stateful,omitempty"`
	ManifestPath string           `json:"manifest_path,omitempty"`
	StatePath    string           `json:"state_path,omitempty"`
	LockPath     string           `json:"lock_path,omitempty"`
	Written      bool             `json:"written"`
	DryRun       bool             `json:"dry_run"`
	Generation   int              `json:"generation,omitempty"`
	Warnings     []string         `json:"warnings"`
}

type dockerContainerInspect struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	Image string `json:"Image"`
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]struct {
			NetworkID string `json:"NetworkID"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

type dockerVolumeInspect struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Mountpoint string            `json:"Mountpoint"`
	Labels     map[string]string `json:"Labels"`
}

type dockerNetworkInspect struct {
	Name   string            `json:"Name"`
	Driver string            `json:"Driver"`
	Scope  string            `json:"Scope"`
	Labels map[string]string `json:"Labels"`
}

// Adopt 发现既有 compose stack，生成可重建的本地 manifest/state/lock。
// 只执行只读 docker 命令，不会 stop/start/recreate 任何容器。
func (m *Manager) Adopt(ctx context.Context, host string, opts AdoptOptions) (*AdoptReport, error) {
	if m.Runner == nil {
		return nil, fmt.Errorf("adopt requires a remote runner")
	}
	if m.Config == nil || m.Config.GetHost(host) == nil {
		return nil, fmt.Errorf("unknown host: %s", host)
	}
	if opts.Class == "" {
		opts.Class = "composition"
	}
	if err := ValidateBundleClass(opts.Class); err != nil {
		return nil, err
	}

	containers, projects, err := m.discoverContainers()
	if err != nil {
		return nil, err
	}
	project := strings.TrimSpace(opts.Bundle)
	if project == "" {
		if len(projects) == 0 {
			return nil, fmt.Errorf("no compose project found on %s", host)
		}
		if len(projects) > 1 {
			return nil, fmt.Errorf("multiple compose projects found on %s (%s); use --bundle <project>", host, strings.Join(projects, ", "))
		}
		project = projects[0]
	} else {
		matched := ""
		for _, candidate := range projects {
			if candidate == project || sanitizeBundleName(candidate) == sanitizeBundleName(project) {
				matched = candidate
				break
			}
		}
		if matched == "" {
			return nil, fmt.Errorf("compose project %s not found on %s (found: %s)", project, host, strings.Join(projects, ", "))
		}
		project = matched
	}
	bundle := sanitizeBundleName(project)
	if bundle == "" {
		return nil, fmt.Errorf("invalid compose project name %q", project)
	}

	var selected []dockerContainerInspect
	for _, container := range containers {
		if container.Config.Labels["com.docker.compose.project"] == project {
			selected = append(selected, container)
		}
	}
	if len(selected) == 0 {
		return nil, fmt.Errorf("no containers found for compose project %s", project)
	}
	sort.Slice(selected, func(i, j int) bool {
		return selected[i].Config.Labels["com.docker.compose.service"] < selected[j].Config.Labels["com.docker.compose.service"]
	})

	report := &AdoptReport{
		Host:       host,
		Bundle:     bundle,
		Project:    project,
		Containers: []AdoptContainer{},
		Volumes:    []AdoptVolume{},
		Networks:   []AdoptNetwork{},
		DryRun:     opts.DryRun,
		Warnings:   []string{},
	}
	report.DeployPath = selected[0].Config.Labels["com.docker.compose.project.working_dir"]
	if report.DeployPath == "" {
		report.DeployPath = ResolveDeployPath(m.BaseDir, m.Config, bundle, nil)
		report.Warnings = append(report.Warnings, "compose project has no working_dir label; using "+report.DeployPath)
	}

	volumeNames := map[string]bool{}
	networkNames := map[string]bool{}
	for _, container := range selected {
		item := AdoptContainer{
			ID:      container.ID,
			Name:    strings.TrimPrefix(container.Name, "/"),
			Service: container.Config.Labels["com.docker.compose.service"],
			Image:   container.Config.Image,
			State:   container.State.Status,
			Labels:  cloneStringMap(container.Config.Labels),
		}
		if item.Service == "" {
			item.Service = item.Name
		}
		for _, mount := range container.Mounts {
			if mount.Name != "" {
				item.Volumes = append(item.Volumes, mount.Name)
			} else if mount.Source != "" {
				item.Volumes = append(item.Volumes, mount.Source)
			}
			if mount.Type == "volume" && mount.Name != "" {
				volumeNames[mount.Name] = true
				item.Stateful = true
			}
			if mount.Type == "bind" && mount.Source != "" {
				item.Stateful = true
			}
		}
		for network := range container.NetworkSettings.Networks {
			item.Networks = append(item.Networks, network)
			networkNames[network] = true
		}
		sort.Strings(item.Volumes)
		sort.Strings(item.Networks)
		if item.Stateful {
			report.Stateful = append(report.Stateful, item.Service)
		}
		if generation, err := strconv.Atoi(item.Labels["io.silkspool.generation"]); err == nil && generation > report.Generation {
			report.Generation = generation
		}
		report.Containers = append(report.Containers, item)
	}
	sort.Strings(report.Stateful)
	report.Stateful = uniqueStrings(report.Stateful)

	volumes, warnings := m.discoverVolumes(project, volumeNames)
	report.Volumes = volumes
	report.Warnings = append(report.Warnings, warnings...)
	networks, warnings := m.discoverNetworks(project, networkNames)
	report.Networks = networks
	report.Warnings = append(report.Warnings, warnings...)

	composeFiles, composeContents, warnings, err := m.downloadAdoptCompose(selected, report.DeployPath)
	report.Warnings = append(report.Warnings, warnings...)
	if err != nil {
		return report, err
	}

	bundleRoot := ManifestBundleRoot(m.BaseDir, bundle)
	report.ManifestPath = filepath.Join(bundleRoot, "manifest.yaml")
	report.StatePath = StatePath(m.BaseDir, host, bundle)
	report.LockPath = LockPath(m.BaseDir, host, bundle)
	if !opts.Force {
		for _, path := range []string{report.ManifestPath, report.StatePath, report.LockPath} {
			if _, err := os.Stat(path); err == nil {
				return report, fmt.Errorf("%s already exists; refusing to overwrite adopted state without --force", path)
			}
		}
	}

	manifest := adoptManifest{
		APIVersion: "spool/v1alpha1",
		Kind:       "Bundle",
		Metadata: adoptMetadata{
			Name:  bundle,
			Class: opts.Class,
			Labels: map[string]string{
				"io.silkspool.adopted":         "true",
				"io.silkspool.compose-project": project,
			},
		},
		Name:       bundle,
		Type:       "compose",
		DeployPath: report.DeployPath,
		Templates:  composeFiles,
		Services:   containerServices(selected),
	}
	manifestData, err := yaml.Marshal(manifest)
	if err != nil {
		return report, err
	}

	var composeHashInput strings.Builder
	for _, name := range composeFiles {
		composeHashInput.WriteString(name)
		composeHashInput.WriteByte(0)
		composeHashInput.WriteString(composeContents[name])
		composeHashInput.WriteByte(0)
	}
	composeHash := "sha256:" + hashBytes([]byte(composeHashInput.String()))
	lock := &LockSnapshot{
		Version:    LockVersion,
		Host:       host,
		Bundle:     bundle,
		InputsHash: "sha256:" + hashBytes(nil),
		Resolved: ResolvedSnapshot{
			Components:   map[string]ResolvedComponent{},
			Dependencies: map[string]ResolvedDependency{},
		},
		Rendered:  RenderedSnapshot{ComposeSHA256: composeHash},
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	for _, container := range selected {
		service := container.Config.Labels["com.docker.compose.service"]
		if service == "" {
			continue
		}
		version := container.Config.Labels["io.silkspool.version"]
		lock.Resolved.Components[service] = ResolvedComponent{
			Host:     host,
			Version:  version,
			Image:    container.Config.Image,
			Services: []string{service},
			Outputs:  map[string]ResolvedOutput{},
		}
	}
	lock.LockHash = computeLockHash(lock)

	state := &LocalState{
		Host:        host,
		Bundle:      bundle,
		Generation:  report.Generation,
		Status:      "adopted",
		LockHash:    lock.LockHash,
		ComposeHash: composeHash,
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339),
	}

	if opts.DryRun {
		return report, nil
	}
	if err := os.MkdirAll(filepath.Join(bundleRoot, "templates"), 0755); err != nil {
		return report, err
	}
	for _, name := range composeFiles {
		if err := os.WriteFile(filepath.Join(bundleRoot, "templates", name), []byte(composeContents[name]), 0644); err != nil {
			return report, err
		}
	}
	if err := os.WriteFile(report.ManifestPath, manifestData, 0644); err != nil {
		return report, err
	}
	if err := WriteLocalState(m.BaseDir, state); err != nil {
		return report, err
	}
	if _, err := WriteLock(m.BaseDir, lock); err != nil {
		return report, err
	}
	report.Written = true
	return report, nil
}

func (m *Manager) discoverContainers() ([]dockerContainerInspect, []string, error) {
	idsOut, err := m.Runner.Exec("docker ps -aq --filter label=com.docker.compose.project")
	if err != nil {
		return nil, nil, fmt.Errorf("discover compose containers: %w", err)
	}
	ids := strings.Fields(idsOut)
	if len(ids) == 0 {
		return nil, nil, fmt.Errorf("no compose-managed containers found")
	}
	quoted := make([]string, 0, len(ids))
	for _, id := range ids {
		quoted = append(quoted, shellQuote(id))
	}
	inspectOut, err := m.Runner.Exec("docker inspect " + strings.Join(quoted, " "))
	if err != nil {
		return nil, nil, fmt.Errorf("inspect compose containers: %w", err)
	}
	var containers []dockerContainerInspect
	if err := json.Unmarshal([]byte(inspectOut), &containers); err != nil {
		return nil, nil, fmt.Errorf("parse docker inspect output: %w", err)
	}
	projectSet := map[string]bool{}
	for _, container := range containers {
		if project := container.Config.Labels["com.docker.compose.project"]; project != "" {
			projectSet[project] = true
		}
	}
	projects := make([]string, 0, len(projectSet))
	for project := range projectSet {
		projects = append(projects, project)
	}
	sort.Strings(projects)
	return containers, projects, nil
}

func (m *Manager) discoverVolumes(project string, names map[string]bool) ([]AdoptVolume, []string) {
	cmd := fmt.Sprintf("docker volume ls -q --filter label=com.docker.compose.project=%s", shellQuote(project))
	if out, err := m.Runner.Exec(cmd); err == nil {
		for _, name := range strings.Fields(out) {
			names[name] = true
		}
	}
	if len(names) == 0 {
		return []AdoptVolume{}, nil
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	quoted := make([]string, 0, len(sorted))
	for _, name := range sorted {
		quoted = append(quoted, shellQuote(name))
	}
	var warnings []string
	out, err := m.Runner.Exec("docker volume inspect " + strings.Join(quoted, " "))
	if err != nil {
		return []AdoptVolume{}, []string{fmt.Sprintf("inspect volumes: %v", err)}
	}
	var inspected []dockerVolumeInspect
	if err := json.Unmarshal([]byte(out), &inspected); err != nil {
		return []AdoptVolume{}, []string{fmt.Sprintf("parse volume inspect output: %v", err)}
	}
	result := make([]AdoptVolume, 0, len(inspected))
	for _, volume := range inspected {
		result = append(result, AdoptVolume{Name: volume.Name, Driver: volume.Driver, Labels: volume.Labels})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, warnings
}

func (m *Manager) discoverNetworks(project string, names map[string]bool) ([]AdoptNetwork, []string) {
	cmd := fmt.Sprintf("docker network ls -q --filter label=com.docker.compose.project=%s", shellQuote(project))
	if out, err := m.Runner.Exec(cmd); err == nil {
		for _, name := range strings.Fields(out) {
			names[name] = true
		}
	}
	// docker network ls -q returns IDs; always inspect the IDs we found plus container network names.
	quoted := make([]string, 0, len(names))
	for name := range names {
		quoted = append(quoted, shellQuote(name))
	}
	if len(quoted) == 0 {
		return []AdoptNetwork{}, nil
	}
	sort.Strings(quoted)
	out, err := m.Runner.Exec("docker network inspect " + strings.Join(quoted, " "))
	if err != nil {
		return []AdoptNetwork{}, []string{fmt.Sprintf("inspect networks: %v", err)}
	}
	var inspected []dockerNetworkInspect
	if err := json.Unmarshal([]byte(out), &inspected); err != nil {
		return []AdoptNetwork{}, []string{fmt.Sprintf("parse network inspect output: %v", err)}
	}
	seen := map[string]bool{}
	result := make([]AdoptNetwork, 0, len(inspected))
	for _, network := range inspected {
		if seen[network.Name] {
			continue
		}
		seen[network.Name] = true
		result = append(result, AdoptNetwork{Name: network.Name, Driver: network.Driver, Scope: network.Scope, Labels: network.Labels})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (m *Manager) downloadAdoptCompose(containers []dockerContainerInspect, deployPath string) ([]string, map[string]string, []string, error) {
	configFiles := []string{}
	for _, container := range containers {
		raw := container.Config.Labels["com.docker.compose.project.config_files"]
		if strings.TrimSpace(raw) == "" {
			continue
		}
		for _, value := range strings.Split(raw, ",") {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			if !filepath.IsAbs(value) && deployPath != "" {
				value = filepath.Join(deployPath, value)
			}
			configFiles = append(configFiles, value)
		}
		if len(configFiles) > 0 {
			break
		}
	}
	if len(configFiles) == 0 {
		configFiles = []string{filepath.Join(deployPath, "docker-compose.yaml")}
	}
	seen := map[string]bool{}
	templates := []string{}
	contents := map[string]string{}
	var warnings []string
	for _, remote := range configFiles {
		if seen[remote] {
			continue
		}
		seen[remote] = true
		content, err := m.Runner.ReadFile(remote)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("read remote compose file %s: %v", remote, err))
			continue
		}
		name := filepath.Base(remote)
		if name == "" || name == "." || name == "/" {
			warnings = append(warnings, fmt.Sprintf("ignore compose file with invalid name %s", remote))
			continue
		}
		if containsString(templates, name) {
			warnings = append(warnings, fmt.Sprintf("duplicate compose basename %s from %s; skipped", name, remote))
			continue
		}
		templates = append(templates, name)
		contents[name] = content
	}
	if len(templates) == 0 {
		return nil, nil, warnings, fmt.Errorf("no readable compose files found for adoption under %s", deployPath)
	}
	return templates, contents, warnings, nil
}

func containerServices(containers []dockerContainerInspect) []string {
	set := map[string]bool{}
	for _, container := range containers {
		if service := container.Config.Labels["com.docker.compose.service"]; service != "" {
			set[service] = true
		}
	}
	services := make([]string, 0, len(set))
	for service := range set {
		services = append(services, service)
	}
	sort.Strings(services)
	return services
}

func sanitizeBundleName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, value)
	return strings.Trim(value, "-_")
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

type adoptManifest struct {
	APIVersion string        `yaml:"apiVersion"`
	Kind       string        `yaml:"kind"`
	Metadata   adoptMetadata `yaml:"metadata"`
	Name       string        `yaml:"name"`
	Type       string        `yaml:"type"`
	DeployPath string        `yaml:"deploy_path"`
	Templates  []string      `yaml:"templates"`
	Services   []string      `yaml:"services"`
}

type adoptMetadata struct {
	Name   string            `yaml:"name"`
	Class  string            `yaml:"class"`
	Labels map[string]string `yaml:"labels"`
}
