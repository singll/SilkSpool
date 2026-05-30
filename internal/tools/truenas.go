package tools

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// TrueNASClient TrueNAS WebSocket JSON-RPC 客户端
type TrueNASClient struct {
	apiURL   string
	username string
	apiKey   string
	insecure bool
	timeout  time.Duration
	conn     *websocket.Conn
	nextID   int
}

// RPCError RPC 错误
type RPCError struct {
	Code    int
	Message string
	Data    interface{}
}

func (e *RPCError) Error() string {
	if e.Data != nil {
		return fmt.Sprintf("%s (code=%d)", e.Message, e.Code)
	}
	return fmt.Sprintf("%s (code=%d)", e.Message, e.Code)
}

// TrueNASJob TrueNAS 作业
type TrueNASJob struct {
	ID       int             `json:"id"`
	State    string          `json:"state"`
	Progress float64         `json:"progress,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// TrueNASSystemInfo TrueNAS 系统信息
type TrueNASSystemInfo struct {
	Version  string   `json:"version"`
	Hostname string   `json:"hostname"`
	Uptime   int      `json:"uptime"`
	Model    string   `json:"model"`
	Serial   string   `json:"serial"`
	MemTotal int64    `json:"mem_total"`
	MemFree  int64    `json:"mem_free"`
	LoadAvg  []float64 `json:"loadavg"`
}

// TrueNASPool TrueNAS 存储池
type TrueNASPool struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Size    int64  `json:"size"`
	Free    int64  `json:"free"`
	Healthy bool   `json:"healthy"`
}

// TrueNASDataset TrueNAS 数据集
type TrueNASDataset struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Pool       string `json:"pool"`
	Type       string `json:"type"`
	UsedBytes  int64  `json:"used_bytes"`
	AvailBytes int64  `json:"available_bytes"`
}

// TrueNASSnapshot TrueNAS 快照
type TrueNASSnapshot struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Dataset   string `json:"dataset"`
	UsedBytes int64  `json:"used_bytes"`
	Created   string `json:"creation"`
}

// rpcRequest RPC 请求
type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

// rpcResponse RPC 响应
type rpcResponse struct {
	ID      int             `json:"id"`
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// NewTrueNASClient 创建 TrueNAS 客户端
func NewTrueNASClient(baseDir string) (*TrueNASClient, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	apiKey := config.GetEnvVar("TRUENAS_API_KEY", cfg.TrueNAS.Host, baseDir)
	if apiKey == "" {
		return nil, fmt.Errorf("TRUENAS_API_KEY not found in hosts/%s/.env", cfg.TrueNAS.Host)
	}

	return &TrueNASClient{
		apiURL:   cfg.TrueNAS.APIURL,
		username: cfg.TrueNAS.Username,
		apiKey:   apiKey,
		insecure: false,
		timeout:  30 * time.Second,
	}, nil
}

// Connect 建立 WebSocket 连接
func (c *TrueNASClient) Connect() error {
	// 将 http/https URL 转换为 ws/wss
	u, err := url.Parse(c.apiURL)
	if err != nil {
		return fmt.Errorf("invalid API URL: %w", err)
	}

	scheme := "wss"
	if u.Scheme == "http" {
		scheme = "ws"
	}

	wsPath := u.Path
	if wsPath == "" || wsPath == "/" {
		wsPath = "/api/current"
	}

	wsURL := fmt.Sprintf("%s://%s%s", scheme, u.Host, wsPath)

	dialer := &websocket.Dialer{
		HandshakeTimeout: c.timeout,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: c.insecure,
		},
	}

	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.conn = conn
	return nil
}

// Close 关闭连接
func (c *TrueNASClient) Close() error {
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	return nil
}

// Call 调用 RPC 方法
func (c *TrueNASClient) Call(method string, params interface{}) (json.RawMessage, error) {
	if c.conn == nil {
		return nil, fmt.Errorf("not connected")
	}

	c.nextID++

	request := rpcRequest{
		JSONRPC: "2.0",
		ID:      c.nextID,
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return nil, fmt.Errorf("failed to send: %w", err)
	}

	// 读取响应
	_, respData, err := c.conn.ReadMessage()
	if err != nil {
		return nil, fmt.Errorf("failed to receive: %w", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if resp.ID != c.nextID {
		return nil, fmt.Errorf("response ID mismatch")
	}

	if resp.Error != nil {
		return nil, &RPCError{
			Code:    resp.Error.Code,
			Message: resp.Error.Message,
		}
	}

	return resp.Result, nil
}

// Authenticate API Key 认证
func (c *TrueNASClient) Authenticate() error {
	_, err := c.Call("auth.login_with_api_key", []interface{}{c.apiKey})
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}
	return nil
}

// WaitForJob 等待作业完成
func (c *TrueNASClient) WaitForJob(jobID int, timeout time.Duration) (*TrueNASJob, error) {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		result, err := c.Call("core.job_wait", []interface{}{jobID, 5.0})
		if err == nil {
			job := &TrueNASJob{ID: jobID}
			if err := json.Unmarshal(result, job); err == nil {
				return job, nil
			}
			return &TrueNASJob{ID: jobID, State: "SUCCESS", Result: result}, nil
		}

		// 获取作业列表
		jobs, err := c.Call("core.get_jobs", []interface{}{map[string]interface{}{
			"id": jobID,
		}})
		if err == nil {
			var jobList []TrueNASJob
			if err := json.Unmarshal(jobs, &jobList); err == nil {
				for _, job := range jobList {
					if job.ID == jobID {
						if job.State == "SUCCESS" || job.State == "FAILED" || job.State == "ABORTED" {
							return &job, nil
						}
					}
				}
			}
		}

		time.Sleep(1 * time.Second)
	}

	return nil, fmt.Errorf("timeout waiting for job %d", jobID)
}

// ==================== API 方法 ====================

// GetSystemInfo 获取系统信息
func (c *TrueNASClient) GetSystemInfo() (*TrueNASSystemInfo, error) {
	result, err := c.Call("system.info", []interface{}{})
	if err != nil {
		return nil, err
	}

	info := &TrueNASSystemInfo{}
	if err := json.Unmarshal(result, info); err != nil {
		return nil, fmt.Errorf("failed to parse system info: %w", err)
	}
	return info, nil
}

// ListPools 列出存储池
func (c *TrueNASClient) ListPools() ([]TrueNASPool, error) {
	result, err := c.Call("pool.query", []interface{}{})
	if err != nil {
		return nil, err
	}

	var pools []TrueNASPool
	if err := json.Unmarshal(result, &pools); err != nil {
		return nil, fmt.Errorf("failed to parse pools: %w", err)
	}
	return pools, nil
}

// ListDatasets 列出数据集
func (c *TrueNASClient) ListDatasets() ([]TrueNASDataset, error) {
	result, err := c.Call("pool.dataset.query", []interface{}{})
	if err != nil {
		return nil, err
	}

	var datasets []TrueNASDataset
	if err := json.Unmarshal(result, &datasets); err != nil {
		return nil, fmt.Errorf("failed to parse datasets: %w", err)
	}
	return datasets, nil
}

// ListSnapshots 列出快照
func (c *TrueNASClient) ListSnapshots(pool string) ([]TrueNASSnapshot, error) {
	params := map[string]interface{}{}
	if pool != "" {
		params["dataset"] = pool
	}

	result, err := c.Call("pool.snapshot.query", []interface{}{params})
	if err != nil {
		return nil, err
	}

	var snapshots []TrueNASSnapshot
	if err := json.Unmarshal(result, &snapshots); err != nil {
		return nil, fmt.Errorf("failed to parse snapshots: %w", err)
	}
	return snapshots, nil
}

// ==================== 命令行工具 ====================

// TrueNASManager TrueNAS 管理器
type TrueNASManager struct {
	client *TrueNASClient
}

// NewTrueNASManager 创建管理器
func NewTrueNASManager(baseDir string) (*TrueNASManager, error) {
	client, err := NewTrueNASClient(baseDir)
	if err != nil {
		return nil, err
	}

	if err := client.Connect(); err != nil {
		return nil, fmt.Errorf("failed to connect: %w", err)
	}

	if err := client.Authenticate(); err != nil {
		client.Close()
		return nil, fmt.Errorf("authentication failed: %w", err)
	}

	return &TrueNASManager{client: client}, nil
}

// Close 关闭管理器
func (m *TrueNASManager) Close() error {
	return m.client.Close()
}

// CmdInfo 显示系统信息
func (m *TrueNASManager) CmdInfo() error {
	info, err := m.client.GetSystemInfo()
	if err != nil {
		return err
	}

	utils.Info("TrueNAS System Information")
	utils.Info("  Version:   %s", info.Version)
	utils.Info("  Hostname:  %s", info.Hostname)
	utils.Info("  Uptime:   %s", formatUptime(info.Uptime))
	utils.Info("  Model:    %s", info.Model)
	utils.Info("  Serial:   %s", info.Serial)
	utils.Info("  Memory:   %.1f GB total, %.1f GB free",
		float64(info.MemTotal)/1024/1024/1024,
		float64(info.MemFree)/1024/1024/1024)
	if len(info.LoadAvg) >= 3 {
		utils.Info("  Load:     %.2f, %.2f, %.2f",
			info.LoadAvg[0], info.LoadAvg[1], info.LoadAvg[2])
	}

	return nil
}

// CmdPoolList 列出存储池
func (m *TrueNASManager) CmdPoolList() error {
	pools, err := m.client.ListPools()
	if err != nil {
		return err
	}

	utils.Info("Storage Pools")
	if len(pools) == 0 {
		utils.Info("  (no pools found)")
		return nil
	}

	for _, pool := range pools {
		health := "healthy"
		if !pool.Healthy {
			health = "UNHEALTHY"
		}
		usedPct := 0.0
		if pool.Size > 0 {
			usedPct = float64(pool.Size-pool.Free) / float64(pool.Size) * 100
		}
		utils.Info("  %s: %s (%.1f%% used, %s)",
			pool.Name,
			pool.Status,
			usedPct,
			health)
	}

	return nil
}

// CmdDatasetList 列出数据集
func (m *TrueNASManager) CmdDatasetList() error {
	datasets, err := m.client.ListDatasets()
	if err != nil {
		return err
	}

	utils.Info("Datasets")
	if len(datasets) == 0 {
		utils.Info("  (no datasets found)")
		return nil
	}

	for _, ds := range datasets {
		utils.Info("  %s", ds.Name)
	}

	return nil
}

// CmdSnapshotList 列出快照
func (m *TrueNASManager) CmdSnapshotList(pool string) error {
	snapshots, err := m.client.ListSnapshots(pool)
	if err != nil {
		return err
	}

	utils.Info("Snapshots")
	if len(snapshots) == 0 {
		utils.Info("  (no snapshots found)")
		return nil
	}

	for _, snap := range snapshots {
		utils.Info("  %s@%s (created: %s)",
			snap.Dataset, snap.Name, snap.Created)
	}

	return nil
}

// formatUptime 格式化运行时间
func formatUptime(seconds int) string {
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	mins := (seconds % 3600) / 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, mins)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}

// GetN8NWorkflowDir 获取 n8n 工作流目录
func GetN8NWorkflowDir(baseDir string) (string, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return "", err
	}
	hostCfg := cfg.GetHost(cfg.N8N.Host)
	if hostCfg == nil {
		return "", fmt.Errorf("host %s not found", cfg.N8N.Host)
	}
	// 相对于 hosts/<host>/ 的路径
	workflowDir := filepath.Join(baseDir, "hosts", cfg.N8N.Host, "n8n-workflows")
	return workflowDir, nil
}

// GetN8NBackupDir 获取 n8n 备份目录
func GetN8NBackupDir(baseDir string) (string, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return "", err
	}
	backupDir := filepath.Join(cfg.Global.BackupDir, "n8n", time.Now().Format("20060102-150405"))
	return backupDir, nil
}
