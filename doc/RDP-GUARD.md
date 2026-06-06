# RDP 安全网关实施方案 v3.2

> **目标**：让「装不了 Tailscale 的临时设备」通过原生 RDP（mstsc）安全连接家里内网的 Win10（192.168.7.129）。
> **架构**：**双路径** —— 快车道 A（IPv6 端到端直连，公司侧有 v6 时启用，最低延迟）+ 兜底 B（txhk 香港公网中转，任意 IPv4 客户端永远可用）。
> **认证底座**：Authelia 2FA → 动态防火墙白名单（短 TTL）；最后底线：Windows NLA + 弱权账户 + 账户锁定。
>
> **v3.2 关键变更（2026-06-06 实测驱动）**：
> 1. **推翻 v3.1 的延迟归因**：实测 `tailscale ping` 证明 txhk→home 的 80–100ms 不是物理延迟，而是 **Tailscale 公共香港 DERP 绕行（130ms）**；真实直连仅 **52ms**。新增 §3 实测与 §4.1 中转优化（txhk 内嵌 DERP），把中转路径从 ~170ms 砍到 ~90–100ms，**零成本、不买 VPS、不碰 AD**。
> 2. **恢复 IPv6 直连快车道**：v3.1 因「Win10 无 v6」误删了 v6 路径。实测家里路由器握有完整公网 `/60`、RA 服务已开、LAN 设备已在分配公网 GUA —— v6 基础早已就绪。Win10「无 v6」是关机 21 天的过期观测。详见 §5/§6。
> 3. **新增 §8 安全审查**：对全部新增改动（尤其 **headscale 内嵌 DERP**）做机密性 / 暴露面 / 信任边界 / 可用性分析。
>
> v3.1 的核心加固（nftables 白名单、unlock 服务、Caddy、Win10 加固、P0 修复）保留并增强。v1.0/v2.0 数据已过期，**勿再参照**。

---

## 0. 前置修复记录（2026-06-05，已完成）

部署本方案前必须保证 Tailscale 子网路由可用。06-04 给 txhk 上 Authelia 时引发**两个连锁故障**，导致所有 Tailscale 节点控制面失联。已修复：

| 编号 | 根因 | 修复 | 验证 |
|------|------|------|------|
| P0-1 | txhk 的 Caddy 给 `headscale.singll.net` 整站套了 `forward_auth`（Authelia 2FA），节点用 machine key 走 `/key`、`/ts2021` 控制协议无法过 2FA → 控制面被 302 拦截 | `hosts/txhk/caddy/Caddyfile` 移除 headscale 段的 `forward_auth`，仅保留 `reverse_proxy 127.0.0.1:8080` | `curl /key` 由 302 变 400（直达 Headscale） |
| P0-2 | 家里 istoreos 的 openclash 把 `headscale.singll.net` 分配成 fake-ip（198.18.0.30），本机 tailscaled 连控制面被劫持走代理 → noise 握手 `EOF` | `hosts/istoreos/openclash/openclash_custom_overwrite.sh` 的 `fake-ip-filter` 增加 `+.singll.net`，重启 openclash | 解析回归 43.129.195.4；`route` 节点恢复 online |

> **经验**：部署在 txhk 的自建服务域名（headscale/auth/matrix/ntfy）必须用真实公网 IP 直连，既不能套面向人的 2FA，也不能进 openclash 的 fake-ip/代理。
> **v3.2 强化**：§4.1 的内嵌 DERP 也跑在 `headscale.singll.net/derp` 上，**P0-1（不套 forward_auth）和 P0-2（fake-ip 豁免 `+.singll.net`）现在同时守护着 DERP**。任何回退这两条修复的操作都会同时打断控制面和 DERP 中继。

**修复后验收（实测）**：

```
route: online   txhk: online
txhk → ping 192.168.7.129 : OK
txhk → 192.168.7.129:3389  : OPEN
```

---

## 1. 环境现状（2026-06-06 实测）

### 1.1 txhk 云服务器（中转入口 / 控制面 / DERP）

| 项目 | 值 | 备注 |
|------|-----|------|
| 公网 IPv4 | `43.129.195.4` | 腾讯云 EIP，本机 eth0 实为 `172.19.0.11`（云内网，DNAT 映射） |
| 公网 IPv6 | **无（实测 rc=1）** | 仅 Tailscale ULA `fd7a:115c:a1e0::3`。**txhk 无任何全球 v6 出口** → v6 只能用于「公司↔家」端到端，帮不了香港中转段 |
| 系统 | Ubuntu 22.04 LTS | Python 3.10（不触发 PEP668） |
| Caddy | v2.10.2 | 入口反代，`*:443`，systemd，配置 `/etc/caddy/Caddyfile` |
| headscale | `127.0.0.1:8080`（Caddy 反代 `headscale.singll.net`） | `server_url: https://headscale.singll.net`；DERP 当前 `enabled: false`，用公共 derpmap |
| Authelia | `127.0.0.1:9091` | session `1h`/inactivity `5m`；regulation `3 次/2min → 封 5min`；ACL `*.singll.net → two_factor` |
| 当前对外监听 | `tcp/443`(caddy) + `udp/41641`(tailscaled) | **`udp/3478` 当前关闭** → 启用内嵌 DERP 需新开（§8.1） |
| 防火墙 | iptables-nft `table ip filter`（Tailscale 装）；`inet` family 空闲，建 `rdp_guard` 表共存 | 另有腾讯云安全组（云防火墙），开端口需同步放行 |

### 1.2 家里网络（被连目标侧）

| 项目 | 值 | 结论 |
|------|-----|------|
| 路由器 | iStoreOS `192.168.7.1`（spool 主机 `istoreos` = Tailscale `route` `100.64.0.2`），跑 Caddy/Authelia/homepage/openclash（Docker）+ tailscaled（subnet router + exit node） | 子网路由把 `192.168.7.0/24` 宣告给 txhk |
| Win10 | `192.168.7.129`，RDP 3389 开放 | Tailscale `future` `100.64.0.1`，**当前关机（21 天）** |
| **IPv4 公网入站** | PPPoE 接口 `113.227.140.75`，实际出口经运营商 NAT | **CGNAT，无法接受无请求入站**；但 **UDP 打洞可穿透**（实测 Tailscale 直连成功打到 `113.227.140.75:41641`，见 §3） |
| **IPv6 公网（家侧）** | br-lan 持公网 `2408:832e:208a:abe0::1/60`（联通，有 v6 默认路由）；`dhcp.lan.ra='server'`/`dhcpv6='server'`/`ra_default=1` **已开**；LAN 设备**已在分配公网 GUA**（实测 neigh 表多个 `2408:832e:208a:abe0:*`） | **家侧 v6 基础已就绪**。v3.1「Win10 无 v6」系关机期间的过期观测，需 Win10 开机后复测（§5） |
| **家侧入站 v6 默认策略** | `network.wan.ipv6='auto'`（v6 在 wan/PPPoE 同接口）；firewall `wan` zone `input=REJECT`/`forward=REJECT` **覆盖 v6** | **入站 v6 默认拒绝** → 开公网 v6 不会自动暴露 LAN；v6 直连需**显式 + 受控**的 pinhole（§6） |

### 1.3 关键结论

- ❌ **IPv4 动态直连不可行**：家里是运营商共享 NAT 出口，端口不归你，DDNS 也无法入站。
- ✅ **IPv4 必须经 txhk 中转**（路径 B）：任何 v4 客户端可用，是「保证可用」的兜底基线。
- ✅ **txhk→home 的延迟可砍半**：实测瓶颈是公共 DERP 绕行（130ms），直连仅 52ms。txhk 内嵌 DERP 可把这段锁定 ~52ms（§4.1）。
- △ **IPv6 端到端直连是唯一能消除「香港 trombone」的路径**（路径 A）：家侧已就绪，**唯一未知是公司电脑是否有 v6 出网**（§6 提供测试）。成立则 ~30–60ms，最低延迟。

---

## 2. 架构总览：双路径

```
                        ┌─────────────────────────────────────────────┐
                        │  公司临时设备（仅原生 mstsc，禁装虚拟网卡）   │
                        └───────────────┬───────────────┬─────────────┘
              ┌─────────────────────────┘               └──────────────────────────┐
              ▼ 路径 A（快车道，公司有 v6 时）            ▼ 路径 B（兜底，永远可用）
   IPv6 端到端直连（不经香港）                  mstsc → 43.129.195.4:33890（txhk）
   mstsc → [Win10 公网 GUA]:3389                   → nft 白名单 gate（2FA 解锁）
     → 家侧 2FA 动态 pinhole（§6）                   → socat（TCP+UDP）
     → istoreos 转发 → Win10:3389                    → Tailscale 直连/内嵌DERP（§4.1）
   延迟 ~30–60ms（估，全程国内单段）                 → route → Win10:3389
                                                     延迟 ~90–100ms（优化后；原 ~170ms）
```

| 维度 | 路径 A：IPv6 直连 | 路径 B：txhk 中转（优化后） |
|------|------------------|----------------------------|
| 前提 | **公司电脑有 v6 出网**（未知，需测）+ Win10 有公网 GUA | 仅需客户端有 v4（**永远满足**） |
| 路径 | 公司 → 家（直连，无香港） | 公司 → 香港 txhk → Tailscale 直连/DERP → route → Win10 |
| 延迟 | ~30–60ms（估，消除 trombone） | ~90–100ms（直连/内嵌 DERP）；未优化时 ~170ms |
| 暴露面 | istoreos v6:443（unlock）+ Win10 v6:3389（gated） | txhk:33890（nft 白名单）+ txhk:443（Authelia） |
| 安全门 | 家侧 Authelia 2FA → istoreos nft `inet6` 动态 pinhole | txhk Authelia 2FA → txhk nft `inet` 动态白名单 |
| 落地难度 | 中（家侧需 unlock + v6 pinhole） | 中（已有 Authelia/Caddy/Tailscale，加 DERP + UDP） |
| 定位 | 有 v6 时优先（最低延迟） | 默认兜底（无 v6 / 公司封 v6 时） |

> **决策**：先按 §6.1 测公司 v6。**有 v6** → 部署路径 A 为主、B 为兜底（双路径并存）。**无 v6** → 仅部署优化后的路径 B。两条路径互不依赖，可分别启停。

---

## 3. 延迟实测与归因（推翻 v3.1 估算）

### 3.1 实测证据：DERP 绕行才是瓶颈

`spool exec txhk "tailscale ping -c 12 100.64.0.2"`（txhk → 家里 route 节点）：

```
pong from route (100.64.0.2) via DERP(hkg) in 131ms     ← 冷启动走 Tailscale 公共香港 DERP
pong from route (100.64.0.2) via DERP(hkg) in 130ms
pong from route (100.64.0.2) via 113.227.140.75:41641 in 52ms   ← 第 4 包 UDP 打洞成功，直连
...（持续打流后稳定）pong ... via 113.227.140.75:41641 in 53ms   ← 直连保持
```

**归因**：
- txhk 和 Tailscale 的 `DERP(hkg)` 都在香港，但那台公共 DERP 到家里联通的对等极差，绕了 ~78ms。
- txhk（腾讯香港）到家**直连**仅 52ms —— 腾讯香港对大陆联通 peering 好。
- `headscale config.yaml`：`derp.server.enabled: false` + `urls: controlplane.tailscale.com/derpmap/default` → **当前在用公共 DERP 地图，回退就落到那台 130ms 的 hkg**。
- v3.1 把这 130ms（偶发 180ms）误当成「Tailscale 隧道物理延迟 80–100ms」，据此得出「不买 VPS 只能 130–170ms」的错误结论。

### 3.2 重写后的延迟预算

| 段 | v3.1 口径 | 实测真相 | 优化后（§4.1） |
|---|---|---|---|
| 公司 → txhk | 30–50ms | ~40ms（估，公司侧不可测） | ~40ms |
| **txhk → home** | 80–100ms | **DERP 130ms / 直连 52ms** | **~52ms（直连或 txhk 内嵌 DERP）** |
| home → Win10（LAN） | <1ms | <1ms | <1ms |
| **端到端 RTT** | **130–170ms** | **~170ms（DERP）/ ~92ms（直连）** | **~90–100ms** |

**结论**：仅修掉 DERP 绕行（txhk 单边配置，零成本），路径 B 即从 ~170ms → ~90–100ms（降 ~45%）。这就是 v3.1 漏掉的「更优方案」。若公司有 v6，路径 A 可进一步到 ~30–60ms。

---

## 4. 路径 B：txhk 公网中转（优化 + 加固）

### 4.1 ★中转优化：消除 DERP 绕行（txhk 内嵌 DERP）

把 txhk 自己变成本 tailnet 的 DERP 中继区。这样：**直连可用时走 52ms；即便冷启动/打洞失败回退，中继也是 txhk 本机这台 DERP（走腾讯香港好路由，~52ms），而不是 Tailscale 那台 130ms 的 hkg。** 无论冷热，这段都锁定 ~52ms。

改 `/etc/headscale/config.yaml` 的 `derp.server`（**注意：当前是占位 IP，必须改对，否则会下发错误地址、反而降级连通性**）：

```yaml
derp:
  server:
    enabled: true                       # 原 false
    region_id: 999
    region_code: "txhk"
    region_name: "SilkSpool txhk DERP"
    verify_clients: true                # ★关键安全控制：仅本 tailnet 已认证节点可中继（防开放中继）
    stun_listen_addr: "0.0.0.0:3478"    # NAT 打洞用，需对公网开放（见下）
    private_key_path: /var/lib/headscale/derp_server_private.key   # 缺失自动生成
    automatically_add_embedded_derp_region: true
    ipv4: 43.129.195.4                  # ★必须改成真实公网 IP（原占位 198.51.100.1 = TEST-NET，会下发坏地址）
    # ipv6:                             # ★必须删除/留空（txhk 无全球 v6；原占位 2001:db8::1 会下发坏地址）
  urls:
    - https://controlplane.tailscale.com/derpmap/default   # 保留作冗余兜底（region 999 对 home 更近，会被优先选中）
  paths: []
  auto_update_enabled: true
  update_frequency: 3h
```

开放 STUN 端口（**host 防火墙 + 腾讯云安全组都要放行 `udp/3478`**）：

```bash
# host 侧（与 Tailscale 的 table ip filter 共存；若无显式 input drop 则本步可省，但建议显式放行）
spool exec txhk "sudo nft add rule inet rdp_guard input udp dport 3478 accept 2>/dev/null || true"
# 腾讯云安全组：控制台放行 udp/3478（spool 无法操作云防火墙，需手动）
```

应用并验证：

```bash
spool exec txhk "sudo systemctl restart headscale && sleep 3 && headscale nodes list"   # 数据面不断，控制面短暂重连
spool exec txhk "sudo ss -ulnp | grep ':3478'"                                          # STUN 应在监听
spool exec txhk "tailscale ping -c 8 100.64.0.2"                                         # 期望大多 via 直连 ~52ms；回退应 via DERP(txhk) 而非 DERP(hkg)
```

> DERP 经 `headscale.singll.net/derp`（复用 Caddy 443，TLS）+ STUN `udp/3478`。Caddy `reverse_proxy` 透传 DERP 的 HTTP upgrade，无需额外配置。**安全分析见 §8.1**（含「为何不增加数据暴露」「为何不扩大信任边界」）。

### 4.2 ★RDP-UDP 传输（提升跟手度）

RDP 8+ 用 **UDP/3389（MS-RDPEUDP）** 做 RemoteFX 传输（带 FEC、无队头阻塞），在 90–130ms 链路上比纯 TCP 跟手得多。v3.1 的 socat 只转发 TCP → mstsc 退化纯 TCP。补 UDP 转发即可。**RDP 在 UDP 不通时自动回退 TCP，故此优化无副作用、可放心尝试。**

需同时改：①nft 白名单加 UDP gate（§4.3，**必须加 `udp drop` 否则 fail-open**）；②加一个 UDP socat（§4.6）。

### 4.3 nftables 动态白名单（TCP+UDP gate，修正 fail-open）

```nft
#!/usr/sbin/nft -f
# RDP 动态白名单（IPv4）。与 Tailscale 的 table ip filter 独立共存。
table inet rdp_guard {
    set allowed_ips {
        type ipv4_addr
        flags timeout
        timeout 3m            # 白名单条目 3 分钟自动过期
    }
    chain input {
        type filter hook input priority 0; policy accept;
        ct state established,related accept    # 已建立会话放行 → 不受 TTL 影响
        iif "lo" accept                        # 本机回环放行 → 自测可用
        udp dport 3478 accept                  # STUN（内嵌 DERP，§4.1）
        tcp dport 33890 ip saddr @allowed_ips accept
        udp dport 33890 ip saddr @allowed_ips accept    # ★RDP-UDP gate（§4.2）
        tcp dport 33890 drop                   # 未授权一律丢弃
        udp dport 33890 drop                   # ★防 UDP fail-open（policy 是 accept，必须显式 drop）
    }
}
```

> systemd 加载单元 `nftables-rdp.service` 同 v3.1（`Type=oneshot` + `Before=network.target`），略。

### 4.4 IP 登记服务 unlock（同 v3.1：X-Real-IP + 校验 + 零依赖）

`hosts/txhk/rdp-unlock/unlock.py`（Python 标准库 `http.server`，只信 Caddy 注入的 `X-Real-IP`，`ipaddress` 校验、拒 IPv6）：

```python
#!/usr/bin/env python3
"""RDP 白名单登记服务：仅信任 Caddy 注入的 X-Real-IP，校验后写入 nftables set。"""
import ipaddress, json, logging, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(filename='/var/log/rdp-unlock.log', level=logging.INFO,
                    format='%(asctime)s %(message)s')

def whitelist(ip: str):
    addr = ipaddress.ip_address(ip)          # 非法直接抛异常
    if addr.version != 4:
        raise ValueError(f'IPv6 not supported by this set: {ip}')
    subprocess.run(['sudo', 'nft', 'add', 'element', 'inet', 'rdp_guard',
                    'allowed_ips', '{', str(addr), '}'],
                   check=True, capture_output=True, text=True, timeout=5)

class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith('/health'):
            return self._json(200, {'status': 'ok'})
        ip = (self.headers.get('X-Real-IP') or '').strip()   # 只信 Caddy 注入
        try:
            whitelist(ip); logging.info(f'whitelisted {ip}')
            self._json(200, {'status': 'ok', 'ip': ip, 'message': f'IP {ip} 已放行，请在 3 分钟内发起 RDP 连接'})
        except Exception as e:
            logging.error(f'unlock failed ip={ip!r}: {e}'); self._json(500, {'status': 'error', 'message': '放行失败'})
    def log_message(self, *a): pass

if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 8090), Handler).serve_forever()
```

sudoers（最小权限）`hosts/txhk/sudoers/rdp-unlock`：

```
rdpunlock ALL=(root) NOPASSWD: /usr/sbin/nft add element inet rdp_guard allowed_ips { [0-9.]* }
```

`rdp-unlock.service` 同 v3.1（`User=rdpunlock`、`ProtectSystem=strict`、`Requires=nftables-rdp.service`），略。

### 4.5 Caddy 反代 + forward_auth（注入可信真实 IP）

追加到 `hosts/txhk/caddy/Caddyfile`：

```caddyfile
# RDP 解锁站点（Authelia 2FA 通过后登记客户端 IP）
rdp.singll.net {
    forward_auth 127.0.0.1:9091 {
        uri /api/verify?rd=https://auth.singll.net/
    }
    reverse_proxy 127.0.0.1:8090 {
        header_up X-Real-IP {remote_host}   # 用 TCP peer 覆写，攻击者无法伪造
    }
}
```

- DNS：`rdp.singll.net` A 记录 → `43.129.195.4`。家里 openclash 已对 `+.singll.net` 走真实 DNS。
- 无需改 Authelia ACL：`*.singll.net → two_factor` 已覆盖。
- **认证语义提醒**：Authelia `session 1h / inactivity 5m`，一次 2FA 后在有效期内再访问**不重新要 TOTP**，实质是「持有效会话即可解锁」。若要「每次开门强制 2FA」，需缩短 session 或为该站单独 cookie 策略。

### 4.6 转发层 socat（TCP + UDP，修正 fail-open 竞态）

`hosts/txhk/systemd/rdp-forward.service`（TCP）：

```ini
[Unit]
Description=Forward RDP (TCP) to Home Win10 via Tailscale subnet route
After=network.target tailscaled.service nftables-rdp.service
Requires=tailscaled.service nftables-rdp.service     # 防火墙先于转发
[Service]
ExecStart=/usr/bin/socat -d TCP-LISTEN:33890,fork,reuseaddr TCP:192.168.7.129:3389
Restart=always
RestartSec=5
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
```

`hosts/txhk/systemd/rdp-forward-udp.service`（★UDP，§4.2）：

```ini
[Unit]
Description=Forward RDP (UDP/RemoteFX) to Home Win10
After=network.target tailscaled.service nftables-rdp.service
Requires=tailscaled.service nftables-rdp.service
[Service]
ExecStart=/usr/bin/socat -d UDP4-LISTEN:33890,fork,reuseaddr UDP4:192.168.7.129:3389
Restart=always
RestartSec=5
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
```

> `192.168.7.129` 经 Tailscale 子网路由可达，无需 Win10 装 Tailscale。也可用 systemd-socket-proxyd 替代 TCP socat（§10）。**为何不改用 nftables DNAT**：DNAT 需把 gate 从 `input` 迁到 `forward` 链 + masquerade + 开 `ip_forward`，多处易出 fail-open；对单路交互式 RDP，socat 的用户态拷贝延迟可忽略（微秒级，非影响体感的毫秒级）。故保留经过验证的 socat + `input` 链 gate（§8.5 权衡）。

### 4.7 纳入 spool 部署

`silkspool.yaml` 的 `txhk` 增加 sync_rules（新增 UDP 转发单元）：

```yaml
    sync_rules:
      - { local: "rdp-unlock/unlock.py",            remote: "/opt/rdp-unlock/unlock.py" }
      - { local: "nftables/rdp_guard.nft",          remote: "/etc/nftables.d/rdp_guard.nft" }
      - { local: "sudoers/rdp-unlock",              remote: "/etc/sudoers.d/rdp-unlock" }
      - { local: "systemd/nftables-rdp.service",    remote: "/etc/systemd/system/nftables-rdp.service" }
      - { local: "systemd/rdp-unlock.service",      remote: "/etc/systemd/system/rdp-unlock.service" }
      - { local: "systemd/rdp-forward.service",     remote: "/etc/systemd/system/rdp-forward.service" }
      - { local: "systemd/rdp-forward-udp.service", remote: "/etc/systemd/system/rdp-forward-udp.service" }
    post_push_hooks:
      - { pattern: "sudoers/rdp-unlock",   command: "chmod 440 /etc/sudoers.d/rdp-unlock && visudo -cf /etc/sudoers.d/rdp-unlock" }
      - { pattern: "caddy/Caddyfile",      command: "systemctl reload caddy" }
      - { pattern: "systemd/.*\\.service", command: "systemctl daemon-reload" }
```

> headscale 的 DERP 改动直接编辑 `/etc/headscale/config.yaml`（已有 `config.yaml.save` 备份），改后 `systemctl restart headscale`。

一次性初始化：

```bash
spool exec txhk "sudo useradd -r -s /usr/sbin/nologin rdpunlock 2>/dev/null; \
  sudo apt-get install -y socat; \
  sudo touch /var/log/rdp-unlock.log && sudo chown rdpunlock:rdpunlock /var/log/rdp-unlock.log; \
  sudo mkdir -p /etc/nftables.d"
spool sync push txhk
spool exec txhk "sudo systemctl enable --now nftables-rdp rdp-unlock rdp-forward rdp-forward-udp"
```

---

## 5. IPv6 本地开启（家里，确认与补全）

**现状：家侧 v6 基本已就绪**（§1.2）—— 路由器持公网 `/60`、RA/DHCPv6 服务已开、LAN 设备已在分配公网 GUA、入站默认拒绝。本节是**确认 + 给 Win10 一个稳定可寻址的 GUA**，而非从零开启。

### 5.1 确认入站默认拒绝（安全前提）

```bash
spool exec istoreos "uci show firewall.@zone[2]"   # name='wan' input='REJECT' forward='REJECT'
spool exec istoreos "uci show network.wan | grep ipv6"   # ipv6='auto'（v6 在 wan 同接口 → 被 wan zone 覆盖）
```

确认 `wan.input/forward = REJECT` 且 v6 走 `wan`（非游离接口）→ **公网 v6 入站默认拒绝**，开 v6 不会自动暴露 LAN。

### 5.2 让 Win10 拿到稳定 GUA（开机后执行）

RA flags 为 `managed-config other-config`（M+O）→ Windows 走 DHCPv6 取址，同时前缀含 SLAAC A 标志（已见 EUI-64 地址）。Win10 开机后：

```powershell
# Win10 上确认是否已获公网 GUA（2408:832e:208a:abe0:* 段）
Get-NetIPAddress -AddressFamily IPv6 | Where-Object {$_.IPAddress -like "2408:832e:208a:abe0:*"} | Select IPAddress,PrefixOrigin,SuffixOrigin
```

- 若已有 GUA：记录该地址；建议在 istoreos 用 **DHCPv6 静态租约（按 DUID）** 或依赖**稳定的 SLAAC EUI-64 地址**，确保 §6 的 pinhole 指向固定地址。
- 若仍无 GUA：检查 Win10「网络适配器 → IPv6」未禁用；必要时 `ipconfig /renew6`。家侧 RA/DHCPv6 已验证对其他设备生效，故大概率是 Win10 关机/适配器设置问题，而非家侧缺失。

> **隐私地址提醒**：Windows 默认启用临时地址（RFC 4941）用于**出站**；**入站** RDP 应指向其稳定地址（DHCPv6 租约或 EUI-64），并在 §6 pinhole 与 Win10 防火墙中锁定该地址。

---

## 6. 路径 A：IPv6 端到端直连（快车道）

> 唯一能消除「香港 trombone」的路径。**先做 §6.1 前置测试**；公司无 v6 则跳过本节，仅用路径 B。

### 6.1 前置测试（必须在公司电脑上做）

公司临时设备上，浏览器访问 `https://test-ipv6.com/`，或命令行：

```cmd
ping -6 ipv6.singll.net      :: 或任意已知 v6 主机
curl -6 https://test-ipv6.com/ip/    :: 返回 v6 地址即公司有 v6 出网
```

- **能拿到 v6 且能 ping 通外部 v6** → 路径 A 可行，继续 §6.2。
- **无 v6 / 公司封禁 v6 出站** → 路径 A 不可用（很多企业网纯 v4），仅用优化后的路径 B。

### 6.2 架构与安全门（家侧 2FA 动态 pinhole，镜像 txhk）

**安全核心**：路径 A **绕过了 txhk 的 Authelia 2FA gate**，若裸开 Win10:3389 到 v6 公网，等于把 RDP 直接暴露给互联网（详见 §8.3）。因此路径 A **必须**复刻路径 B 的「2FA → 短 TTL 动态放行」机制，只是搬到家侧、走 v6：

```
公司电脑（有 v6）
   │  ① 浏览器访问 https://rdp6.singll.net（AAAA → istoreos 公网 GUA）
   ▼
istoreos 家侧 Caddy:443(v6)  ──forward_auth──→ 家侧 Authelia 2FA
   │  ② 2FA 通过 → 家侧 unlock 把【客户端 v6】写入 istoreos nft `inet6` set（TTL 3min）
   │     并放行 forward → Win10:3389
   ▼
   ③ mstsc 连 [Win10 公网 GUA]:3389（v6 直连，不经香港）
   ▼
Win10（NLA + rdp_remote 低权 + 锁定）
```

为何 unlock 能拿到客户端真实 v6：客户端**经 v6 访问** `rdp6.singll.net`（与随后 RDP 同一地址族），istoreos 直接看到其 v6 源地址。

### 6.3 istoreos 侧实现（gated pinhole）

家侧 nft（经 fw4 include，`/etc/nftables.d/` 或 uci firewall include）建 v6 动态集 + 受控转发：

```nft
table inet rdp6_guard {
    set allowed6 {
        type ipv6_addr ; flags timeout ; timeout 3m
    }
    chain forward {
        type filter hook forward priority -1; policy accept;   # 仅追加放行，不改 fw4 默认
        ip6 daddr <WIN10_GUA> tcp dport 3389 ip6 saddr @allowed6 accept
        ip6 daddr <WIN10_GUA> tcp dport 3389 drop               # 未授权丢弃
    }
}
```

- 家侧 unlock（同 §4.4 的 `unlock.py`，改写 `inet6 rdp6_guard allowed6` 并允许 v6）由家侧 Caddy `rdp6.singll.net` 经 `forward_auth` 保护。
- istoreos 防火墙需放行**入站 v6 到路由器自身 443**（family ipv6，供 unlock 页面可达）：`uci` 加一条 `wan → 本机:443 ipv6` 的 input 规则。
- 默认 `wan.forward=REJECT` 已挡住一切 → 仅 `@allowed6` 内的源在 3 分钟窗口可达 Win10:3389。

> **取舍**：路径 A 引入「家侧 Caddy/Authelia 暴露到 v6 公网」的新增面（§8.3 缓解）。若公司 v6 前缀**固定且可知**，可再叠加「仅放行该 `/48` 或 `/64` 源」的静态约束，纵深防御。

### 6.4 Win10 v6 防火墙作用域（开机后）

```powershell
# 仅放行入站 v6 RDP（默认配合 §6.3 的家侧 gate；如公司 v6 前缀已知可进一步 RemoteAddress 收敛）
Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -Enabled True
# 如需按已知公司 v6 前缀收敛（强烈建议，若前缀稳定）：
# Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -RemoteAddress "<公司v6前缀>::/64"
```

---

## 7. Windows 10 加固（Win10 开机后执行，两路径共用）

```powershell
# 1. 专职低权账户（强密码、永不过期）
$pw = Read-Host -AsSecureString "rdp_remote 密码(16+位)"
New-LocalUser -Name "rdp_remote" -Password $pw -PasswordNeverExpires -AccountNeverExpires
Add-LocalGroupMember -Group "Remote Desktop Users" -Member "rdp_remote"
Add-LocalGroupMember -Group "Users" -Member "rdp_remote"
Get-LocalGroupMember -Group "Administrators" | Where-Object Name -like "*rdp_remote*"   # 确认不在管理员组

# 2. 强制 NLA
(Get-WmiObject -class Win32_TSGeneralSetting -Namespace root\cimv2\terminalservices `
  -Filter "TerminalName='RDP-tcp'").SetUserAuthenticationRequired(1)

# 3. 账户锁定（5 次失败锁 15 分钟）—— 抵御暴力破解，v6 直连尤为重要
net accounts /lockoutthreshold:5 /lockoutwindow:15 /lockoutduration:15

# 4. 防火墙作用域
#   路径 B：socat 从 txhk 的 Tailscale IP 100.64.0.3 发起 → 放行 Tailscale 段
Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -RemoteAddress "100.64.0.0/10"
#   路径 A（v6 直连）：见 §6.4（注意：两路径并存时 RemoteAddress 需同时含 100.64.0.0/10 与 v6 来源）

# 5. 启用 RDP UDP（RemoteFX，配合 §4.2 / 路径 A）
Set-ItemProperty "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" -Name "fClientDisableUDP" -Value 0 -ErrorAction SilentlyContinue
```

> 路径 B 下 Win10 看到的源是 txhk 的 `100.64.0.3`（socat 出口），收敛靠 txhk 的 nft 白名单。路径 A 下源是客户端真实 v6，收敛靠 istoreos 的 `rdp6_guard` + （可选）Win10 RemoteAddress。

---

## 8. 安全审查（v3.2 重点）

对全部新增改动做机密性 / 完整性 / 可用性 / 暴露面 / 信任边界分析。**重点：headscale 内嵌 DERP（§8.1）。**

### 8.1 ★headscale 内嵌 DERP（§4.1）—— 是否涉及网络安全？有何风险？

**改动**：`derp.server.enabled: true`，txhk 成为本 tailnet 的 DERP 中继区（id 999），开 `udp/3478` STUN，DERP 经 `headscale.singll.net/derp`（复用 443）。

| 维度 | 分析 | 结论 |
|------|------|------|
| **机密性（会泄露 RDP 内容吗？）** | DERP **只中继 WireGuard/Noise 密文，无法解密** tailnet 流量。且对本 RDP 用途，**txhk 本就是明文点**（socat 在 txhk 终结客户端 RDP 再重新进隧道）—— DERP 不增加任何新的明文可见性。对其他 tailnet 流量，DERP 只见密文。 | ✅ **不增加数据暴露** |
| **开放中继滥用** | 若不设防，DERP 可被任意人借道中继（带宽盗用 / 流量洗白）。`verify_clients: true` 让 DERP 仅为**本 headscale tailnet 已认证节点**（核对公钥）中继。 | ✅ 安全，**必须保持 `verify_clients: true`** |
| **STUN `udp/3478` 暴露** | STUN 是反射协议，但响应≈请求大小，放大系数 ~1x（非 DNS/NTP/memcached 那类 50–500x 放大器），不是有效 DDoS 放大源；仅暴露「这是个 STUN 服务」。必须对公网开放（NAT 打洞所需）。 | △ **低风险**；可选对 3478 限速；需同步开**腾讯云安全组** |
| **DERP over 443** | 复用现有 Caddy 443，无新端口；Caddy 透传 HTTP upgrade；`verify_clients` 拒未认证客户端。 | ✅ 复用既有面 |
| **信任边界是否扩大** | txhk 本就是「皇冠明珠」：持控制面（headscale）、终结 RDP 明文、是唯一公网节点。**txhk 若失陷，攻击者已得到一切**；DERP 不增加 blast radius。 | ✅ **不扩大信任边界** |
| **可用性 / 误配** | ❶ 占位 `ipv4: 198.51.100.1`/`ipv6: 2001:db8::1` 若不改，会给客户端下发**坏地址 → 连通性反而降级**（必须改真实 v4、删 v6）。❷ `systemctl restart headscale`：**数据面（既有隧道）不中断**，仅控制面短暂重连；坏配置可能致 headscale 起不来 → 节点拿不到更新。 | △ **改对占位 IP**；保留 `config.yaml.save` 备份；低峰重启；改后立即 `headscale nodes list` 验证 |
| **与 P0 联动** | DERP 跑在 `headscale.singll.net/derp` → **P0-1（该域名不得套 forward_auth）和 P0-2（openclash 须 fake-ip 豁免 `+.singll.net`）现在同时守护 DERP**。已豁免，无新增脆弱点，但回退这两条会同时打断 DERP。 | ✅ 现有约束已覆盖，需在文档强调 |

**§8.1 小结**：内嵌 DERP **确实是网络安全相关改动**（新开公网 STUN 端口、txhk 承担中继角色），但在 `verify_clients: true` + 改对占位 IP + 同步云安全组的前提下，**不增加数据暴露、不扩大信任边界、无显著放大风险**。唯一真实注意项是**占位 IP 必须改对**（否则降级可用性）与**STUN 端口需云安全组放行**。

### 8.2 RDP-UDP 转发（§4.2/4.6）

| 风险 | 分析 | 处置 |
|------|------|------|
| **UDP fail-open** | nft `policy accept`，若只加 `udp accept` 不加 `udp dport 33890 drop`，则 UDP 端口对全网敞开。 | ✅ §4.3 已显式加 `udp dport 33890 drop`；部署后 `nft list` 必须核对两条 drop 都在 |
| 明文暴露 | RDP-UDP 承载同一 RDP 安全层（TLS/NLA），UDP gate 与 TCP 同受白名单约束。 | ✅ 无新增明文 |
| 失败回退 | RDP-UDP 不通自动回退 TCP。 | ✅ 无副作用 |

### 8.3 ★IPv6 直连（§6）—— 最高风险项

| 风险 | 分析 | 处置 |
|------|------|------|
| **绕过 2FA gate** | 路径 A 不经 txhk Authelia。**裸开 Win10:3389 到 v6 公网 = RDP 直面互联网**（BlueKeep 类漏洞、爆破的高价值目标）。 | ❗ **禁止裸 pinhole**；**必须**用 §6.2 家侧 2FA 动态放行（镜像 txhk），仅 `@allowed6` 内源、3min 窗口可达 |
| 家侧 Caddy/Authelia 暴露到 v6 | `rdp6.singll.net` 使家侧 Caddy:443、Authelia 内网面变 v6 公网可达，新增暴露面。 | △ 仅暴露 unlock vhost；依赖 Authelia regulation（3/2min 封 5min）；TLS；可叠加公司 v6 前缀静态约束 |
| Win10 直接可达 | 即使有 gate，窗口内 Win10 RDP 对授权源可达。 | NLA + `rdp_remote` 低权 + 锁定（§7）+ （建议）Win10 RemoteAddress 收敛到公司 v6 前缀 |
| 缺审计 | v6 直连无 txhk 日志。 | 家侧 unlock 写日志 + 可选 ntfy 通知（同 §4 附 H） |

**§8.3 小结**：路径 A **是本方案最高风险面**。其安全性**完全取决于是否落实家侧 2FA 动态 pinhole**。落实后与路径 B 安全等级相当；不落实（裸开端口）则**显著低于**路径 B，不可接受。

### 8.4 IPv6 本地开启（§5）

| 风险 | 分析 | 处置 |
|------|------|------|
| LAN 全员获公网可寻址 | 开 RA 后所有 LAN 设备（含 IoT/打印机）持公网 GUA。 | ✅ 仅**可寻址**，`wan.input/forward=REJECT` 默认**拒绝入站** → 不可达，除非显式 pinhole |
| wan zone 是否覆盖 v6 | 若 v6 在游离接口（未入 wan zone），入站受 `defaults.input=ACCEPT` 管 → 危险。 | ✅ 已实测 `network.wan.ipv6='auto'`（v6 在 wan 同接口），wan zone 覆盖；§5.1 已列复核步骤 |
| ULA 泄露 | `fde1:29df:2d55::/48` ULA 仅内网，不可全球路由。 | ✅ 无影响 |

### 8.5 整体威胁模型与残余风险

| 资产 | 主要威胁 | 现有控制 | 残余风险 |
|------|---------|---------|---------|
| Win10 RDP | 爆破 / RDP 漏洞 | NLA + 低权账户 + 锁定 + （两路径）2FA 动态放行 | 中→低；建议补 Win10 安全更新、监控登录失败 |
| txhk（皇冠明珠） | 节点失陷 → 控制面 + RDP 明文 + DERP | 最小权限 unlock、sudoers 收敛、443/3478/33890 之外不暴露 | 取决于 txhk 主机加固（SSH key、fail2ban） |
| 中转白名单 | fail-open / TTL 绕过 | `policy accept` + 显式 TCP/UDP drop + `ct established` | 低；部署后必须 `nft list` 核对 4 条 dport 规则齐全 |
| v6 直连面 | 绕过 2FA / 家侧服务暴露 | §6.2 家侧 2FA gate（**强制**） | **未落实 gate 则高**；落实后中→低 |

> **socat vs DNAT 取舍（§4.6）**：安全上保留 socat + `input` 链 gate（经验证、单点 drop、无 forward/masquerade 的 fail-open 面）优于重构为 nat 表 DNAT；延迟上对单路交互式 RDP 二者无可感差异。故不采纳 DNAT。

---

## 9. 安全机制时间线

| 时间 | 路径 B（txhk） | 路径 A（v6 直连） |
|------|------|------|
| T+0 | 访问 `rdp.singll.net`，Authelia 2FA | 经 v6 访问 `rdp6.singll.net`，家侧 Authelia 2FA |
| T+~10s | unlock 写客户端 v4 → txhk nft set（TTL 3min） | 家侧 unlock 写客户端 v6 → istoreos nft `inet6` set（TTL 3min）+ 放行 forward |
| T+1min | mstsc 连 `43.129.195.4:33890` → socat → Win10 NLA | mstsc 连 `[Win10 GUA]:3389` → Win10 NLA |
| T+3min | 白名单过期，**新连接** drop | 同左 |
| T+3min 后 | ✅ **已建立会话不受影响**（`ct established` 放行），持续到主动断开 | 同左（istoreos forward 链同样需 `ct established` 放行，§6.3 补） |

---

## 10. 工具调研（替代/增强选型）

| 方案 | 公网 RDP 暴露 | 客户端要求 | 服务器负载 | 落地复杂度 | 适配本场景 |
|------|------|------|------|------|------|
| **txhk 内嵌 DERP（§4.1）** | 不增加 | 无 | 极低 | **低** | 🥇 **零成本砍掉 130ms→52ms 绕行** |
| **RDP-UDP 转发（§4.2）** | 不增加（同 gate） | 无 | 极低 | 低 | 🥇 跟手度提升，自动回退 |
| **IPv6 直连（§6）** | 是（家侧 2FA gated） | 仅需 v6 出网 | 极低 | 中 | 🥇 唯一消除 trombone，~30–60ms（需公司有 v6） |
| socat 中转（§4.6） | 是（Authelia+白名单 gated） | 仅需 v4 | 极低 | 中 | 🥈 永远可用兜底 |
| systemd-socket-proxyd | 同 socat | 同 socat | 极低 | 低（systemd 自带） | ✅ 可替代 TCP socat |
| 国内 VPS 中转 | 是（白名单 gated） | 仅需 v4 | 极低 | 中 | ❌ **用户约束：不买新 VPS** |
| RD Gateway over HTTPS | 否（HTTPS 封装） | 仅 mstsc | 中 | 高（需 WinServer/AD） | ❌ **用户约束：不搭 AD gate** |
| Guacamole 浏览器内 RDP | 否（443） | 仅浏览器 | **高**（Tomcat+guacd） | **高**（guacd 须编译） | ❌ 仍绕香港、非原生体验 |
| fwknop SPA 单包授权 | 否（端口隐形） | 需装客户端 | 极低 | 中 | △ 隐蔽性最强，但需客户端 |
| caddy-l4（L4 反代） | 同 socat | 同 socat | 低 | 中（须 xcaddy 重编译） | △ 纯转发相比 socat 优势有限 |

---

## 11. 部署与验证清单

```bash
# === 中转优化（§4.1 内嵌 DERP）===
spool exec txhk "sudo systemctl restart headscale && sleep 3 && headscale nodes list"
spool exec txhk "sudo ss -ulnp | grep ':3478'"                 # STUN 监听
spool exec txhk "tailscale ping -c 8 100.64.0.2"               # 期望 via 直连 ~52ms / 回退 via DERP(txhk)
# 腾讯云安全组手动放行 udp/3478

# === 路径 B 部署（§4.3-4.7）===
spool exec txhk "sudo systemctl status nftables-rdp rdp-unlock rdp-forward rdp-forward-udp --no-pager | grep Active"
spool exec txhk "sudo ss -tlnp | grep -E ':(8090|33890)'; sudo ss -ulnp | grep ':33890'"
spool exec txhk "sudo nft list table inet rdp_guard"           # 核对 ct/lo/3478 + TCP&UDP 各 accept+drop（共 4 条 dport）
spool exec txhk "curl -s -o /dev/null -w '%{http_code}' -I https://rdp.singll.net"   # 302 → auth

# === 路径 A 前置（§5/§6）===
spool exec istoreos "uci show firewall.@zone[2]; uci show network.wan | grep ipv6"   # wan REJECT + ipv6=auto
# 公司电脑：访问 test-ipv6.com 确认有 v6 出网（§6.1）
# Win10 开机：Get-NetIPAddress -AddressFamily IPv6 | ? IPAddress -like '2408:832e:208a:abe0:*'

# === 端到端 ===
# 路径 B：浏览器 2FA → mstsc 43.129.195.4:33890
# 路径 A：v6 浏览器访问 rdp6.singll.net 2FA → mstsc [Win10 GUA]:3389
```

---

## 12. 故障排查

| 问题 | 可能原因 | 排查 |
|------|---------|------|
| 所有 Tailscale 节点 offline | headscale 被 Caddy 2FA 拦 / openclash fake-ip 劫持（§0） | `curl -I https://headscale.singll.net/key`（应 400）；istoreos `nslookup headscale.singll.net`（应真实 IP） |
| 改 DERP 后 headscale 起不来 | config.yaml 语法错 / 占位 IP 未改 | `journalctl -u headscale`；`cp config.yaml.save config.yaml` 回滚 |
| `tailscale ping` 仍 via DERP(hkg) | 内嵌 DERP 未生效 / 3478 被云安全组挡 / 占位 IP 未改 | `ss -ulnp \| grep 3478`；核对 `ipv4: 43.129.195.4`；腾讯云安全组 |
| RDP 连上 3 分钟后掉线 | nft 缺 `ct state established` | `nft list table inet rdp_guard` |
| UDP/RemoteFX 不通但 TCP 能连 | 3478 之外，udp/33890 未放行 / UDP socat 未起 | 正常会回退 TCP；如需 UDP：核对 `udp dport 33890 accept` + `rdp-forward-udp` |
| rdp.singll.net 认证后 500 | unlock 未启动 / sudoers 错 / X-Real-IP 空 | `journalctl -u rdp-unlock`；`tail /var/log/rdp-unlock.log` |
| v6 直连连不上 | 公司无 v6 / Win10 无 GUA / 家侧 gate 未放行 / wan 未开 443 入站 | §6.1 测公司 v6；§5.2 查 Win10 GUA；家侧 unlock 日志；`uci` 查 v6 input 规则 |
| route offline | istoreos tailscaled 未连控制面 | `spool exec istoreos "tailscale status"`；`/etc/init.d/tailscale restart` |

### 日志位置

| 服务 | 位置 |
|------|------|
| Caddy / Authelia / headscale / rdp-forward | `journalctl -u <svc>` |
| unlock（txhk / 家侧） | `/var/log/rdp-unlock.log` |
| nftables | `journalctl -k \| grep rdp_guard` |

---

## 附录：命令速查

```bash
# 中转优化诊断（核心）
spool exec txhk "tailscale ping -c 8 100.64.0.2"               # 直连 vs DERP + RTT
spool exec txhk "tailscale status"
spool exec txhk "sudo ss -ulnp | grep 3478"                    # STUN

# nftables 白名单
spool exec txhk "sudo nft list set inet rdp_guard allowed_ips"
spool exec txhk "sudo nft add element inet rdp_guard allowed_ips { 1.2.3.4 }"
spool exec txhk "sudo nft delete element inet rdp_guard allowed_ips { 1.2.3.4 }"

# 服务
spool exec txhk "sudo systemctl restart rdp-unlock rdp-forward rdp-forward-udp"
spool exec txhk "sudo systemctl restart headscale"             # DERP 配置生效（数据面不断）
spool logs txhk caddy 50

# 链路
spool exec txhk "ping 192.168.7.129; timeout 3 bash -c 'echo>/dev/tcp/192.168.7.129/3389'"
spool exec istoreos "tailscale status; nslookup headscale.singll.net"
spool exec istoreos "uci show firewall.@zone[2]; uci show network.wan | grep ipv6"   # v6 入站默认拒绝核对
```

---

*文档版本: 3.2 | 重写日期: 2026-06-06 | 实测推翻 DERP 延迟归因（170→90-100ms）、恢复 IPv6 直连双路径、新增中转优化与安全审查（重点 headscale 内嵌 DERP）| 前置 P0 已修复*
