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
	"github.com/singll/silkspool/pkg/utils"
)

// N8NClient n8n API 客户端
type N8NClient struct {
	baseURL     string
	apiKey      string
	hostConn    string
	sshKey      string
	httpClient  *http.Client
	sshProvider SSHProvider
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

// N8NNode 工作流节点。
//
// 除显式建模的字段外，所有未知字段经 extra 原样保留并在序列化时写回，
// 确保 update/export 的 round-trip 无损：webhookId、onError、disabled、notes、
// continueOnFail、alwaysOutputData、retryOnFail 等节点级字段不会再被静默丢弃。
// （历史 bug：webhookId 被丢弃 → n8n 退化注册到 {workflowId}/webhook/{path} 畸形路径。）
type N8NNode struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Type        string                 `json:"type"`
	TypeVersion float64                `json:"typeVersion,omitempty"`
	Position    []int                  `json:"position"`
	Data        map[string]interface{} `json:"data,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Credentials map[string]interface{} `json:"credentials,omitempty"`
	// extra 保存所有未显式建模的节点字段，原样透传，对 n8n 未来新增字段免疫。
	extra map[string]json.RawMessage
}

// knownNodeFields 为 N8NNode 显式建模字段的 JSON key，UnmarshalJSON 据此剔除已知字段、
// 剩余即 extra。新增显式字段时务必同步此列表。
var knownNodeFields = []string{"id", "name", "type", "typeVersion", "position", "data", "parameters", "credentials"}

// UnmarshalJSON 解析显式字段，并把其余未知字段收集进 extra 以便无损写回。
func (n *N8NNode) UnmarshalJSON(data []byte) error {
	type alias N8NNode // alias 不带自定义方法，避免无限递归；extra 未导出，json 自动忽略
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*n = N8NNode(a)

	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for _, k := range knownNodeFields {
		delete(all, k)
	}
	if len(all) > 0 {
		n.extra = all
	}
	return nil
}

// MarshalJSON 先序列化显式字段，再合并 extra 中的未知字段（已存在的 key 不覆盖）。
func (n N8NNode) MarshalJSON() ([]byte, error) {
	type alias N8NNode // 仅序列化导出字段（extra 未导出，被忽略）
	kb, err := json.Marshal(alias(n))
	if err != nil {
		return nil, err
	}
	if len(n.extra) == 0 {
		return kb, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(kb, &merged); err != nil {
		return nil, err
	}
	for k, v := range n.extra {
		if _, ok := merged[k]; !ok {
			merged[k] = v
		}
	}
	return json.Marshal(merged)
}

// NewN8NClient 创建 n8n 客户端
func NewN8NClient(baseDir string, hostAlias string, sshProvider SSHProvider) (*N8NClient, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	apiKey := config.GetEnvVar("N8N_API_KEY", cfg.N8N.Host, baseDir)
	if apiKey == "" {
		return nil, fmt.Errorf("N8N_API_KEY not found in hosts/%s/.env", cfg.N8N.Host)
	}

	hostCfg := cfg.GetHost(cfg.N8N.Host)
	if hostCfg == nil {
		return nil, fmt.Errorf("host %s not found", cfg.N8N.Host)
	}

	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)

	httpTimeout := config.ParseDuration(cfg.Global.Timeouts.HTTPClient, 30*time.Second)

	return &N8NClient{
		baseURL:     cfg.N8N.APIURL,
		apiKey:      apiKey,
		hostConn:    hostCfg.Address,
		sshKey:      sshKey,
		sshProvider: sshProvider,
		httpClient: &http.Client{
			Timeout: httpTimeout,
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

	output, err := c.sshProvider.Execute(c.hostConn, c.sshKey, script)
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
	client      *N8NClient
	sshProvider SSHProvider
}

func NewN8NManager(baseDir string, sshProvider SSHProvider) (*N8NManager, error) {
	client, err := NewN8NClient(baseDir, "", sshProvider)
	if err != nil {
		return nil, err
	}
	return &N8NManager{client: client, sshProvider: sshProvider}, nil
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

// ExportWorkflowsToSource 把 n8n 中的工作流回写到 git 受管的源目录（hosts/<host>/n8n-workflows/）。
//
// 与 ExportWorkflows（写时间戳备份目录、按工作流名命名）不同，本函数按工作流 name
// 匹配源目录里**已存在**的文件并原地覆盖，从而保留源文件名（源文件名遵循 K02-rss-collect
// 这类英文短名规范，而工作流 name 字段是 K02-RSS定时采集 这类中文名，二者不一致）。
// 配合无损 round-trip（extra 字段透传），可直接从线上实例刷新源真相文件后提交。
// 远端存在但本地没有对应文件的工作流，按 sanitizeFilename(name) 落为新文件并告警，提醒补命名规范。
func (m *N8NManager) ExportWorkflowsToSource(ctx context.Context, workflowDir string) error {
	workflows, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return fmt.Errorf("failed to list workflows: %w", err)
	}

	if err := os.MkdirAll(workflowDir, 0755); err != nil {
		return fmt.Errorf("failed to create workflow dir: %w", err)
	}

	fileByName, err := m.mapLocalFilesByName(workflowDir)
	if err != nil {
		return err
	}

	var written, fresh int
	for _, wf := range workflows {
		fullWorkflow := &wf
		if wf.ID != "" {
			if detailed, err := m.client.GetWorkflow(ctx, wf.ID); err == nil {
				fullWorkflow = detailed
			} else {
				utils.Warn("Failed to fetch full workflow %s, exporting list payload: %v", wf.Name, err)
			}
		}

		data, err := json.MarshalIndent(fullWorkflow, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal workflow %s: %w", fullWorkflow.Name, err)
		}

		if path, ok := fileByName[fullWorkflow.Name]; ok {
			if err := os.WriteFile(path, data, 0644); err != nil {
				return fmt.Errorf("failed to write %s: %w", path, err)
			}
			utils.Success("Updated source: %s -> %s", fullWorkflow.Name, filepath.Base(path))
			written++
		} else {
			path := filepath.Join(workflowDir, sanitizeFilename(fullWorkflow.Name)+".json")
			if err := os.WriteFile(path, data, 0644); err != nil {
				return fmt.Errorf("failed to write %s: %w", path, err)
			}
			utils.Warn("New source file (建议改名以符合命名规范): %s", filepath.Base(path))
			fresh++
		}
	}

	utils.Info("Export-to-source completed: %d updated, %d new", written, fresh)
	return nil
}

// mapLocalFilesByName 加载源目录下每个工作流文件，返回 工作流name -> 文件路径 的映射。
func (m *N8NManager) mapLocalFilesByName(workflowDir string) (map[string]string, error) {
	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]string, len(files))
	for _, file := range files {
		wf, err := LoadWorkflowFromFile(file)
		if err != nil {
			utils.Warn("Skipping (无法解析): %s (%v)", file, err)
			continue
		}
		byName[wf.Name] = file
	}
	return byName, nil
}

// sanitizeFilename 清理文件名
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.ReplaceAll(name, "\\", "-")
	name = strings.ReplaceAll(name, ":", "-")
	return name
}

// UpdateAction 描述一个工作流在 update 时的处置。
type UpdateAction string

const (
	ActionUnchanged UpdateAction = "unchanged" // 本地与远端规范化后一致，跳过
	ActionUpdate    UpdateAction = "update"    // 已存在且有差异，将覆盖远端
	ActionCreate    UpdateAction = "create"    // 远端不存在，将新建
)

// WorkflowChange 是 update 计划中的一项变更。
type WorkflowChange struct {
	Name   string       // 工作流 name
	File   string       // 源文件路径
	Action UpdateAction // 处置类型
	ID     string       // 远端工作流 ID（update 时有值）
	Diff   string       // 远端 -> 本地的行级 diff（仅 update 时有值）
	wf     *N8NWorkflow // 待推送的本地工作流
}

// UpdatePlan 是一次 update 的预推送计划，先展示再应用。
type UpdatePlan struct {
	Changes []WorkflowChange
}

// HasChanges 报告计划中是否存在 create/update（unchanged 不算）。
func (p *UpdatePlan) HasChanges() bool {
	for _, c := range p.Changes {
		if c.Action == ActionUpdate || c.Action == ActionCreate {
			return true
		}
	}
	return false
}

// Render 以人类可读形式打印计划：无变更标 =，新建标 +，更新标 ~ 并展开 diff。
func (p *UpdatePlan) Render() {
	for _, c := range p.Changes {
		switch c.Action {
		case ActionUnchanged:
			utils.Info("  = %s (无变更)", c.Name)
		case ActionCreate:
			utils.Info("  + %s (将创建)", c.Name)
		case ActionUpdate:
			utils.Warn("  ~ %s (将更新, 远端→本地):", c.Name)
			fmt.Println(c.Diff)
		}
	}
}

// PlanUpdate 计算 update 计划但不推送：逐个对比本地源文件与远端的规范化负载，
// 分类为 unchanged/update/create，并为 update 项生成行级 diff（pre-push diff 守卫）。
// names 为空时覆盖全部本地工作流。
func (m *N8NManager) PlanUpdate(ctx context.Context, workflowDir string, names ...string) (*UpdatePlan, error) {
	existing, err := m.client.ListWorkflows(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list existing workflows: %w", err)
	}
	existingByName := make(map[string]N8NWorkflow, len(existing))
	for _, wf := range existing {
		existingByName[wf.Name] = wf
	}

	files, err := m.ListLocalWorkflows(workflowDir)
	if err != nil {
		return nil, err
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

	plan := &UpdatePlan{}
	var matched int
	for _, file := range files {
		wf, err := LoadWorkflowFromFile(file)
		if err != nil {
			utils.Warn("Skipping: %s (%v)", file, err)
			continue
		}
		if len(targets) > 0 && !workflowMatchesTargets(file, wf, targets) {
			continue
		}
		matched++

		remote, ok := existingByName[wf.Name]
		if !ok {
			plan.Changes = append(plan.Changes, WorkflowChange{Name: wf.Name, File: file, Action: ActionCreate, wf: wf})
			continue
		}

		remoteFull := &remote
		if detailed, err := m.client.GetWorkflow(ctx, remote.ID); err == nil {
			remoteFull = detailed
		} else {
			utils.Warn("Failed to fetch remote %s for diff, comparing list payload: %v", wf.Name, err)
		}

		localJSON := marshalForDiff(cleanWorkflowForUpdate(wf))
		remoteJSON := marshalForDiff(cleanWorkflowForUpdate(remoteFull))
		if localJSON == remoteJSON {
			plan.Changes = append(plan.Changes, WorkflowChange{Name: wf.Name, File: file, Action: ActionUnchanged, ID: remote.ID})
			continue
		}
		plan.Changes = append(plan.Changes, WorkflowChange{
			Name:   wf.Name,
			File:   file,
			Action: ActionUpdate,
			ID:     remote.ID,
			Diff:   collapseContext(jsonLineDiff(remoteJSON, localJSON), 3),
			wf:     wf,
		})
	}

	if len(targets) > 0 && matched == 0 {
		return nil, fmt.Errorf("no local workflow matched: %s", strings.Join(names, ", "))
	}
	return plan, nil
}

// ApplyUpdate 执行计划中的 create/update（unchanged 跳过）。
func (m *N8NManager) ApplyUpdate(ctx context.Context, plan *UpdatePlan) error {
	var updated, created, skipped, failed int
	for _, c := range plan.Changes {
		switch c.Action {
		case ActionUnchanged:
			skipped++
		case ActionUpdate:
			if _, err := m.client.UpdateWorkflow(ctx, c.ID, c.wf); err != nil {
				utils.Error("Failed to update %s: %v", c.Name, err)
				failed++
				continue
			}
			utils.Success("Updated: %s", c.Name)
			updated++
		case ActionCreate:
			result, err := m.client.CreateWorkflow(ctx, c.wf)
			if err != nil {
				utils.Error("Failed to create %s: %v", c.Name, err)
				failed++
				continue
			}
			utils.Success("Created: %s (id: %s)", c.Name, result.ID)
			created++
		}
	}
	utils.Info("Update completed: %d updated, %d created, %d unchanged, %d failed", updated, created, skipped, failed)
	return nil
}

// marshalForDiff 把规范化工作流序列化为缩进 JSON，用于比对/diff（marshal 失败返回空串）。
// 再经一轮 generic unmarshal/marshal 统一 key 字母序，消除 N8NNode 结构体字段序与 extra
// map 序混排带来的 diff 噪声（有/无 extra 的节点否则会呈现伪重排）。
func marshalForDiff(wf *N8NWorkflow) string {
	data, err := json.MarshalIndent(wf, "", "  ")
	if err != nil {
		return ""
	}
	var generic interface{}
	if err := json.Unmarshal(data, &generic); err != nil {
		return string(data)
	}
	canonical, err := json.MarshalIndent(generic, "", "  ")
	if err != nil {
		return string(data)
	}
	return string(canonical)
}

// jsonLineDiff 基于 LCS 生成 old→new 的行级 diff（- 删除 / + 新增 / 空格 上下文），仅用于人工预览。
func jsonLineDiff(oldStr, newStr string) string {
	oldLines := strings.Split(strings.TrimRight(oldStr, "\n"), "\n")
	newLines := strings.Split(strings.TrimRight(newStr, "\n"), "\n")
	m, n := len(oldLines), len(newLines)

	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := m - 1; i >= 0; i-- {
		for j := n - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	var b strings.Builder
	i, j := 0, 0
	for i < m && j < n {
		switch {
		case oldLines[i] == newLines[j]:
			b.WriteString("  " + oldLines[i] + "\n")
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			b.WriteString("- " + oldLines[i] + "\n")
			i++
		default:
			b.WriteString("+ " + newLines[j] + "\n")
			j++
		}
	}
	for ; i < m; i++ {
		b.WriteString("- " + oldLines[i] + "\n")
	}
	for ; j < n; j++ {
		b.WriteString("+ " + newLines[j] + "\n")
	}
	return b.String()
}

// collapseContext 折叠连续 > ctx 行的未变更上下文为 "  ..."，让 diff 聚焦改动。
func collapseContext(diff string, ctx int) string {
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")
	keep := make([]bool, len(lines))
	for idx, l := range lines {
		if strings.HasPrefix(l, "+ ") || strings.HasPrefix(l, "- ") {
			for k := idx - ctx; k <= idx+ctx; k++ {
				if k >= 0 && k < len(lines) {
					keep[k] = true
				}
			}
		}
	}
	var b strings.Builder
	skipping := false
	for idx := range lines {
		if keep[idx] {
			b.WriteString(lines[idx] + "\n")
			skipping = false
		} else if !skipping {
			b.WriteString("  ...\n")
			skipping = true
		}
	}
	return b.String()
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

func GetN8NWorkflowDir(baseDir string) (string, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return "", err
	}
	hostCfg := cfg.GetHost(cfg.N8N.Host)
	if hostCfg == nil {
		return "", fmt.Errorf("host %s not found", cfg.N8N.Host)
	}
	workflowDir := filepath.Join(baseDir, "hosts", cfg.N8N.Host, "n8n-workflows")
	return workflowDir, nil
}

func GetN8NBackupDir(baseDir string) (string, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return "", err
	}
	backupDir := filepath.Join(cfg.Global.BackupDir, "n8n", time.Now().Format("20060102-150405"))
	return backupDir, nil
}
