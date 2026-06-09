package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

// N8NClient n8n API 客户端
type N8NClient struct {
	baseURL    string
	apiKey     string
	hostConn   string
	sshKey     string
	httpClient *http.Client
}

// N8NWorkflow n8n 工作流结构
type N8NWorkflow struct {
	ID          string                 `json:"id,omitempty"`
	Name        string                 `json:"name"`
	Active      bool                   `json:"active,omitempty"`
	Nodes       []N8NNode              `json:"nodes,omitempty"`
	Connections map[string]interface{} `json:"connections,omitempty"`
	Settings    map[string]interface{} `json:"settings,omitempty"`
}

// N8NNode 工作流节点
type N8NNode struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Type        string                 `json:"type"`
	TypeVersion float64                `json:"typeVersion,omitempty"`
	Position    []int                  `json:"position"`
	Data        map[string]interface{} `json:"data,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Credentials map[string]interface{} `json:"credentials,omitempty"`
}

// NewN8NClient 创建 n8n 客户端
func NewN8NClient(baseDir string, hostAlias string) (*N8NClient, error) {
	// 加载 n8n 配置
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// 加载 API Key
	apiKey := config.GetEnvVar("N8N_API_KEY", cfg.N8N.Host, baseDir)
	if apiKey == "" {
		return nil, fmt.Errorf("N8N_API_KEY not found in hosts/%s/.env", cfg.N8N.Host)
	}

	// 获取 SSH 连接信息
	hostCfg := cfg.GetHost(cfg.N8N.Host)
	if hostCfg == nil {
		return nil, fmt.Errorf("host %s not found", cfg.N8N.Host)
	}

	// SSH 密钥路径
	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)

	return &N8NClient{
		baseURL:  cfg.N8N.APIURL,
		apiKey:   apiKey,
		hostConn: hostCfg.Address,
		sshKey:   sshKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// doRequest 发送 HTTP 请求
func (c *N8NClient) doRequest(ctx context.Context, method, endpoint string, body interface{}) ([]byte, error) {
	var bodyBytes []byte
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal body: %w", err)
		}
		bodyBytes = data
	}

	if c.shouldUseRemoteAPI() {
		return c.doRemoteRequest(method, endpoint, bodyBytes)
	}

	var reqBody io.Reader
	if bodyBytes != nil {
		reqBody = bytes.NewReader(bodyBytes)
	}

	url := c.baseURL + "/api/v1" + endpoint
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-N8N-API-KEY", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return handleN8NResponse(resp.StatusCode, respBody)
}

func (c *N8NClient) shouldUseRemoteAPI() bool {
	parsed, err := neturl.Parse(c.baseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return c.hostConn != "" && c.sshKey != "" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
}

func (c *N8NClient) doRemoteRequest(method, endpoint string, body []byte) ([]byte, error) {
	requestURL := strings.TrimRight(c.baseURL, "/") + "/api/v1" + endpoint
	bodyB64 := ""
	if len(body) > 0 {
		bodyB64 = base64.StdEncoding.EncodeToString(body)
	}

	script := fmt.Sprintf(`set -u
url=%s
method=%s
api_key=%s
body_b64=%s
body_file="$(mktemp)"
resp_file="$(mktemp)"
err_file="$(mktemp)"
cleanup() {
  rm -f "$body_file" "$resp_file" "$err_file"
}
trap cleanup EXIT

if [ -n "$body_b64" ]; then
  printf '%%s' "$body_b64" | base64 -d > "$body_file"
fi

if [ -n "$body_b64" ]; then
  status="$(curl -sS -o "$resp_file" -w '%%{http_code}' -X "$method" "$url" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H "X-N8N-API-KEY: $api_key" \
    --data-binary "@$body_file" 2>"$err_file")"
else
  status="$(curl -sS -o "$resp_file" -w '%%{http_code}' -X "$method" "$url" \
    -H 'Accept: application/json' \
    -H "X-N8N-API-KEY: $api_key" 2>"$err_file")"
fi
curl_rc=$?

printf '__SPOOL_HTTP_STATUS__:%%s\n' "$status"
printf '__SPOOL_CURL_STATUS__:%%s\n' "$curl_rc"
printf '__SPOOL_CURL_ERROR__:'
tr '\n' ' ' < "$err_file"
printf '\n__SPOOL_BODY_BEGIN__\n'
cat "$resp_file"
exit 0
`, shellQuote(requestURL), shellQuote(method), shellQuote(c.apiKey), shellQuote(bodyB64))

	output, err := engine.SSHExecute(c.hostConn, c.sshKey, script)
	if err != nil {
		return nil, fmt.Errorf("remote n8n request failed: %w", err)
	}

	statusCode, curlCode, curlErr, respBody, err := parseRemoteHTTPOutput(output)
	if err != nil {
		return nil, err
	}
	if curlCode != 0 {
		if curlErr != "" {
			return nil, fmt.Errorf("remote curl failed (%d): %s", curlCode, curlErr)
		}
		return nil, fmt.Errorf("remote curl failed (%d)", curlCode)
	}

	return handleN8NResponse(statusCode, respBody)
}

func parseRemoteHTTPOutput(output string) (statusCode int, curlCode int, curlErr string, body []byte, err error) {
	const bodyMarker = "\n__SPOOL_BODY_BEGIN__\n"
	parts := strings.SplitN(output, bodyMarker, 2)
	if len(parts) != 2 {
		err = fmt.Errorf("remote n8n request returned malformed output")
		return
	}

	statusCode = -1
	curlCode = -1
	for _, line := range strings.Split(parts[0], "\n") {
		switch {
		case strings.HasPrefix(line, "__SPOOL_HTTP_STATUS__:"):
			value := strings.TrimSpace(strings.TrimPrefix(line, "__SPOOL_HTTP_STATUS__:"))
			if value == "" {
				value = "0"
			}
			statusCode, err = strconv.Atoi(value)
			if err != nil {
				err = fmt.Errorf("invalid remote HTTP status %q: %w", value, err)
				return
			}
		case strings.HasPrefix(line, "__SPOOL_CURL_STATUS__:"):
			value := strings.TrimSpace(strings.TrimPrefix(line, "__SPOOL_CURL_STATUS__:"))
			curlCode, err = strconv.Atoi(value)
			if err != nil {
				err = fmt.Errorf("invalid remote curl status %q: %w", value, err)
				return
			}
		case strings.HasPrefix(line, "__SPOOL_CURL_ERROR__:"):
			curlErr = strings.TrimSpace(strings.TrimPrefix(line, "__SPOOL_CURL_ERROR__:"))
		}
	}
	if statusCode < 0 {
		err = fmt.Errorf("remote n8n request did not return HTTP status")
		return
	}
	if curlCode < 0 {
		err = fmt.Errorf("remote n8n request did not return curl status")
		return
	}

	body = []byte(parts[1])
	return
}

func handleN8NResponse(statusCode int, respBody []byte) ([]byte, error) {
	if statusCode >= 400 || statusCode == 0 {
		var errResp struct {
			Message string `json:"message"`
		}
		json.Unmarshal(respBody, &errResp)
		if errResp.Message != "" {
			return nil, fmt.Errorf("API error (%d): %s", statusCode, errResp.Message)
		}
		return nil, fmt.Errorf("API error: %d - %s", statusCode, string(respBody))
	}

	return respBody, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

// ListWorkflows 列出所有工作流
func (c *N8NClient) ListWorkflows(ctx context.Context) ([]N8NWorkflow, error) {
	data, err := c.doRequest(ctx, "GET", "/workflows", nil)
	if err != nil {
		return nil, err
	}

	var result struct {
		Data []N8NWorkflow `json:"data"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return result.Data, nil
}

// GetWorkflow 获取单个工作流
func (c *N8NClient) GetWorkflow(ctx context.Context, id string) (*N8NWorkflow, error) {
	data, err := c.doRequest(ctx, "GET", "/workflows/"+id, nil)
	if err != nil {
		return nil, err
	}

	var workflow N8NWorkflow
	if err := json.Unmarshal(data, &workflow); err != nil {
		return nil, fmt.Errorf("failed to parse workflow: %w", err)
	}

	return &workflow, nil
}

// CreateWorkflow 创建工作流
func (c *N8NClient) CreateWorkflow(ctx context.Context, workflow *N8NWorkflow) (*N8NWorkflow, error) {
	// 清理工作流数据
	cleanWF := cleanWorkflowForCreate(workflow)

	data, err := c.doRequest(ctx, "POST", "/workflows", cleanWF)
	if err != nil {
		return nil, err
	}

	var result N8NWorkflow
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}

// UpdateWorkflow 更新工作流
func (c *N8NClient) UpdateWorkflow(ctx context.Context, id string, workflow *N8NWorkflow) (*N8NWorkflow, error) {
	cleanWF := cleanWorkflowForUpdate(workflow)

	data, err := c.doRequest(ctx, "PUT", "/workflows/"+id, cleanWF)
	if err != nil {
		return nil, err
	}

	var result N8NWorkflow
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}

// ActivateWorkflow 激活工作流
func (c *N8NClient) ActivateWorkflow(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, "POST", "/workflows/"+id+"/activate", nil)
	return err
}

// DeactivateWorkflow 停用工作流
func (c *N8NClient) DeactivateWorkflow(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, "POST", "/workflows/"+id+"/deactivate", nil)
	return err
}

// DeleteWorkflow 删除工作流
func (c *N8NClient) DeleteWorkflow(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, "DELETE", "/workflows/"+id, nil)
	return err
}

// cleanWorkflowForCreate 清理工作流数据（创建时）
func cleanWorkflowForCreate(wf *N8NWorkflow) *N8NWorkflow {
	clean := &N8NWorkflow{
		Name:        wf.Name,
		Nodes:       wf.Nodes,
		Connections: wf.Connections,
		Settings:    workflowSettingsWithDefault(wf.Settings),
	}
	return clean
}

// cleanWorkflowForUpdate 清理工作流数据（更新时）
func cleanWorkflowForUpdate(wf *N8NWorkflow) *N8NWorkflow {
	clean := &N8NWorkflow{
		Name:        wf.Name,
		Nodes:       wf.Nodes,
		Connections: wf.Connections,
		Settings:    workflowSettingsWithDefault(wf.Settings),
	}
	return clean
}

func workflowSettingsWithDefault(settings map[string]interface{}) map[string]interface{} {
	clean := make(map[string]interface{}, len(settings)+1)
	for key, value := range settings {
		clean[key] = value
	}
	if _, ok := clean["executionOrder"]; !ok {
		clean["executionOrder"] = "v1"
	}
	return clean
}

// LoadWorkflowFromFile 从文件加载工作流
func LoadWorkflowFromFile(path string) (*N8NWorkflow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	var wf N8NWorkflow
	if err := json.Unmarshal(data, &wf); err != nil {
		return nil, fmt.Errorf("failed to parse workflow JSON: %w", err)
	}

	if wf.Name == "" {
		// 从文件名提取名称
		name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		// 跳过 00-config.json
		if name == "00-config" {
			return nil, fmt.Errorf("skipping config reference: %s", path)
		}
		wf.Name = name
	}

	return &wf, nil
}

// N8NManager n8n 工作流管理器
type N8NManager struct {
	client *N8NClient
}

// NewN8NManager 创建管理器
func NewN8NManager(baseDir string) (*N8NManager, error) {
	client, err := NewN8NClient(baseDir, "")
	if err != nil {
		return nil, err
	}
	return &N8NManager{client: client}, nil
}

// Close 关闭管理器
func (m *N8NManager) Close() error {
	// N8NClient 使用 HTTP，不需要关闭连接
	return nil
}

// ListLocalWorkflows 列出本地工作流文件
func (m *N8NManager) ListLocalWorkflows(workflowDir string) ([]string, error) {
	entries, err := os.ReadDir(workflowDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read workflow dir: %w", err)
	}

	var files []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) == ".json" && name != "00-config.json" {
			files = append(files, filepath.Join(workflowDir, name))
		}
	}
	return files, nil
}

// ListRemoteWorkflows 列出远程工作流文件
func (m *N8NManager) ListRemoteWorkflows(remoteDir string) ([]string, error) {
	// 使用 SSH 执行 ls 命令
	return nil, fmt.Errorf("not implemented: use SSH directly")
}

// ImportWorkflows 导入工作流
func (m *N8NManager) ImportWorkflows(ctx context.Context, workflowDir string) error {
	// 获取 n8n 中已存在的工作流
	existing, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return fmt.Errorf("failed to list existing workflows: %w", err)
	}

	existingNames := make(map[string]string) // name -> id
	for _, wf := range existing {
		existingNames[wf.Name] = wf.ID
	}

	// 列出本地文件
	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		return err
	}

	var imported, skipped, failed int

	for _, file := range files {
		wf, err := LoadWorkflowFromFile(file)
		if err != nil {
			utils.Warn("Skipping: %s (%v)", file, err)
			failed++
			continue
		}

		if _, exists := existingNames[wf.Name]; exists {
			utils.Warn("Skipping existing: %s", wf.Name)
			skipped++
			continue
		}

		result, err := m.client.CreateWorkflow(ctx, wf)
		if err != nil {
			utils.Error("Failed to import %s: %v", wf.Name, err)
			failed++
			continue
		}

		utils.Success("Imported: %s (id: %s)", wf.Name, result.ID)
		imported++
	}

	utils.Info("Import completed: %d imported, %d skipped, %d failed", imported, skipped, failed)
	return nil
}

// ExportWorkflows 导出工作流到备份目录
func (m *N8NManager) ExportWorkflows(ctx context.Context, backupDir string) error {
	workflows, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return fmt.Errorf("failed to list workflows: %w", err)
	}

	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return fmt.Errorf("failed to create backup dir: %w", err)
	}

	for _, wf := range workflows {
		fullWorkflow := &wf
		if wf.ID != "" {
			if detailed, err := m.client.GetWorkflow(ctx, wf.ID); err == nil {
				fullWorkflow = detailed
			} else {
				utils.Warn("Failed to fetch full workflow %s, exporting list payload: %v", wf.Name, err)
			}
		}

		filename := filepath.Join(backupDir, sanitizeFilename(fullWorkflow.Name)+".json")
		data, err := json.MarshalIndent(fullWorkflow, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal workflow %s: %w", fullWorkflow.Name, err)
		}

		if err := os.WriteFile(filename, data, 0644); err != nil {
			return fmt.Errorf("failed to write %s: %w", filename, err)
		}
		utils.Success("Exported: %s", fullWorkflow.Name)
	}

	return nil
}

// sanitizeFilename 清理文件名
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.ReplaceAll(name, "\\", "-")
	name = strings.ReplaceAll(name, ":", "-")
	return name
}

// UpdateWorkflows 更新工作流: 已存在则更新，不存在则创建。names 为空时更新全部。
func (m *N8NManager) UpdateWorkflows(ctx context.Context, workflowDir string, names ...string) error {
	existing, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return fmt.Errorf("failed to list existing workflows: %w", err)
	}
	existingByName := make(map[string]N8NWorkflow) // name -> workflow
	for _, wf := range existing {
		existingByName[wf.Name] = wf
	}

	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		return err
	}

	targets := make(map[string]struct{}, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		targets[name] = struct{}{}
		targets[strings.TrimSuffix(name, filepath.Ext(name))] = struct{}{}
	}

	var updated, created, failed int
	var matched int
	for _, file := range files {
		wf, err := LoadWorkflowFromFile(file)
		if err != nil {
			utils.Warn("Skipping: %s (%v)", file, err)
			failed++
			continue
		}
		if len(targets) > 0 && !workflowMatchesTargets(file, wf, targets) {
			continue
		}
		matched++

		if remote, ok := existingByName[wf.Name]; ok {
			if _, err := m.client.UpdateWorkflow(ctx, remote.ID, wf); err != nil {
				utils.Error("Failed to update %s: %v", wf.Name, err)
				failed++
				continue
			}
			utils.Success("Updated: %s", wf.Name)
			updated++
		} else {
			result, err := m.client.CreateWorkflow(ctx, wf)
			if err != nil {
				utils.Error("Failed to create %s: %v", wf.Name, err)
				failed++
				continue
			}
			utils.Success("Created: %s (id: %s)", wf.Name, result.ID)
			created++
		}
	}

	if len(targets) > 0 && matched == 0 {
		return fmt.Errorf("no local workflow matched: %s", strings.Join(names, ", "))
	}

	utils.Info("Update completed: %d updated, %d created, %d failed", updated, created, failed)
	return nil
}

func workflowMatchesTargets(file string, wf *N8NWorkflow, targets map[string]struct{}) bool {
	fileName := filepath.Base(file)
	fileKey := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	_, byName := targets[wf.Name]
	_, byFile := targets[fileName]
	_, byKey := targets[fileKey]
	return byName || byFile || byKey
}

// findWorkflowID 按名称查找工作流 ID
func (m *N8NManager) findWorkflowID(ctx context.Context, name string) (string, error) {
	workflows, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return "", err
	}
	for _, wf := range workflows {
		if wf.Name == name {
			return wf.ID, nil
		}
	}
	return "", fmt.Errorf("workflow not found: %s", name)
}

// ActivateWorkflow 激活工作流 (name 为空则激活全部)
func (m *N8NManager) ActivateWorkflow(ctx context.Context, name string) error {
	if name == "" {
		workflows, err := m.client.ListWorkflows(ctx)
		if err != nil {
			return err
		}
		var n int
		for _, wf := range workflows {
			if wf.Active {
				continue
			}
			if err := m.client.ActivateWorkflow(ctx, wf.ID); err != nil {
				utils.Warn("Activate %s failed: %v", wf.Name, err)
				continue
			}
			utils.Success("Activated: %s", wf.Name)
			n++
		}
		utils.Info("Activated %d workflows", n)
		return nil
	}

	id, err := m.findWorkflowID(ctx, name)
	if err != nil {
		return err
	}
	if err := m.client.ActivateWorkflow(ctx, id); err != nil {
		return err
	}
	utils.Success("Activated: %s", name)
	return nil
}

// DeactivateWorkflow 停用工作流
func (m *N8NManager) DeactivateWorkflow(ctx context.Context, name string) error {
	id, err := m.findWorkflowID(ctx, name)
	if err != nil {
		return err
	}
	if err := m.client.DeactivateWorkflow(ctx, id); err != nil {
		return err
	}
	utils.Success("Deactivated: %s", name)
	return nil
}

// DeleteWorkflow 删除工作流
func (m *N8NManager) DeleteWorkflow(ctx context.Context, name string) error {
	id, err := m.findWorkflowID(ctx, name)
	if err != nil {
		return err
	}
	if err := m.client.DeleteWorkflow(ctx, id); err != nil {
		return err
	}
	utils.Success("Deleted: %s", name)
	return nil
}
