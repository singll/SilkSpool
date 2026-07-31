// Command rdp-gateway —— RDP 安全网关「路径 B（香港公网中转）」+ Authelia 授权页，运行在 txhk。
//
// 单进程承担四件事（见 doc/RDP-GUARD.md §4）：
//  1. HTTP 授权页（127.0.0.1:8090，置于 Caddy forward_auth 之后；2FA 通过才可达）；
//  2. 三条通路按需单独开通（/api/open/relay|v4|v6，登录不自动开任何通路）：
//     - relay：客户端 v4 写入 nft 白名单（内核 drop 闸，TTL）+ 内存白名单（应用层闸，纵深防御）；
//     - v4：经 Tailscale 调 istoreos agent /open4 开限源 DNAT 窗口，取回家宽公网 v4（直连，不经香港）；
//     - v6：经 Tailscale 调 istoreos agent /open 开 v6 pinhole 并取回当前 Win10 GUA；
//  3. 长期白名单（中转常通，显式加入）持久化与周期刷新；
//  4. TCP+UDP 代理 :33890 → 192.168.7.129:3389（替代 socat：单二进制、原生 UDP、无 per-conn fork）。
//
// 仅用标准库；以最小权限用户运行，写 nft 经受限 sudoers（见 hosts/txhk/sudoers/rdp-gateway）。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 配置（systemd EnvironmentFile 注入）
var (
	httpListen       = envRequired("GW_HTTP_LISTEN")
	proxyListen      = envRequired("GW_PROXY_LISTEN")
	target           = envRequired("GW_TARGET")
	publicAddr       = envRequired("GW_PUBLIC_ADDR")
	agentURL         = envRequired("GW_AGENT_URL")
	agentV4URL       = envRequired("GW_AGENT_V4_URL")
	nftSet           = env("GW_NFT_SET", "rdp_guard")
	nftBin           = env("GW_NFT_BIN", "/usr/sbin/nft")
	ttlSeconds       = envInt("GW_TTL", 180)
	udpIdleSeconds   = envInt("GW_UDP_IDLE", 1800)
	stateFile        = env("GW_STATE_FILE", "/var/lib/rdp-gateway/state.json")
	loginURL         = envRequired("GW_LOGIN_URL")
	historyLimit     = envInt("GW_HISTORY_LIMIT", 160)
	permanentRefresh = envInt("GW_PERMANENT_REFRESH", maxInt(20, ttlSeconds/2))
	token            = os.Getenv("RDP6_TOKEN")
)

func main() {
	log.SetFlags(log.LstdFlags)

	store := newStateStore(stateFile, historyLimit)
	if err := store.Load(); err != nil {
		log.Printf("rdp-gateway: 读取状态文件失败 path=%s: %v", stateFile, err)
	}

	wl := newWhitelist()
	for _, entry := range store.PermanentEntries() {
		wl.AddPermanent(entry.IP)
		if err := nftAllowV4(entry.IP); err != nil {
			log.Printf("rdp-gateway: 恢复长期白名单到 nft 失败 ip=%s: %v", entry.IP, err)
		}
	}
	go refreshPermanentWhitelist(wl, store)

	limiter := newEventLimiter()

	// 代理层先起（转发先于授权可用，连接来了即能用）
	go serveTCPProxy(proxyListen, target, wl, store, limiter)
	go serveUDPProxy(proxyListen, target, wl, store, limiter)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		handleState(w, r, wl, store)
	})
	mux.HandleFunc("/api/whitelist/current", func(w http.ResponseWriter, r *http.Request) {
		handleAddCurrentPermanent(w, r, wl, store)
	})
	mux.HandleFunc("/api/whitelist/remove", func(w http.ResponseWriter, r *http.Request) {
		handleRemovePermanent(w, r, wl, store)
	})
	mux.HandleFunc("/api/open/relay", func(w http.ResponseWriter, r *http.Request) {
		handleOpenRelay(w, r, wl, store)
	})
	mux.HandleFunc("/api/open/v6", func(w http.ResponseWriter, r *http.Request) {
		handleOpenV6(w, r, store)
	})
	mux.HandleFunc("/api/open/v4", func(w http.ResponseWriter, r *http.Request) {
		handleOpenDirectV4(w, r, store)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { handleUnlock(w, r, wl, store) })

	log.Printf("rdp-gateway: HTTP=%s 代理=%s 目标=%s TTL=%ds UDP空闲=%ds 状态=%s", httpListen, proxyListen, target, ttlSeconds, udpIdleSeconds, stateFile)
	srv := &http.Server{Addr: httpListen, Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

// handleUnlock：2FA 已由 Caddy forward_auth 保证。仅渲染控制页 —— 不自动开通任何通路，
// 每条通路（v4 直连 / v6 直连 / 中转）由页面按钮单独触发对应 /api/open/*（最小授权）。
// 例外：长期白名单 IP 的中转保活是既有显式授权语义，访问时顺带刷新。
func handleUnlock(w http.ResponseWriter, r *http.Request, wl *whitelist, store *stateStore) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientIP := clientIPv4(r)
	if clientIP == "" {
		log.Printf("rdp-gateway: X-Real-IP 非法或非 v4: %q remote=%q", strings.TrimSpace(r.Header.Get("X-Real-IP")), r.RemoteAddr)
	}
	isPermanent := clientIP != "" && (wl.IsPermanent(clientIP) || store.HasPermanent(clientIP))
	if isPermanent {
		wl.AddPermanent(clientIP)
		store.TouchPermanent(clientIP)
		if err := nftAllowV4(clientIP); err != nil {
			log.Printf("rdp-gateway: 刷新长期白名单失败 ip=%s: %v", clientIP, err)
		}
	}

	data := pageData{
		ClientIP:         clientIP,
		ClientKnown:      clientIP != "",
		RelayAddr:        publicAddr,
		TTLSeconds:       ttlSeconds,
		LoginURL:         loginURL,
		IsPermanent:      isPermanent,
		PermanentEntries: permanentViews(store.PermanentEntries(), clientIP),
		TempEntries:      temporaryViews(wl.TemporaryEntries()),
		History:          historyViews(store.History()),
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pageTmpl.Execute(w, data); err != nil {
		log.Printf("rdp-gateway: 渲染页面失败: %v", err)
	}
}

// openRequestGuard 统一三个 /api/open/* 的方法与同源校验。
func openRequestGuard(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if !sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// handleOpenRelay 开通香港中转（路径 B 托底）：客户端 v4 写 nft + 内存白名单。
func handleOpenRelay(w http.ResponseWriter, r *http.Request, wl *whitelist, store *stateStore) {
	if !openRequestGuard(w, r) {
		return
	}
	now := time.Now()
	ip := clientIPv4(r)
	if ip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "无法识别当前出口 IPv4"})
		return
	}
	permanent := wl.IsPermanent(ip) || store.HasPermanent(ip)
	if err := nftAllowV4(ip); err != nil {
		log.Printf("rdp-gateway: 中转开通写 nft 失败 ip=%s: %v", ip, err)
		store.Record(historyEntry{Time: now, Kind: "relay", IP: ip, Result: "failed", Detail: "写内核白名单失败"})
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "写内核白名单失败", "detail": err.Error()})
		return
	}
	resp := map[string]any{"addr": publicAddr, "ttl": ttlSeconds, "permanent": permanent}
	detail := ""
	var expiresAt *time.Time
	if permanent {
		wl.AddPermanent(ip)
		store.TouchPermanent(ip)
		detail = "长期白名单持续放行"
	} else {
		wl.AddTemporary(ip, time.Duration(ttlSeconds)*time.Second)
		exp := now.Add(time.Duration(ttlSeconds) * time.Second)
		expiresAt = &exp
		resp["expires_at_unix"] = exp.Unix()
		detail = fmt.Sprintf("%d 秒后只拒绝新会话，已建立会话继续保持", ttlSeconds)
	}
	resp["detail"] = detail
	store.Record(historyEntry{Time: now, Kind: "relay", IP: ip, Result: "ok", Detail: detail, V4Addr: publicAddr, ExpiresAt: expiresAt})
	log.Printf("rdp-gateway: 中转已开通 ip=%s permanent=%v", ip, permanent)
	writeJSON(w, http.StatusOK, resp)
}

// handleOpenV6 开通 IPv6 直连（路径 A）：经 Tailscale 令 istoreos 开 v6 pinhole。
func handleOpenV6(w http.ResponseWriter, r *http.Request, store *stateStore) {
	if !openRequestGuard(w, r) {
		return
	}
	now := time.Now()
	ip := clientIPv4(r)
	agent, ok := callAgent()
	if !ok {
		store.Record(historyEntry{Time: now, Kind: "v6", IP: ip, Result: "failed", Detail: "家侧 agent 无响应或未解析到 GUA"})
		log.Printf("rdp-gateway: v6 直连开通失败（agent 无响应/无 v6）")
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "家侧 agent 无响应或未解析到 GUA"})
		return
	}
	addr := fmt.Sprintf("[%s]:%d", agent.GUA, agent.Port)
	exp := now.Add(time.Duration(agent.TTL) * time.Second)
	store.Record(historyEntry{Time: now, Kind: "v6", IP: ip, Result: "ok", Detail: "来源 " + agent.Source, V6Addr: addr, ExpiresAt: &exp})
	log.Printf("rdp-gateway: v6 直连已开通 %s（来源 %s）", addr, agent.Source)
	writeJSON(w, http.StatusOK, map[string]any{
		"addr": addr, "ttl": agent.TTL, "source": agent.Source, "expires_at_unix": exp.Unix(),
		"detail": fmt.Sprintf("pinhole %d 秒内有效，需当前网络有 IPv6 出网", agent.TTL),
	})
}

// handleOpenDirectV4 开通 IPv4 直连（路径 A-v4）：经 Tailscale 令 istoreos 开限源 DNAT 窗口。
func handleOpenDirectV4(w http.ResponseWriter, r *http.Request, store *stateStore) {
	if !openRequestGuard(w, r) {
		return
	}
	now := time.Now()
	ip := clientIPv4(r)
	if ip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "无法识别当前出口 IPv4，v4 直连需要按源放行"})
		return
	}
	res, err := callAgentV4(ip)
	if err != nil {
		store.Record(historyEntry{Time: now, Kind: "v4", IP: ip, Result: "failed", Detail: err.Error()})
		log.Printf("rdp-gateway: v4 直连开通失败 client=%s: %v", ip, err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "v4 直连开通失败", "detail": err.Error()})
		return
	}
	addr := net.JoinHostPort(res.V4, strconv.Itoa(res.Port))
	exp := now.Add(time.Duration(res.TTL) * time.Second)
	store.Record(historyEntry{Time: now, Kind: "v4", IP: ip, Result: "ok", Detail: "仅放行当前出口 IP（连接保活）", V4Addr: addr, ExpiresAt: &exp})
	log.Printf("rdp-gateway: v4 直连已开通 %s（仅放行 %s，保活=%v）", addr, ip, res.Keepalive)
	detail := fmt.Sprintf("仅放行 %s，%d 秒内可发起新连接", ip, res.TTL)
	if res.Keepalive {
		detail = fmt.Sprintf("仅放行 %s：连接期间自动续期不掉线，断开约 %d 分钟后自动关窗，重连无需重新开通", ip, (res.TTL+59)/60)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"addr": addr, "ttl": res.TTL, "expires_at_unix": exp.Unix(),
		"keepalive": res.Keepalive, "detail": detail,
	})
}

func handleState(w http.ResponseWriter, r *http.Request, wl *whitelist, store *stateStore) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"client_ip":           clientIPv4(r),
		"temporary_whitelist": wl.TemporaryEntries(),
		"permanent_whitelist": store.PermanentEntries(),
		"history":             store.History(),
		"ttl_seconds":         ttlSeconds,
		"udp_idle_seconds":    udpIdleSeconds,
	})
}

func handleAddCurrentPermanent(w http.ResponseWriter, r *http.Request, wl *whitelist, store *stateStore) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	ip := clientIPv4(r)
	if ip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "current IPv4 not found"})
		return
	}
	req := struct {
		Note string `json:"note"`
	}{}
	_ = readJSONOrForm(r, &req)
	req.Note = trimRunes(strings.TrimSpace(req.Note), 80)

	if err := nftAllowV4(ip); err != nil {
		log.Printf("rdp-gateway: 添加长期白名单时刷新 nft 失败 ip=%s: %v", ip, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "nft whitelist failed", "detail": err.Error()})
		return
	}
	entry, err := store.AddPermanent(ip, req.Note)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "save whitelist failed", "detail": err.Error()})
		return
	}
	wl.AddPermanent(ip)
	store.Record(historyEntry{
		Time:   time.Now(),
		Kind:   "whitelist",
		IP:     ip,
		Result: "added",
		Detail: "added current outbound IP to long-term whitelist",
	})
	log.Printf("rdp-gateway: 已加入长期白名单 ip=%s note=%q", ip, req.Note)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entry": entry})
}

func handleRemovePermanent(w http.ResponseWriter, r *http.Request, wl *whitelist, store *stateStore) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	req := struct {
		IP string `json:"ip"`
	}{}
	if err := readJSONOrForm(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
		return
	}
	ip := normalizeIPv4(req.IP)
	if ip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid IPv4"})
		return
	}
	if err := store.RemovePermanent(ip); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "save whitelist failed", "detail": err.Error()})
		return
	}
	wl.RemovePermanent(ip)
	if err := nftDeleteV4(ip); err != nil {
		log.Printf("rdp-gateway: 移除 nft 白名单失败 ip=%s: %v", ip, err)
	}
	store.Record(historyEntry{
		Time:   time.Now(),
		Kind:   "whitelist",
		IP:     ip,
		Result: "removed",
		Detail: "removed from long-term whitelist",
	})
	log.Printf("rdp-gateway: 已移除长期白名单 ip=%s", ip)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// callAgent 经 Tailscale 调 istoreos rdp6-agent，开 v6 pinhole 并取回 GUA。
func callAgent() (agentOpenResult, bool) {
	if agentURL == "" || token == "" {
		return agentOpenResult{}, false
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(agentURL + "?token=" + url.QueryEscape(token))
	if err != nil {
		log.Printf("rdp-gateway: 调 agent 失败: %v", err)
		return agentOpenResult{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("rdp-gateway: agent 返回 %d", resp.StatusCode)
		return agentOpenResult{}, false
	}
	var r agentOpenResult
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.GUA == "" {
		return agentOpenResult{}, false
	}
	if r.Port == 0 {
		r.Port = 3389
	}
	if r.TTL == 0 {
		r.TTL = ttlSeconds
	}
	return r, true
}

type agentOpenResult struct {
	GUA       string `json:"gua"`
	Port      int    `json:"port"`
	TTL       int    `json:"ttl"`
	Source    string `json:"source"`
	ExpiresAt string `json:"expires_at"`
}

// callAgentV4 经 Tailscale 调 istoreos agent /open4，按客户端源 IP 开 v4 DNAT 窗口，取回家宽公网 v4。
func callAgentV4(clientIP string) (agentV4Result, error) {
	if agentV4URL == "" || token == "" {
		return agentV4Result{}, fmt.Errorf("agent 未配置")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(agentV4URL + "?token=" + url.QueryEscape(token) + "&client=" + url.QueryEscape(clientIP))
	if err != nil {
		return agentV4Result{}, fmt.Errorf("家侧 agent 无响应: %w", err)
	}
	defer resp.Body.Close()
	var r agentV4Result
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error == "" {
			e.Error = fmt.Sprintf("agent 返回 %d", resp.StatusCode)
		}
		return agentV4Result{}, fmt.Errorf("%s", e.Error)
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.V4 == "" {
		return agentV4Result{}, fmt.Errorf("agent 响应非法")
	}
	if r.Port == 0 {
		r.Port = 33891
	}
	if r.TTL == 0 {
		r.TTL = ttlSeconds
	}
	return r, nil
}

type agentV4Result struct {
	V4        string `json:"v4"`
	Port      int    `json:"port"`
	TTL       int    `json:"ttl"`
	Keepalive bool   `json:"keepalive"`
	Refresh   int    `json:"refresh"`
	Client    string `json:"client"`
	ExpiresAt string `json:"expires_at"`
}

// nftAllowV4 把客户端 v4 加入 nft 白名单（内核 drop 闸）。经受限 sudoers 提权。
func nftAllowV4(ip string) error {
	out, err := exec.Command("sudo", nftBin, "add", "element", "inet", nftSet, "allowed_ips",
		fmt.Sprintf("{ %s timeout %ds }", ip, ttlSeconds)).CombinedOutput()
	if err != nil && !strings.Contains(strings.ToLower(string(out)), "exist") {
		return fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func nftDeleteV4(ip string) error {
	out, err := exec.Command("sudo", nftBin, "delete", "element", "inet", nftSet, "allowed_ips",
		fmt.Sprintf("{ %s }", ip)).CombinedOutput()
	if err != nil {
		s := strings.ToLower(string(out))
		if strings.Contains(s, "no such") || strings.Contains(s, "not found") {
			return nil
		}
		return fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func refreshPermanentWhitelist(wl *whitelist, store *stateStore) {
	if permanentRefresh <= 0 {
		return
	}
	ticker := time.NewTicker(time.Duration(permanentRefresh) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		for _, entry := range store.PermanentEntries() {
			if err := nftAllowV4(entry.IP); err != nil {
				log.Printf("rdp-gateway: 刷新长期白名单失败 ip=%s: %v", entry.IP, err)
				continue
			}
			wl.AddPermanent(entry.IP)
		}
	}
}

// ---------- 状态文件 ----------

type permanentEntry struct {
	IP       string    `json:"ip"`
	Note     string    `json:"note,omitempty"`
	AddedAt  time.Time `json:"added_at"`
	LastSeen time.Time `json:"last_seen"`
}

type historyEntry struct {
	ID        int64      `json:"id"`
	Time      time.Time  `json:"time"`
	Kind      string     `json:"kind"`
	IP        string     `json:"ip,omitempty"`
	Result    string     `json:"result"`
	Detail    string     `json:"detail,omitempty"`
	V4Addr    string     `json:"v4_addr,omitempty"`
	V6Addr    string     `json:"v6_addr,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type persistedState struct {
	Permanent map[string]permanentEntry `json:"permanent_whitelist"`
	History   []historyEntry            `json:"history"`
	NextID    int64                     `json:"next_id"`
}

type stateStore struct {
	mu    sync.Mutex
	path  string
	limit int
	data  persistedState
}

func newStateStore(path string, limit int) *stateStore {
	if limit <= 0 {
		limit = 160
	}
	return &stateStore{
		path:  path,
		limit: limit,
		data: persistedState{
			Permanent: make(map[string]permanentEntry),
			NextID:    1,
		},
	}
}

func (s *stateStore) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var data persistedState
	if err := json.Unmarshal(b, &data); err != nil {
		return err
	}
	if data.Permanent == nil {
		data.Permanent = make(map[string]permanentEntry)
	}
	for ip, entry := range data.Permanent {
		nip := normalizeIPv4(firstNonEmpty(entry.IP, ip))
		if nip == "" {
			delete(data.Permanent, ip)
			continue
		}
		if nip != ip {
			delete(data.Permanent, ip)
		}
		entry.IP = nip
		if entry.AddedAt.IsZero() {
			entry.AddedAt = time.Now()
		}
		if entry.LastSeen.IsZero() {
			entry.LastSeen = entry.AddedAt
		}
		data.Permanent[nip] = entry
	}
	if data.NextID <= 0 {
		data.NextID = int64(len(data.History) + 1)
	}
	s.data = data
	return nil
}

func (s *stateStore) AddPermanent(ip, note string) (permanentEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if s.data.Permanent == nil {
		s.data.Permanent = make(map[string]permanentEntry)
	}
	entry, ok := s.data.Permanent[ip]
	if !ok {
		entry = permanentEntry{IP: ip, AddedAt: now}
	}
	entry.Note = note
	entry.LastSeen = now
	s.data.Permanent[ip] = entry
	return entry, s.saveLocked()
}

func (s *stateStore) TouchPermanent(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.data.Permanent[ip]
	if !ok {
		return
	}
	entry.LastSeen = time.Now()
	s.data.Permanent[ip] = entry
	if err := s.saveLocked(); err != nil {
		log.Printf("rdp-gateway: 保存长期白名单 last_seen 失败 ip=%s: %v", ip, err)
	}
}

func (s *stateStore) RemovePermanent(ip string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data.Permanent, ip)
	return s.saveLocked()
}

func (s *stateStore) HasPermanent(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.Permanent[ip]
	return ok
}

func (s *stateStore) PermanentEntries() []permanentEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	res := make([]permanentEntry, 0, len(s.data.Permanent))
	for _, entry := range s.data.Permanent {
		res = append(res, entry)
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].LastSeen.After(res[j].LastSeen)
	})
	return res
}

func (s *stateStore) Record(entry historyEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if entry.Time.IsZero() {
		entry.Time = time.Now()
	}
	entry.ID = s.data.NextID
	s.data.NextID++
	s.data.History = append([]historyEntry{entry}, s.data.History...)
	if len(s.data.History) > s.limit {
		s.data.History = s.data.History[:s.limit]
	}
	if err := s.saveLocked(); err != nil {
		log.Printf("rdp-gateway: 保存历史失败: %v", err)
	}
}

func (s *stateStore) History() []historyEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	res := make([]historyEntry, len(s.data.History))
	copy(res, s.data.History)
	return res
}

func (s *stateStore) saveLocked() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ---------- 内存白名单（应用层闸，纵深防御）----------

type whitelist struct {
	mu sync.RWMutex
	m  map[string]whitelistEntry
}

type whitelistEntry struct {
	IP        string    `json:"ip"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
	Permanent bool      `json:"permanent"`
}

type allowStatus struct {
	Allowed   bool
	Permanent bool
	ExpiresAt time.Time
}

func newWhitelist() *whitelist { return &whitelist{m: make(map[string]whitelistEntry)} }

func (w *whitelist) AddTemporary(ip string, ttl time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if entry, ok := w.m[ip]; ok && entry.Permanent {
		return
	}
	w.m[ip] = whitelistEntry{IP: ip, ExpiresAt: time.Now().Add(ttl)}
}

func (w *whitelist) AddPermanent(ip string) {
	w.mu.Lock()
	w.m[ip] = whitelistEntry{IP: ip, Permanent: true}
	w.mu.Unlock()
}

func (w *whitelist) RemovePermanent(ip string) {
	w.mu.Lock()
	if entry, ok := w.m[ip]; ok && entry.Permanent {
		delete(w.m, ip)
	}
	w.mu.Unlock()
}

func (w *whitelist) IsPermanent(ip string) bool {
	w.mu.RLock()
	entry, ok := w.m[ip]
	w.mu.RUnlock()
	return ok && entry.Permanent
}

func (w *whitelist) Check(ip string) allowStatus {
	w.mu.RLock()
	entry, ok := w.m[ip]
	w.mu.RUnlock()
	if !ok {
		return allowStatus{}
	}
	if entry.Permanent {
		return allowStatus{Allowed: true, Permanent: true}
	}
	if time.Now().Before(entry.ExpiresAt) {
		return allowStatus{Allowed: true, ExpiresAt: entry.ExpiresAt}
	}
	return allowStatus{}
}

func (w *whitelist) TemporaryEntries() []whitelistEntry {
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()

	res := make([]whitelistEntry, 0, len(w.m))
	for ip, entry := range w.m {
		if entry.Permanent {
			continue
		}
		if now.After(entry.ExpiresAt) {
			delete(w.m, ip)
			continue
		}
		res = append(res, entry)
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].ExpiresAt.After(res[j].ExpiresAt)
	})
	return res
}

// ---------- TCP 代理 ----------

func serveTCPProxy(listen, target string, wl *whitelist, store *stateStore, limiter *eventLimiter) {
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("rdp-gateway: TCP 监听 %s 失败: %v", listen, err)
	}
	log.Printf("rdp-gateway: TCP 代理就绪 %s", listen)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleTCP(c, target, wl, store, limiter)
	}
}

func handleTCP(c net.Conn, target string, wl *whitelist, store *stateStore, limiter *eventLimiter) {
	defer c.Close()
	host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	status := wl.Check(host)
	if !status.Allowed {
		log.Printf("rdp-gateway: 拒绝未授权 TCP 源 %s", host)
		if limiter.Allow("tcp-deny:"+host, time.Minute) {
			store.Record(historyEntry{Time: time.Now(), Kind: "tcp", IP: host, Result: "denied", Detail: "new TCP session denied after whitelist expiry or without authorization"})
		}
		return
	}
	up, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		log.Printf("rdp-gateway: 连目标 %s 失败: %v", target, err)
		store.Record(historyEntry{Time: time.Now(), Kind: "tcp", IP: host, Result: "failed", Detail: fmt.Sprintf("target dial failed: %v", err)})
		return
	}
	defer up.Close()

	detail := "new TCP session accepted"
	if status.Permanent {
		detail = "new TCP session accepted by long-term whitelist"
	}
	store.Record(historyEntry{Time: time.Now(), Kind: "tcp", IP: host, Result: "accepted", Detail: detail, V4Addr: publicAddr})

	errc := make(chan error, 2)
	go func() { _, e := io.Copy(up, c); errc <- e }()
	go func() { _, e := io.Copy(c, up); errc <- e }()
	<-errc
}

// ---------- UDP 代理（RDP-UDP，per-client 会话 + 空闲回收）----------

func serveUDPProxy(listen, target string, wl *whitelist, store *stateStore, limiter *eventLimiter) {
	laddr, err := net.ResolveUDPAddr("udp", listen)
	if err != nil {
		log.Fatalf("rdp-gateway: 解析 UDP 监听地址失败: %v", err)
	}
	pc, err := net.ListenUDP("udp", laddr)
	if err != nil {
		log.Fatalf("rdp-gateway: UDP 监听 %s 失败: %v", listen, err)
	}
	raddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		log.Fatalf("rdp-gateway: 解析目标 UDP 地址失败: %v", err)
	}
	log.Printf("rdp-gateway: UDP 代理就绪 %s", listen)

	var mu sync.Mutex
	sessions := map[string]*net.UDPConn{} // clientAddr → 到目标的 conn
	buf := make([]byte, 65535)
	for {
		n, caddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		key := caddr.String()
		clientIP := caddr.IP.String()

		mu.Lock()
		up := sessions[key]
		if up == nil {
			status := wl.Check(clientIP)
			if !status.Allowed {
				mu.Unlock()
				if limiter.Allow("udp-deny:"+clientIP, time.Minute) {
					store.Record(historyEntry{Time: time.Now(), Kind: "udp", IP: clientIP, Result: "denied", Detail: "new UDP session denied after whitelist expiry or without authorization"})
				}
				continue
			}
			up, err = net.DialUDP("udp", nil, raddr)
			if err != nil {
				mu.Unlock()
				store.Record(historyEntry{Time: time.Now(), Kind: "udp", IP: clientIP, Result: "failed", Detail: fmt.Sprintf("target dial failed: %v", err)})
				continue
			}
			sessions[key] = up
			detail := "new UDP session accepted"
			if status.Permanent {
				detail = "new UDP session accepted by long-term whitelist"
			}
			store.Record(historyEntry{Time: time.Now(), Kind: "udp", IP: clientIP, Result: "accepted", Detail: detail, V4Addr: publicAddr})

			// 白名单只在创建 UDP 会话时检查，TTL 过期后不影响已建立的 RDP-UDP 会话。
			go func(up *net.UDPConn, caddr *net.UDPAddr, key string) {
				b := make([]byte, 65535)
				for {
					_ = up.SetReadDeadline(time.Now().Add(time.Duration(udpIdleSeconds) * time.Second))
					m, err := up.Read(b)
					if err != nil {
						break
					}
					_, _ = pc.WriteToUDP(b[:m], caddr)
				}
				mu.Lock()
				delete(sessions, key)
				mu.Unlock()
				up.Close()
			}(up, caddr, key)
		}
		mu.Unlock()
		_, _ = up.Write(buf[:n])
	}
}

type eventLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func newEventLimiter() *eventLimiter {
	return &eventLimiter{last: make(map[string]time.Time)}
}

func (l *eventLimiter) Allow(key string, interval time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if last, ok := l.last[key]; ok && now.Sub(last) < interval {
		return false
	}
	l.last[key] = now
	return true
}

// ---------- 授权页 ----------

type pageData struct {
	ClientIP         string
	ClientKnown      bool
	RelayAddr        string
	TTLSeconds       int
	LoginURL         string
	IsPermanent      bool
	PermanentEntries []permanentView
	TempEntries      []temporaryView
	History          []historyView
}

type permanentView struct {
	IP        string
	Note      string
	AddedAt   string
	LastSeen  string
	IsCurrent bool
}

type temporaryView struct {
	IP        string
	ExpiresAt string
	Remaining string
}

type historyView struct {
	Time   string
	Kind   string
	IP     string
	Result string
	Detail string
	V4Addr string
	V6Addr string
	Tone   string
}

func permanentViews(entries []permanentEntry, currentIP string) []permanentView {
	res := make([]permanentView, 0, len(entries))
	for _, entry := range entries {
		res = append(res, permanentView{
			IP:        entry.IP,
			Note:      entry.Note,
			AddedAt:   formatTime(entry.AddedAt),
			LastSeen:  formatTime(entry.LastSeen),
			IsCurrent: entry.IP == currentIP,
		})
	}
	return res
}

func temporaryViews(entries []whitelistEntry) []temporaryView {
	res := make([]temporaryView, 0, len(entries))
	for _, entry := range entries {
		remaining := time.Until(entry.ExpiresAt).Round(time.Second)
		if remaining < 0 {
			remaining = 0
		}
		res = append(res, temporaryView{
			IP:        entry.IP,
			ExpiresAt: formatTime(entry.ExpiresAt),
			Remaining: compactDuration(remaining),
		})
	}
	return res
}

func historyViews(entries []historyEntry) []historyView {
	res := make([]historyView, 0, len(entries))
	for _, entry := range entries {
		res = append(res, historyView{
			Time:   formatTime(entry.Time),
			Kind:   historyKindLabel(entry.Kind),
			IP:     firstNonEmpty(entry.IP, "unknown"),
			Result: historyResultLabel(entry.Result),
			Detail: entry.Detail,
			V4Addr: entry.V4Addr,
			V6Addr: entry.V6Addr,
			Tone:   historyTone(entry.Result),
		})
	}
	return res
}

var pageTmpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RDP 安全入口</title>
<style>
:root{color-scheme:light;--bg:#f6f7f4;--panel:#ffffff;--text:#17211b;--muted:#66706a;--line:#d9ded8;--blue:#1d5fd1;--green:#177245;--amber:#9a5b00;--red:#b42318;--shadow:0 18px 60px rgba(24,34,28,.12)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",Arial,sans-serif}
button,input{font:inherit}
.wrap{width:min(1120px,calc(100vw - 32px));margin:0 auto;padding:26px 0 34px}
.top{display:grid;grid-template-columns:1.1fr auto;gap:18px;align-items:end;margin-bottom:18px}
h1{margin:0;font-size:clamp(28px,4vw,46px);line-height:1.02;letter-spacing:0}
.lead{margin:10px 0 0;color:var(--muted);font-size:15px;line-height:1.55}
.status{display:grid;grid-template-columns:repeat(3,minmax(130px,1fr));gap:10px;min-width:420px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;box-shadow:0 8px 24px rgba(24,34,28,.05)}
.stat b{display:block;font-size:18px;margin-top:5px}.stat span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start}
.stack{display:grid;gap:14px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:14px 16px}
.panel-h h2,.panel-h h3{margin:0;font-size:16px;letter-spacing:0}.panel-b{padding:16px}
.routes{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.route{border:1px solid var(--line);border-radius:8px;padding:14px;background:#fbfcfb;min-width:0}
.route.good{border-color:rgba(23,114,69,.45)}.route.fast{border-color:rgba(29,95,209,.45)}.route.off{background:#f4f5f3;color:#717a74}
.label{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--muted);font-size:13px;margin-bottom:9px}
.badge{display:inline-flex;align-items:center;min-height:24px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--muted);font-size:12px;white-space:nowrap}
.badge.ok{border-color:rgba(23,114,69,.35);color:var(--green);background:#f1faf4}.badge.warn{border-color:rgba(154,91,0,.35);color:var(--amber);background:#fff8eb}
.addr{display:block;width:100%;min-height:44px;padding:9px 10px;border:1px dashed #b9c2bb;border-radius:6px;background:#fff;color:#111;font-size:20px;font-weight:700;line-height:1.2;word-break:break-all;user-select:all}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.btn{border:1px solid #202721;background:#202721;color:#fff;border-radius:6px;min-height:36px;padding:0 12px;cursor:pointer}
.btn.danger{background:#fff;color:var(--red);border-color:rgba(180,35,24,.35)}.btn:disabled{opacity:.45;cursor:not-allowed}
.note{color:var(--muted);font-size:13px;line-height:1.45;margin-top:9px}
.warning{border:1px solid rgba(154,91,0,.35);background:#fff8eb;color:#7a4600;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.45;margin-top:10px}
.ipbox{display:grid;gap:10px}
.ipline{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;background:#f8faf8;border:1px solid var(--line);border-radius:8px}
.ipline strong{font-size:18px;word-break:break-all}
.formrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
input{height:38px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:#fff;color:var(--text);min-width:0}
.table{display:grid;gap:8px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid var(--line);border-radius:8px;background:#fbfcfb;padding:10px}
.row-main{min-width:0}.row-title{font-weight:700;word-break:break-all}.row-meta{margin-top:4px;color:var(--muted);font-size:12px;line-height:1.35}
.empty{padding:20px 12px;text-align:center;color:var(--muted);border:1px dashed #c9d0ca;border-radius:8px;background:#fbfcfb}
.history{display:grid;gap:8px;max-height:560px;overflow:auto;padding-right:2px}
.event{border:1px solid var(--line);border-left:4px solid #8a938d;border-radius:8px;background:#fbfcfb;padding:10px}
.event.ok{border-left-color:var(--green)}.event.warn{border-left-color:var(--amber)}.event.bad{border-left-color:var(--red)}
.event-top{display:flex;justify-content:space-between;gap:10px;align-items:center}.event-kind{font-weight:700}.event-time{color:var(--muted);font-size:12px;white-space:nowrap}
.event p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.4;word-break:break-word}
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(16,24,20,.46);padding:18px;z-index:20}
.modal.open{display:flex}.modal-card{width:min(440px,100%);background:#fff;border-radius:8px;border:1px solid var(--line);box-shadow:var(--shadow);padding:20px}.modal-card h2{margin:0 0 8px;font-size:22px}.modal-card p{margin:0 0 14px;color:var(--muted);line-height:1.5}
.toast{position:fixed;right:18px;bottom:18px;max-width:min(420px,calc(100vw - 36px));background:#202721;color:#fff;border-radius:8px;padding:12px 14px;box-shadow:var(--shadow);display:none;z-index:30}.toast.show{display:block}
@media (max-width:920px){.top{grid-template-columns:1fr}.status{min-width:0}.grid,.routes{grid-template-columns:1fr}}
@media (max-width:560px){.wrap{width:min(100vw - 20px,1120px);padding-top:16px}.status{grid-template-columns:1fr}.panel-h{align-items:flex-start;flex-direction:column}.formrow,.row{grid-template-columns:1fr}.addr{font-size:17px}.event-top{align-items:flex-start;flex-direction:column;gap:4px}}
</style>
</head>
<body data-login-url="{{.LoginURL}}">
<main class="wrap">
 <section class="top">
  <div>
   <h1>RDP 安全入口</h1>
   <p class="lead">2FA 已通过。三条通路按需单独开通——点哪条开哪条，互不影响；窗口结束只阻止新连接，已建立会话继续保持。</p>
  </div>
  <div class="status">
   <div class="stat"><span>最近窗口</span><b id="countdown">--:--</b></div>
   <div class="stat"><span>当前出口 IP</span><b>{{if .ClientKnown}}{{.ClientIP}}{{else}}未知{{end}}</b></div>
   <div class="stat"><span>中转授权</span><b>{{if .IsPermanent}}长期{{else}}按需{{end}}</b></div>
  </div>
 </section>

 <section class="grid">
  <div class="stack">
   <section class="panel">
    <div class="panel-h">
     <h2>连接通路</h2>
     <span class="badge">单独开通 · 窗口 {{.TTLSeconds}} 秒</span>
    </div>
    <div class="panel-b">
     <div class="routes">
      <article class="route fast" id="route-v4">
       <div class="label"><span>IPv4 直连（推荐）</span><span class="badge warn" data-badge>未开通</span></div>
       <code class="addr" id="addr-v4">点击开通后显示</code>
       <div class="actions">
        <button class="btn" data-open="v4" {{if not .ClientKnown}}disabled{{end}}>开通 v4 直连</button>
        <button class="btn" data-copy="addr-v4" disabled>复制</button>
       </div>
       <div class="note" data-note>不经香港、同省直达（~25ms），带宽为家宽上行；仅放行当前出口 IP，连接期间自动保活、断线可原地重连。</div>
      </article>
      <article class="route fast" id="route-v6">
       <div class="label"><span>IPv6 直连</span><span class="badge warn" data-badge>未开通</span></div>
       <code class="addr" id="addr-v6">点击开通后显示</code>
       <div class="actions">
        <button class="btn" data-open="v6">开通 v6 直连</button>
        <button class="btn" data-copy="addr-v6" disabled>复制</button>
       </div>
       <div class="note" data-note>需当前网络有 IPv6 出网；开窗不限源，依赖 GUA 不可枚举 + 短窗口。</div>
      </article>
      <article class="route good" id="route-relay">
       <div class="label"><span>香港中转（托底）</span><span class="badge {{if .IsPermanent}}ok{{else}}warn{{end}}" data-badge>{{if .IsPermanent}}长期已生效{{else}}未开通{{end}}</span></div>
       <code class="addr" id="addr-relay">{{if .IsPermanent}}{{.RelayAddr}}{{else}}点击开通后显示{{end}}</code>
       <div class="actions">
        <button class="btn" data-open="relay" {{if not .ClientKnown}}disabled{{end}}>{{if .IsPermanent}}刷新中转{{else}}开通中转{{end}}</button>
        <button class="btn" data-copy="addr-relay" {{if not .IsPermanent}}disabled{{end}}>复制</button>
       </div>
       <div class="note" data-note>任意 IPv4 网络可用的兜底通路；延迟较高（~110ms）、带宽 2Mbps，直连不可用时再用。</div>
      </article>
     </div>
    </div>
   </section>

   <section class="panel">
    <div class="panel-h"><h3>长期白名单</h3><span class="badge">当前 IP 一键加入</span></div>
    <div class="panel-b ipbox">
     <div class="ipline">
      <span>当前出口</span>
      <strong>{{if .ClientKnown}}{{.ClientIP}}{{else}}无法识别{{end}}</strong>
     </div>
     <div class="formrow">
      <input id="wl-note" maxlength="80" placeholder="备注，例如 公司办公室 / 家里宽带">
      <button class="btn" id="add-wl" {{if not .ClientKnown}}disabled{{end}}>{{if .IsPermanent}}更新备注{{else}}加入长期白名单{{end}}</button>
     </div>
     <div class="note">长期白名单保存在网关状态文件中，并由服务持续刷新短 TTL 内核白名单；移除后应用层立即停止长期放行。</div>
    </div>
   </section>

   <section class="panel">
    <div class="panel-h"><h3>已加入白名单</h3><span class="badge">{{len .PermanentEntries}} 个</span></div>
    <div class="panel-b">
     {{if .PermanentEntries}}
     <div class="table">
      {{range .PermanentEntries}}
      <div class="row">
       <div class="row-main">
        <div class="row-title">{{.IP}} {{if .IsCurrent}}<span class="badge ok">当前</span>{{end}}</div>
        <div class="row-meta">{{if .Note}}{{.Note}} · {{end}}加入 {{.AddedAt}} · 最近使用 {{.LastSeen}}</div>
       </div>
       <button class="btn danger" data-remove="{{.IP}}">移除</button>
      </div>
      {{end}}
     </div>
     {{else}}
     <div class="empty">还没有长期白名单</div>
     {{end}}
    </div>
   </section>

   <section class="panel">
    <div class="panel-h"><h3>临时窗口</h3><span class="badge">{{len .TempEntries}} 个</span></div>
    <div class="panel-b">
     {{if .TempEntries}}
     <div class="table">
      {{range .TempEntries}}
      <div class="row">
       <div class="row-main">
        <div class="row-title">{{.IP}}</div>
        <div class="row-meta">剩余 {{.Remaining}} · 到期 {{.ExpiresAt}}</div>
       </div>
      </div>
      {{end}}
     </div>
     {{else}}
     <div class="empty">没有其他临时授权</div>
     {{end}}
    </div>
   </section>
  </div>

  <aside class="panel">
   <div class="panel-h"><h3>连接历史</h3><span class="badge">最近 {{len .History}}</span></div>
   <div class="panel-b">
    {{if .History}}
    <div class="history">
     {{range .History}}
     <article class="event {{.Tone}}">
      <div class="event-top"><span class="event-kind">{{.Kind}} · {{.Result}}</span><span class="event-time">{{.Time}}</span></div>
      <p>{{.IP}}{{if .Detail}} · {{.Detail}}{{end}}</p>
      {{if .V4Addr}}<p>IPv4 {{.V4Addr}}</p>{{end}}
      {{if .V6Addr}}<p>IPv6 {{.V6Addr}}</p>{{end}}
     </article>
     {{end}}
    </div>
    {{else}}
    <div class="empty">暂无历史</div>
    {{end}}
   </div>
  </aside>
 </section>
</main>

<div class="toast" id="toast"></div>

<script>
(function(){
  var routeExpires={};
  function showToast(msg){var t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},2600)}
  function copy(id){
    var el=document.getElementById(id);
    if(!el)return;
    var text=el.textContent.trim();
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){showToast("已复制")},function(){showToast(text)});
    }else{showToast(text)}
  }
  function fmtLeft(left){var m=Math.floor(left/60),s=left%60;return m+":"+(s<10?"0":"")+s}
  function tick(){
    var best=0;
    Object.keys(routeExpires).forEach(function(kind){
      var left=Math.max(0,Math.floor((routeExpires[kind]-Date.now())/1000));
      var card=document.getElementById("route-"+kind);
      if(card){
        var badge=card.querySelector("[data-badge]");
        if(left>0){badge.textContent="已开通 · 剩余 "+fmtLeft(left);badge.className="badge ok"}
        else{badge.textContent="窗口已结束";badge.className="badge warn";delete routeExpires[kind]}
      }
      if(left>best)best=left;
    });
    document.getElementById("countdown").textContent=best>0?fmtLeft(best):"--:--";
  }
  document.querySelectorAll("[data-open]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var kind=btn.dataset.open;
      btn.disabled=true;
      fetch("/api/open/"+kind,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
        .then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok){throw new Error(j.detail||j.error||"开通失败")}return j})})
        .then(function(j){
          var card=document.getElementById("route-"+kind);
          var addr=document.getElementById("addr-"+kind);
          if(addr&&j.addr)addr.textContent=j.addr;
          var copyBtn=card.querySelector("[data-copy]");if(copyBtn)copyBtn.disabled=false;
          var badge=card.querySelector("[data-badge]");
          if(j.permanent){badge.textContent="长期已生效";badge.className="badge ok"}
          else if(j.keepalive){badge.textContent="已开通 · 保活中";badge.className="badge ok"}
          else if(j.expires_at_unix){routeExpires[kind]=j.expires_at_unix*1000}
          if(j.detail){card.querySelector("[data-note]").textContent=j.detail}
          tick();
          showToast("已开通");
        })
        .catch(function(err){showToast(err.message)})
        .finally(function(){btn.disabled=false});
    });
  });
  document.querySelectorAll("[data-copy]").forEach(function(btn){btn.addEventListener("click",function(){copy(btn.dataset.copy)})});
  var add=document.getElementById("add-wl");
  if(add){
    add.addEventListener("click",function(){
      add.disabled=true;
      fetch("/api/whitelist/current",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note:document.getElementById("wl-note").value||""})})
        .then(function(r){if(!r.ok){return r.json().catch(function(){return {error:"请求失败"}}).then(function(j){throw new Error(j.detail||j.error||"请求失败")})}return r.json()})
        .then(function(){showToast("长期白名单已更新");setTimeout(function(){window.location.reload()},500)})
        .catch(function(err){showToast(err.message);add.disabled=false});
    });
  }
  document.querySelectorAll("[data-remove]").forEach(function(btn){
    btn.addEventListener("click",function(){
      btn.disabled=true;
      fetch("/api/whitelist/remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ip:btn.dataset.remove})})
        .then(function(r){if(!r.ok){throw new Error("移除失败")}return r.json()})
        .then(function(){showToast("已移除");setTimeout(function(){window.location.reload()},500)})
        .catch(function(err){showToast(err.message);btn.disabled=false});
    });
  });
  setInterval(tick,1000);
})();
</script>
</body>
</html>
`))

// ---------- 通用工具 ----------

func clientIPv4(r *http.Request) string {
	ip := normalizeIPv4(strings.TrimSpace(r.Header.Get("X-Real-IP")))
	if ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return normalizeIPv4(host)
}

func normalizeIPv4(v string) string {
	ip := net.ParseIP(strings.TrimSpace(v))
	if ip == nil || ip.To4() == nil {
		return ""
	}
	return ip.To4().String()
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func readJSONOrForm(r *http.Request, v any) error {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return json.NewDecoder(r.Body).Decode(v)
	}
	if err := r.ParseForm(); err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]string{
		"note": r.Form.Get("note"),
		"ip":   r.Form.Get("ip"),
	})
	return json.Unmarshal(b, v)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Local().Format("2006-01-02 15:04:05")
}

func compactDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d/time.Second))
	}
	return fmt.Sprintf("%dm%02ds", int(d/time.Minute), int((d%time.Minute)/time.Second))
}

func historyKindLabel(kind string) string {
	switch kind {
	case "unlock":
		return "授权"
	case "relay":
		return "中转开通"
	case "v4":
		return "v4 直连"
	case "v6":
		return "v6 直连"
	case "whitelist":
		return "白名单"
	case "tcp":
		return "TCP"
	case "udp":
		return "UDP"
	default:
		return kind
	}
}

func historyResultLabel(result string) string {
	switch result {
	case "ok":
		return "成功"
	case "partial":
		return "部分可用"
	case "failed":
		return "失败"
	case "accepted":
		return "已连接"
	case "denied":
		return "已拒绝"
	case "added":
		return "已加入"
	case "removed":
		return "已移除"
	default:
		return result
	}
}

func historyTone(result string) string {
	switch result {
	case "ok", "accepted", "added":
		return "ok"
	case "partial", "removed":
		return "warn"
	case "failed", "denied":
		return "bad"
	default:
		return ""
	}
}

func nonEmpty(values ...string) []string {
	res := make([]string, 0, len(values))
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			res = append(res, strings.TrimSpace(v))
		}
	}
	return res
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func firstNonZero(values ...int) int {
	for _, v := range values {
		if v != 0 {
			return v
		}
	}
	return 0
}

func trimRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envRequired(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("Environment variable %s is required", k)
	}
	return v
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
