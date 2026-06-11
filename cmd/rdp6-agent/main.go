// Command rdp6-agent —— RDP 安全网关「路径 A（IPv6 直连）」家侧执行面，运行在 istoreos。
//
// 设计要点（见 doc/RDP-GUARD.md §6 / §8.3）：
//   - 仅监听 Tailscale 接口（如 100.64.0.2:8091），绝不绑 0.0.0.0 —— 家里零新增公网服务。
//   - 受 txhk 控制面（2FA 通过后）经 Tailscale 内网调用；token 常量时间比对，防猜测。
//   - GUA 由服务端发现/计算，不接受客户端传入 —— 无注入面。
//   - 动作上限：把 Win10 当前真实 GUA 加入 fw4 集合 rdp6_open（带 TTL），即开一个短窗口的 v6 pinhole。
//
// IPv6 获取法（裁决 3，优先级见 resolveGUA）：实时发现 Win10 真实持有的 GUA，
// 优先「EUI-64 计算值且邻居表已观测到」→「邻居表任一全局地址」→「DHCPv6 租约」→「EUI-64 计算值」→「::hostid」。
package main

import (
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 配置（环境变量注入；procd 从 /opt/rdp6-agent/token 读 token 传入 RDP6_TOKEN）
var (
	listenAddr = env("RDP6_LISTEN", "100.64.0.2:8091") // 仅 Tailscale IP，绝不 0.0.0.0
	win10MAC   = strings.ToLower(env("RDP6_WIN10_MAC", "bc:24:11:98:25:18"))
	lanIf      = env("RDP6_LAN_IF", "br-lan")
	hostID     = env("RDP6_HOSTID", "129") // ::129 兜底（odhcpd hostid 为十六进制）
	nftSet     = env("RDP6_NFT_SET", "rdp6_open")
	rdpPort    = envInt("RDP6_RDP_PORT", 3389)
	ttlSeconds = envInt("RDP6_TTL", 180)
	token      = os.Getenv("RDP6_TOKEN")

	// 路径 A-v4（IPv4 直连）：家宽为公网动态 v4（PPPoE），DNAT/SNAT 静态链见
	// /etc/nftables.d/90-rdp4-dnat.nft，本 agent 只负责把 2FA 客户端 v4 写入限源集合。
	v4NftSet  = env("RDP4_NFT_SET", "rdp4_clients")
	v4ExtPort = envInt("RDP4_EXT_PORT", 33891) // 家宽公网入口端口（DNAT → Win10:3389）
	wanIface  = env("RDP4_WAN_IFACE", "wan")   // ubus 逻辑接口名（pppoe-wan 的 uci 名）
)

var openState = newAgentState()
var v4State = newAgentState()

func main() {
	log.SetFlags(log.LstdFlags)
	if token == "" {
		log.Fatal("rdp6-agent: RDP6_TOKEN 为空，拒绝启动")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/open", handleOpen)
	mux.HandleFunc("/open4", handleOpenV4)
	mux.HandleFunc("/status", handleStatus)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}
	// Tailscale 接口可能晚于本服务就绪：绑定失败时退避重试，而非直接崩溃（procd 也会 respawn 兜底）。
	for {
		ln, err := net.Listen("tcp", listenAddr)
		if err != nil {
			log.Printf("rdp6-agent: 监听 %s 失败（Tailscale 可能未就绪），3s 后重试: %v", listenAddr, err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Printf("rdp6-agent: 已监听 %s（仅 Tailscale），目标 MAC=%s 接口=%s TTL=%ds", listenAddr, win10MAC, lanIf, ttlSeconds)
		if err := srv.Serve(ln); err != nil {
			log.Fatalf("rdp6-agent: serve 退出: %v", err)
		}
	}
}

// handleOpen 校验 token → 发现 Win10 GUA → 写 fw4 set 开 pinhole → 返回 GUA。
func handleOpen(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r) {
		return
	}
	gua, source, err := resolveGUA()
	if err != nil {
		log.Printf("rdp6-agent: 解析 GUA 失败: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "resolve gua failed"})
		return
	}
	if err := openPinhole(gua); err != nil {
		log.Printf("rdp6-agent: 写 fw4 set 失败 gua=%s: %v", gua, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "open pinhole failed"})
		return
	}
	expiresAt := time.Now().Add(time.Duration(ttlSeconds) * time.Second)
	openState.Set(gua, source, expiresAt)
	log.Printf("rdp6-agent: 已开窗 gua=%s 来源=%s ttl=%ds", gua, source, ttlSeconds)
	writeJSON(w, http.StatusOK, map[string]any{
		"gua": gua, "port": rdpPort, "ttl": ttlSeconds, "source": source, "expires_at": expiresAt.Format(time.RFC3339),
	})
}

// handleOpenV4 校验 token → 校验客户端 v4 → 写 fw4 限源集合开 v4 DNAT 窗口 → 返回家宽当前公网 v4。
// 与 /open（v6，开窗不限源）不同：v4 直连按客户端源 IP 精确放行，未授权源不命中 DNAT、落入 fw4 默认拒绝。
func handleOpenV4(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r) {
		return
	}
	client := parseClientV4(r.URL.Query().Get("client"))
	if client == "" {
		log.Printf("rdp6-agent: /open4 客户端 v4 非法: %q", r.URL.Query().Get("client"))
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid client ipv4"})
		return
	}
	wan4, err := currentWAN4()
	if err != nil {
		log.Printf("rdp6-agent: 解析家宽公网 v4 失败: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "resolve wan ipv4 failed: " + err.Error()})
		return
	}
	if err := openV4Pinhole(client); err != nil {
		log.Printf("rdp6-agent: 写 fw4 set %s 失败 client=%s: %v", v4NftSet, client, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "open v4 pinhole failed"})
		return
	}
	expiresAt := time.Now().Add(time.Duration(ttlSeconds) * time.Second)
	v4State.Set(client+" → "+wan4, "wan4", expiresAt)
	log.Printf("rdp6-agent: 已开 v4 直连窗口 client=%s wan=%s:%d ttl=%ds", client, wan4, v4ExtPort, ttlSeconds)
	writeJSON(w, http.StatusOK, map[string]any{
		"v4": wan4, "port": v4ExtPort, "ttl": ttlSeconds, "client": client, "expires_at": expiresAt.Format(time.RFC3339),
	})
}

// handleStatus 返回 agent 当前解析状态与最近一次开窗，不修改 fw4 set。
func handleStatus(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r) {
		return
	}
	status := map[string]any{
		"listen":       listenAddr,
		"lan_if":       lanIf,
		"win10_mac":    win10MAC,
		"nft_set":      nftSet,
		"rdp_port":     rdpPort,
		"ttl":          ttlSeconds,
		"last_open":    openState.Snapshot(),
		"v4_nft_set":   v4NftSet,
		"v4_ext_port":  v4ExtPort,
		"last_open_v4": v4State.Snapshot(),
		"checked_at":   time.Now().Format(time.RFC3339),
	}
	if wan4, err := currentWAN4(); err != nil {
		status["wan4_error"] = err.Error()
	} else {
		status["wan4"] = wan4
	}
	if gua, source, err := resolveGUA(); err != nil {
		status["resolve_error"] = err.Error()
	} else {
		status["gua"] = gua
		status["source"] = source
	}
	writeJSON(w, http.StatusOK, status)
}

func authorized(w http.ResponseWriter, r *http.Request) bool {
	got := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
		log.Printf("rdp6-agent: 错误 token，来自 %s", r.RemoteAddr)
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return false
	}
	return true
}

type agentState struct {
	mu        sync.RWMutex
	GUA       string    `json:"gua,omitempty"`
	Source    string    `json:"source,omitempty"`
	OpenedAt  time.Time `json:"opened_at,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
}

func newAgentState() *agentState { return &agentState{} }

func (s *agentState) Set(gua, source string, expiresAt time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.GUA = gua
	s.Source = source
	s.OpenedAt = time.Now()
	s.ExpiresAt = expiresAt
}

func (s *agentState) Snapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.GUA == "" {
		return nil
	}
	return map[string]any{
		"gua":        s.GUA,
		"source":     s.Source,
		"opened_at":  s.OpenedAt.Format(time.RFC3339),
		"expires_at": s.ExpiresAt.Format(time.RFC3339),
		"active":     time.Now().Before(s.ExpiresAt),
	}
}

// resolveGUA 发现 Win10 当前真实 GUA。返回地址字符串与命中来源。
func resolveGUA() (string, string, error) {
	prefix, err := currentPrefix() // 当前全局 /64 前缀（前 8 字节有效）
	if err != nil {
		return "", "", err
	}

	// 候选 1：EUI-64 计算值（确定性，依赖 Win10 关闭隐私/随机接口 ID，见 §7 脚本）
	eui := withIID(prefix, eui64IID(win10MAC))

	// 候选 2：邻居表里该 MAC 的全局地址（捕获 Win10 实际持有的 SLAAC 地址）
	neigh := filterInPrefix(neighGUAs(win10MAC), prefix)

	// 优先返回「EUI-64 且邻居表已观测到」—— 既确定性又确认 Win10 真持有
	if eui != nil && containsIP(neigh, eui) {
		return eui.String(), "eui64-observed", nil
	}
	// 其次：邻居表任一全局地址（Win10 真实持有，可能是 stable-privacy）
	if len(neigh) > 0 {
		return neigh[0].String(), "neigh", nil
	}
	// 再次：DHCPv6 租约（Win10 走 DHCPv6 时最权威，含 ::hostid 预留命中）
	if lease := filterInPrefix(leaseGUAs(win10MAC), prefix); len(lease) > 0 {
		return lease[0].String(), "dhcpv6-lease", nil
	}
	// 兜底：::hostid（依赖 DHCPv6 预留；优先于 EUI-64 猜测，因 Win10 实测用 stable-privacy 而非 EUI-64）
	if hid := withIID(prefix, hostIDIID(hostID)); hid != nil {
		return hid.String(), "hostid-computed", nil
	}
	// 末路：EUI-64 计算值（仅当以上全失败；对启用 stable-privacy 的 Win10 不成立，故置末位）
	if eui != nil {
		return eui.String(), "eui64-computed", nil
	}
	return "", "", fmt.Errorf("无法确定 Win10 GUA")
}

// currentPrefix 读 br-lan 当前全局 /64 前缀（排除 ULA/链路本地）。
func currentPrefix() (net.IP, error) {
	out, err := run("ip", "-6", "addr", "show", "dev", lanIf, "scope", "global")
	if err != nil {
		return nil, fmt.Errorf("ip addr: %w", err)
	}
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimSpace(ln)
		if !strings.HasPrefix(ln, "inet6 ") {
			continue
		}
		cidr := strings.Fields(ln)[1] // 2408:832e:208a:abe0::1/60
		ip, _, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		ip = ip.To16()
		if ip == nil || !isGlobalUnicast(ip) {
			continue // 跳过 fde1:: (ULA)、fe80:: (link-local)
		}
		return ip.Mask(net.CIDRMask(64, 128)), nil
	}
	return nil, fmt.Errorf("%s 上无全局 IPv6 前缀", lanIf)
}

// neighGUAs 读邻居表中指定 MAC 的全局 IPv6 地址。
func neighGUAs(mac string) []net.IP {
	out, err := run("ip", "-6", "neigh", "show", "dev", lanIf)
	if err != nil {
		return nil
	}
	var res []net.IP
	for _, ln := range strings.Split(out, "\n") {
		f := strings.Fields(ln) // <addr> lladdr <mac> <state>
		if len(f) < 4 {
			continue
		}
		var lladdr string
		for i := 0; i < len(f)-1; i++ {
			if f[i] == "lladdr" {
				lladdr = strings.ToLower(f[i+1])
			}
		}
		if lladdr != mac {
			continue
		}
		ip := net.ParseIP(f[0]).To16()
		if ip != nil && isGlobalUnicast(ip) {
			res = append(res, ip)
		}
	}
	return res
}

// leaseGUAs 从 odhcpd 读指定 MAC 的 DHCPv6 全局地址。
// 通过 DUID 末尾嵌入的 MAC 匹配（DUID-LL/LLT 末 6 字节即 MAC）。
func leaseGUAs(mac string) []net.IP {
	out, err := run("ubus", "call", "dhcp", "ipv6leases")
	if err != nil {
		return nil
	}
	var parsed struct {
		Device map[string]struct {
			Leases []struct {
				DUID string `json:"duid"`
				Addr []struct {
					Address string `json:"address"`
				} `json:"ipv6-addr"`
			} `json:"leases"`
		} `json:"device"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return nil
	}
	macHex := strings.ReplaceAll(mac, ":", "")
	var res []net.IP
	for _, dev := range parsed.Device {
		for _, l := range dev.Leases {
			if !strings.HasSuffix(strings.ToLower(l.DUID), macHex) {
				continue
			}
			for _, a := range l.Addr {
				if ip := net.ParseIP(a.Address).To16(); ip != nil && isGlobalUnicast(ip) {
					res = append(res, ip)
				}
			}
		}
	}
	return res
}

// openPinhole 把 GUA 加入 fw4 集合 rdp6_open（带 TTL），即开 v6 pinhole。agent 以 root 运行，无需 sudo。
func openPinhole(gua string) error {
	_, err := run("nft", "add", "element", "inet", "fw4", nftSet,
		"{", gua, "timeout", fmt.Sprintf("%ds", ttlSeconds), "}")
	return err
}

// openV4Pinhole 把客户端 v4 加入 fw4 限源集合 rdp4_clients（带 TTL）。
// 集合由 uci firewall 声明；DNAT/SNAT 静态链见 /etc/nftables.d/90-rdp4-dnat.nft，仅对集合内源生效。
func openV4Pinhole(client string) error {
	_, err := run("nft", "add", "element", "inet", "fw4", v4NftSet,
		"{", client, "timeout", fmt.Sprintf("%ds", ttlSeconds), "}")
	return err
}

// parseClientV4 校验调用方传入的客户端地址：必须是全局单播 IPv4。
func parseClientV4(v string) string {
	ip := net.ParseIP(strings.TrimSpace(v))
	if ip == nil || ip.To4() == nil || !ip.IsGlobalUnicast() {
		return ""
	}
	return ip.To4().String()
}

// currentWAN4 经 ubus 读 WAN 口当前 IPv4；若为私网/CGNAT 段则报错（v4 直连依赖公网入站）。
func currentWAN4() (string, error) {
	out, err := run("ubus", "call", fmt.Sprintf("network.interface.%s", wanIface), "status")
	if err != nil {
		return "", fmt.Errorf("ubus wan status: %w", err)
	}
	var parsed struct {
		Addrs []struct {
			Address string `json:"address"`
		} `json:"ipv4-address"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return "", fmt.Errorf("解析 wan status: %w", err)
	}
	if len(parsed.Addrs) == 0 {
		return "", fmt.Errorf("wan 口无 IPv4 地址")
	}
	ip := net.ParseIP(parsed.Addrs[0].Address)
	if ip == nil || ip.To4() == nil {
		return "", fmt.Errorf("wan IPv4 非法: %q", parsed.Addrs[0].Address)
	}
	if !isPublicV4(ip) {
		return "", fmt.Errorf("wan IPv4 %s 非公网（CGNAT/私网），v4 直连不可用", ip)
	}
	return ip.To4().String(), nil
}

// isPublicV4 排除私网、CGNAT（100.64/10）、链路本地与回环。
func isPublicV4(ip net.IP) bool {
	for _, cidr := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"} {
		_, n, _ := net.ParseCIDR(cidr)
		if n.Contains(ip) {
			return false
		}
	}
	return ip.IsGlobalUnicast()
}

// ---------- 地址构造工具 ----------

// eui64IID 由 MAC 计算 EUI-64 接口标识（翻转 U/L 位，中插 ff:fe）。
func eui64IID(mac string) []byte {
	hw, err := net.ParseMAC(mac)
	if err != nil || len(hw) != 6 {
		return nil
	}
	iid := []byte{hw[0] ^ 0x02, hw[1], hw[2], 0xff, 0xfe, hw[3], hw[4], hw[5]}
	return iid
}

// hostIDIID 由 odhcpd hostid（十六进制）构造接口标识，如 "129" → ::0129。
func hostIDIID(hid string) []byte {
	v, err := strconv.ParseUint(hid, 16, 64)
	if err != nil {
		return nil
	}
	iid := make([]byte, 8)
	binary.BigEndian.PutUint64(iid, v)
	return iid
}

// withIID 用前 8 字节前缀 + 8 字节接口标识拼出完整地址。
func withIID(prefix net.IP, iid []byte) net.IP {
	if prefix == nil || len(iid) != 8 {
		return nil
	}
	ip := make(net.IP, 16)
	copy(ip[:8], prefix.To16()[:8])
	copy(ip[8:], iid)
	return ip
}

// isGlobalUnicast 判断是否 2000::/3 全局单播（排除 ULA fc00::/7、链路本地 fe80::/10）。
func isGlobalUnicast(ip net.IP) bool {
	ip = ip.To16()
	return ip != nil && ip[0]&0xe0 == 0x20
}

func filterInPrefix(ips []net.IP, prefix net.IP) []net.IP {
	var res []net.IP
	p := prefix.To16()
	for _, ip := range ips {
		if b := ip.To16(); b != nil && string(b[:8]) == string(p[:8]) {
			res = append(res, ip)
		}
	}
	return res
}

func containsIP(ips []net.IP, target net.IP) bool {
	for _, ip := range ips {
		if ip.Equal(target) {
			return true
		}
	}
	return false
}

// ---------- 通用工具 ----------

func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
