// Command rdp-gateway —— RDP 安全网关「路径 B（香港公网中转）」+ Authelia 授权页，运行在 txhk。
//
// 单进程承担四件事（见 doc/RDP-GUARD.md §4）：
//  1. HTTP 授权页（127.0.0.1:8090，置于 Caddy forward_auth 之后；2FA 通过才可达）；
//  2. 把客户端 v4 写入 nft 白名单（内核 drop 闸，TTL）+ 内存白名单（应用层闸，纵深防御）；
//  3. 经 Tailscale 调 istoreos rdp6-agent 开 v6 pinhole 并取回当前 Win10 GUA；
//  4. TCP+UDP 代理 :33890 → 192.168.7.129:3389（替代 socat：单二进制、原生 UDP、无 per-conn fork）。
//
// 仅用标准库；以最小权限用户运行，写 nft 经受限 sudoers（见 hosts/txhk/sudoers/rdp-gateway）。
package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 配置（systemd EnvironmentFile 注入）
var (
	httpListen  = env("GW_HTTP_LISTEN", "127.0.0.1:8090")   // Caddy forward_auth 后端
	proxyListen = env("GW_PROXY_LISTEN", ":33890")           // 公网中转口（nft + 内存双闸）
	target      = env("GW_TARGET", "192.168.7.129:3389")     // 经 Tailscale 子网路由到达 Win10
	publicAddr  = env("GW_PUBLIC_ADDR", "43.129.195.4:33890") // 授权页展示用
	agentURL    = env("GW_AGENT_URL", "http://100.64.0.2:8091/open")
	nftSet      = env("GW_NFT_SET", "rdp_guard")
	nftBin      = env("GW_NFT_BIN", "/usr/sbin/nft")
	ttlSeconds  = envInt("GW_TTL", 180)
	token       = os.Getenv("RDP6_TOKEN")
)

func main() {
	log.SetFlags(log.LstdFlags)
	wl := newWhitelist()

	// 代理层先起（转发先于授权可用，连接来了即能用）
	go serveTCPProxy(proxyListen, target, wl)
	go serveUDPProxy(proxyListen, target, wl)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { handleUnlock(w, r, wl) })

	log.Printf("rdp-gateway: HTTP=%s 代理=%s 目标=%s TTL=%ds", httpListen, proxyListen, target, ttlSeconds)
	srv := &http.Server{Addr: httpListen, Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

// handleUnlock：2FA 已由 Caddy forward_auth 保证。写 v4 白名单 + 开 v6 + 返回连接页。
func handleUnlock(w http.ResponseWriter, r *http.Request, wl *whitelist) {
	// 只信 Caddy 注入的 X-Real-IP（{remote_host}，TCP 对端，无法伪造）
	clientIP := strings.TrimSpace(r.Header.Get("X-Real-IP"))
	if ip := net.ParseIP(clientIP); ip != nil && ip.To4() != nil {
		wl.Add(clientIP, time.Duration(ttlSeconds)*time.Second)
		if err := nftAllowV4(clientIP); err != nil {
			log.Printf("rdp-gateway: nft 写白名单失败 ip=%s: %v", clientIP, err)
		} else {
			log.Printf("rdp-gateway: 已放行 v4 %s（%ds）", clientIP, ttlSeconds)
		}
	} else {
		log.Printf("rdp-gateway: X-Real-IP 非法或非 v4: %q", clientIP)
	}

	// 经 Tailscale 触发 v6 pinhole 并取回当前 GUA（路径 A）
	v6 := ""
	if gua, port, ok := callAgent(); ok {
		v6 = fmt.Sprintf("[%s]:%d", gua, port)
		log.Printf("rdp-gateway: v6 直连已就绪 %s", v6)
	} else {
		log.Printf("rdp-gateway: v6 直连本次不可用（agent 无响应/无 v6）")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pageTmpl.Execute(w, pageData{V6Addr: v6, V4Addr: publicAddr, TTLMin: ttlSeconds / 60})
}

// callAgent 经 Tailscale 调 istoreos rdp6-agent，开 v6 pinhole 并取回 GUA。
func callAgent() (gua string, port int, ok bool) {
	if agentURL == "" || token == "" {
		return "", 0, false
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(agentURL + "?token=" + url.QueryEscape(token))
	if err != nil {
		log.Printf("rdp-gateway: 调 agent 失败: %v", err)
		return "", 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("rdp-gateway: agent 返回 %d", resp.StatusCode)
		return "", 0, false
	}
	var r struct {
		GUA  string `json:"gua"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.GUA == "" {
		return "", 0, false
	}
	if r.Port == 0 {
		r.Port = 3389
	}
	return r.GUA, r.Port, true
}

// nftAllowV4 把客户端 v4 加入 nft 白名单（内核 drop 闸）。经受限 sudoers 提权。
func nftAllowV4(ip string) error {
	out, err := exec.Command("sudo", nftBin, "add", "element", "inet", nftSet, "allowed_ips",
		fmt.Sprintf("{ %s timeout %ds }", ip, ttlSeconds)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------- 内存白名单（应用层闸，纵深防御）----------

type whitelist struct {
	mu sync.RWMutex
	m  map[string]time.Time // IP → 过期时刻
}

func newWhitelist() *whitelist { return &whitelist{m: make(map[string]time.Time)} }

func (w *whitelist) Add(ip string, ttl time.Duration) {
	w.mu.Lock()
	w.m[ip] = time.Now().Add(ttl)
	w.mu.Unlock()
}

func (w *whitelist) Allowed(ip string) bool {
	w.mu.RLock()
	exp, ok := w.m[ip]
	w.mu.RUnlock()
	return ok && time.Now().Before(exp)
}

// ---------- TCP 代理 ----------

func serveTCPProxy(listen, target string, wl *whitelist) {
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
		go handleTCP(c, target, wl)
	}
}

func handleTCP(c net.Conn, target string, wl *whitelist) {
	defer c.Close()
	host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	if !wl.Allowed(host) {
		log.Printf("rdp-gateway: 拒绝未授权 TCP 源 %s", host)
		return
	}
	up, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		log.Printf("rdp-gateway: 连目标 %s 失败: %v", target, err)
		return
	}
	defer up.Close()
	errc := make(chan error, 2)
	go func() { _, e := io.Copy(up, c); errc <- e }()
	go func() { _, e := io.Copy(c, up); errc <- e }()
	<-errc
}

// ---------- UDP 代理（RDP-UDP，per-client 会话 + 空闲回收）----------

func serveUDPProxy(listen, target string, wl *whitelist) {
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

	const idle = 60 * time.Second
	var mu sync.Mutex
	sessions := map[string]*net.UDPConn{} // clientAddr → 到目标的 conn
	buf := make([]byte, 65535)
	for {
		n, caddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		if !wl.Allowed(caddr.IP.String()) {
			continue
		}
		key := caddr.String()
		mu.Lock()
		up := sessions[key]
		if up == nil {
			up, err = net.DialUDP("udp", nil, raddr)
			if err != nil {
				mu.Unlock()
				continue
			}
			sessions[key] = up
			// 回程：从目标读 → 写回客户端；空闲超时即收会话
			go func(up *net.UDPConn, caddr *net.UDPAddr, key string) {
				b := make([]byte, 65535)
				for {
					_ = up.SetReadDeadline(time.Now().Add(idle))
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

// ---------- 授权页 ----------

type pageData struct {
	V6Addr string
	V4Addr string
	TTLMin int
}

var pageTmpl = template.Must(template.New("page").Parse(`<!doctype html>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>RDP 已授权</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#1c1c1e}
 h2{margin:.2em 0}.sub{color:#6b7280;font-size:.9em}
 .card{border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:12px 0}
 .card.v6{border-color:#34c759}.card.v4{border-color:#0a84ff}.card.off{border-color:#d1d5db;color:#9ca3af}
 .lbl{font-size:.85em;color:#6b7280}.addr{font-size:1.25em;font-weight:600;word-break:break-all;user-select:all}
 button{margin-top:8px;border:0;border-radius:8px;padding:8px 14px;background:#111827;color:#fff;font-size:.95em}
 .tip{font-size:.85em;color:#6b7280;margin-top:6px}#cd{font-weight:600}
</style>
<h2>✅ 已授权</h2>
<p class=sub>约 <span id=cd>{{.TTLMin}}:00</span> 内有效，用原生 mstsc 连接：</p>
{{if .V6Addr}}
<div class="card v6">
 <div class=lbl>① IPv6 直连（最快，需公司有 v6 出网）</div>
 <div class=addr id=v6>{{.V6Addr}}</div>
 <button onclick="cp('v6')">复制</button>
 <div class=tip>mstsc 计算机处直接粘贴；地址不公开、随前缀漂移，仅本次有效</div>
</div>
{{else}}
<div class="card off">
 <div class=lbl>① IPv6 直连</div>
 <div>本次不可用（公司无 v6 或家侧 agent 无响应）——请用下方中转</div>
</div>
{{end}}
<div class="card v4">
 <div class=lbl>② 香港中转（兜底，任意网络可用）</div>
 <div class=addr id=v4>{{.V4Addr}}</div>
 <button onclick="cp('v4')">复制</button>
 <div class=tip>仅放行你当前出口 IP，{{.TTLMin}} 分钟后新连接被拒；已建立会话不掉线</div>
</div>
<script>
 function cp(id){var t=document.getElementById(id).innerText;navigator.clipboard&&navigator.clipboard.writeText(t)}
 var s={{.TTLMin}}*60,e=document.getElementById('cd');setInterval(function(){if(s<=0){e.innerText='已过期，请刷新重新授权';return}s--;var m=Math.floor(s/60),x=s%60;e.innerText=m+':'+(x<10?'0':'')+x},1000);
</script>
`))

// ---------- 通用工具 ----------

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
