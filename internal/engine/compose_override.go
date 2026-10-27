package engine

import (
	"sort"
	"strconv"

	"gopkg.in/yaml.v3"
)

// overrideOptions 是 spool 注入项的完整描述。
type overrideOptions struct {
	Host       string
	Bundle     string
	Version    string
	Generation int
	LockHash   string
	Services   map[string]ServiceSpec
	Env        map[string]map[string]string
	ExtraHosts map[string][]string
	Images     map[string]string
	DependsOn  map[string][]string
}

// renderSpoolOverrideWithOptions 生成只含 spool 注入项的 compose override。
func renderSpoolOverrideWithOptions(opts overrideOptions) ([]byte, error) {
	names := make([]string, 0, len(opts.Services))
	for name := range opts.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	services := make(map[string]interface{}, len(names))
	for _, name := range names {
		spec := opts.Services[name]
		component := spec.Component
		if component == "" {
			component = name
		}
		labels := map[string]string{
			"io.silkspool.managed":   "true",
			"io.silkspool.host":      opts.Host,
			"io.silkspool.bundle":    opts.Bundle,
			"io.silkspool.component": component,
		}
		if opts.Version != "" {
			labels["io.silkspool.version"] = opts.Version
		}
		if opts.Generation > 0 {
			labels["io.silkspool.generation"] = strconv.Itoa(opts.Generation)
		}
		if opts.LockHash != "" {
			labels["io.silkspool.lock-hash"] = opts.LockHash
		}

		entry := map[string]interface{}{"labels": labels}
		if env := opts.Env[name]; len(env) > 0 {
			entry["environment"] = env
		}
		if hosts := opts.ExtraHosts[name]; len(hosts) > 0 {
			entry["extra_hosts"] = hosts
		}
		if image := opts.Images[name]; image != "" {
			entry["image"] = image
		}
		if deps := opts.DependsOn[name]; len(deps) > 0 {
			depends := map[string]interface{}{}
			for _, dep := range deps {
				depends[dep] = map[string]string{"condition": "service_started"}
			}
			entry["depends_on"] = depends
		}
		services[name] = entry
	}

	return yaml.Marshal(map[string]interface{}{"services": services})
}

// renderSpoolOverride 是旧调用入口：保留原有行为（仅标签）。
func renderSpoolOverride(templates [][]byte, host, bundle, version string) ([]byte, error) {
	services := map[string]ServiceSpec{}
	for _, data := range templates {
		parsed, err := parseComposeServices(data)
		if err != nil {
			return nil, err
		}
		for name := range parsed {
			services[name] = ServiceSpec{Name: name, Component: name}
		}
	}
	return renderSpoolOverrideWithOptions(overrideOptions{
		Host:     host,
		Bundle:   bundle,
		Version:  version,
		Services: services,
	})
}
