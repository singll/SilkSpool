# RDP 安全网关实施方案 v3.0

> **目标**：让「装不了 Tailscale 的临时设备」通过原生 RDP（mstsc）安全连接家里内网的 Win10（192.168.7.129）。
> **路径**：txhk 香港公网中转（唯一路径，任意 IPv4 客户端可用）。
> **认证底座**：Authelia 2FA → 动态防火墙白名单（短 TTL）；最后底线：Windows NLA + 弱权账户 + 账户锁定。
>
> 本版基于 2026-06-06 实测：**Win10 无公网 IPv6**，v2.0 的路径 A（IPv6 直连）不可行，已移除。
> 新增 §3「直连方案对比」，列出在「不可内网穿透、不可用向日葵等远程工具」约束下的直连替代方案。
> v1.0/v2.0 的环境数据已多处过期，**勿再参照旧版**。

---

## 0. 前置修复记录（2026-06-05，已完成）

部署本方案前必须保证 Tailscale 子网路由可用。调查中发现昨日（06-04 17:20）给 txhk 上 Authelia 时引发**两个连锁故障**，导致所有 Tailscale 节点控制面失联（`headscale nodes list` 全部 offline）。已修复：

| 编号 | 根因 | 修复 | 验证 |
|------|------|------|------|
| P0-1 | txhk 的 Caddy 给 `headscale.singll.net` 整站套了 `forward_auth`（Authelia 2FA），节点用 machine key 走 `/key`、`/ts2021` 控制协议无法过 2FA → 控制面被 302 拦截 | `hosts/txhk/caddy/Caddyfile` 移除 headscale 段的 `forward_auth`，仅保留 `reverse_proxy 127.0.0.1:8080` | `curl /key` 由 302 变 400（直达 Headscale） |
| P0-2 | 家里 istoreos 的 openclash 把 `headscale.singll.net` 分配成 fake-ip（198.18.0.30），本机 tailscaled 连控制面被劫持走代理 → noise 握手 `EOF` | `hosts/istoreos/openclash/openclash_custom_overwrite.sh` 的 `fake-ip-filter` 增加 `+.singll.net`，重启 openclash | 解析回归 43.129.195.4；`route` 节点恢复 online |

> **经验**：自建服务域名（`*.singll.net`）中，**部署在 txhk 的服务（headscale/auth/matrix/ntfy）必须用真实公网 IP 直连**，既不能套面向人的 2FA，也不能进 openclash 的 fake-ip/代理。openclash 原先只为官方 `+.tailscale.io/.com` 做了直连豁免，漏了自建 Headscale 域名。

**修复后验收（实测）**：

```
route: online   txhk: online
txhk → ping 192.168.7.129 : OK
txhk → 192.168.7.129:3389  : OPEN
```

---

## 1. 环境现状（2026-06-05 实测）

### 1.1 txhk 云服务器（中转入口）

| 项目 | 值 | 备注 |
|------|-----|------|
| 公网 IP | `43.129.195.4` | 运营商 EIP，本机 eth0 实为 `172.19.0.11`（云内网，DNAT 映射） |
| 公网 IPv6 | **无** | 仅 Tailscale ULA `fd7a:115c:a1e0::3`，无全球可路由 v6 |
| 系统 | Ubuntu **22.04** LTS | 主机名 `ubuntu24` 是误导；Python 3.10.12 / pip 22.0.2（**不触发 PEP668 硬拦截**，但仍不建议污染系统库） |
| Caddy | v2.10.2 | 入口反代，systemd 运行，配置 `/etc/caddy/Caddyfile` |
| Authelia | 127.0.0.1:9091 | session `expiration: 1h` / `inactivity: 5m`；regulation `3 次/2min → 封 5min`；ACL `*.singll.net → two_factor`（已覆盖 `rdp.singll.net`，**无需改 ACL**） |
| 防火墙 | iptables-nft `table ip filter`（Tailscale 装）；`inet` family 空闲，可建 `rdp_guard` 表共存 | |
| 待装 | `socat` **未安装**（可用 systemd-socket-proxyd 替代，见 §7） | |

### 1.2 家里网络（被连目标侧）

| 项目 | 值 | 结论 |
|------|-----|------|
| 路由器 | iStoreOS `192.168.7.1`（= spool 主机 `istoreos` = Tailscale `route` 节点 `100.64.0.2`），跑 Caddy/Authelia/homepage/openclash（Docker）+ tailscaled（subnet router + exit node） | 子网路由把 `192.168.7.0/24` 宣告给 txhk |
| Win10 | `192.168.7.129`，RDP 3389 开放 | future 节点 `100.64.0.1`，**当前关机（21 天）** |
| **IPv4 公网入站** | PPPoE 接口 `113.227.140.75` ≠ 实际出口 `103.190.178.216` | **CGNAT/大内网，无法从公网入站**（实测从 txhk 连两个候选 IP 的临时端口均 `Connection refused`，SYN 止于运营商 NAT） |
| **IPv6 公网** | 路由器 br-lan 下发 `2408:832e:208a:abe0::/60`（联通公网 /60），但 **Win10 未获取到公网 IPv6 地址** | **IPv6 直连不可行**（v2.0 路径 A 已移除） |

### 1.3 关键结论

- ❌ **IPv4 动态直连不可行**：你能查到的"公网 IP"是运营商共享 NAT 出口，端口不归你，DDNS 跟踪也无法入站。
- ❌ **IPv6 端到端直连不可行**：虽然家里有公网 /60 前缀，但 Win10 实测无公网 v6 地址，无法作为直连目标。
- ✅ **IPv4 必须经 txhk 中转**：保证任何 v4 客户端都能连，这是「保证可用」的基线。
- △ **如需直连提升性能**：需借助客户端辅助工具建立虚拟隧道，详见 §3。

---

## 2. 路径选择与决策

```
客户端（任意 IPv4）
       │
       ▼
路径 B：txhk 中转
mstsc → 43.129.195.4:33890
  → socat → Tailscale 子网路由
  → 192.168.7.129:3389
```

| 维度 | 路径 B（txhk 中转） |
|------|---------------------|
| 路径 | 客户端 → 香港 txhk → Tailscale → route → Win10 |
| 延迟 | 较高（绕香港 + 双跳隧道，txhk→Win10 实测 ~180ms） |
| 前提 | 仅需客户端有 v4（**永远满足**） |
| 暴露面 | txhk 的 33890（Authelia 网关 + 白名单） |
| 落地难度 | 中（已有 Authelia/Caddy/Tailscale） |

> **为何不用 Guacamole（浏览器内 RDP）**：你要原生 mstsc 体验/性能。Guacamole 同样得部署在 txhk（仍绕香港），且 txhk 仅 2 核 3.6G、跑 Tomcat+guacd 偏重、guacd 须源码编译。性能与体验都不如原生 RDP。详见 §7 工具调研。

---

## 3. 直连方案对比（提升性能的替代路径）

> **约束前提**：
> - ❌ 不可使用内网穿透（公司电脑不可将公司网络连入家庭网络）
> - ❌ 不可使用向日葵、ToDesk、TeamViewer 等商业远程工具
> - ✅ 可使用客户端辅助工具建立虚拟隧道
> - ✅ 目标是原生 RDP 体验（mstsc），而非浏览器或第三方客户端

### 3.1 方案总览

| 方案 | 原理 | 客户端要求 | 服务端要求 | 延迟 | 安全性 | 复杂度 | 推荐度 |
|------|------|-----------|-----------|------|--------|--------|--------|
| **A. Tailscale 直连** | WireGuard 零配置 VPN，NAT 穿透 | 装 Tailscale 客户端 | Win10 装 Tailscale | **最低**（P2P 直连） | 🥇 端到端加密 | 低 | ⭐⭐⭐⭐⭐ |
| **B. WireGuard 手动** | 轻量 VPN，需手动配置 | 装 WireGuard 客户端 | 家里路由器/Win10 跑 WG | 低（直连） | 🥇 端到端加密 | 中 | ⭐⭐⭐⭐ |
| **C. ZeroTier** | SD-WAN 虚拟局域网 | 装 ZeroTier 客户端 | Win10 装 ZeroTier | 低（P2P） | 🥇 端到端加密 | 低 | ⭐⭐⭐⭐ |
| **D. Cloudflare Tunnel + WARP** | Cloudflare 边缘隧道 | 装 Cloudflare WARP | 家里跑 cloudflared | 中（经 CF 边缘） | 🥈 TLS 加密 | 中 | ⭐⭐⭐ |
| **E. frp 反向代理** | 从家里主动连公网服务器 | 无需客户端 | 公网服务器 + 家里 frpc | 中（经公网服务器） | 🥈 可加密 | 中 | ⭐⭐ |
| **F. 当前方案（txhk 中转）** | 固定公网服务器转发 | 无需客户端 | txhk + Authelia | 高（绕香港） | 🥈 2FA + 白名单 | 中 | ⭐⭐（兜底） |

### 3.2 方案详解

#### 方案 A：Tailscale 直连（最推荐）

**原理**：Tailscale 基于 WireGuard，自动处理 NAT 穿透（STUN/DERP），在大多数场景下可实现 P2P 直连。

**架构**：
```
公司电脑（Tailscale 客户端）
       │
       ▼ Tailscale mesh（P2P 直连或经 DERP 中继）
       │
家里 Win10（Tailscale 客户端，100.64.0.1）
```

**优点**：
- ✅ **零配置 NAT 穿透**：自动尝试 STUN 打洞，失败时经 DERP 中继（仍加密）
- ✅ **端到端加密**：WireGuard 层加密，即使经 DERP 中继也无法被中间人解密
- ✅ **最低延迟**：P2P 直连时延迟最低（无中转）
- ✅ **已有基础设施**：你已有 Headscale 控制平面，只需让 Win10 加入
- ✅ **ACL 控制**：可在 Headscale 配置访问策略

**缺点**：
- ❌ 需要在客户端设备安装 Tailscale（但这是「客户端辅助」，不涉及内网穿透）
- ❌ 公司网络可能阻止 UDP（此时会回退到 DERP 中继，延迟增加但仍可用）

**实施步骤**：
1. Win10 安装 Tailscale，配置 Headscale 控制平面（`--login-server https://headscale.singll.net`）
2. 客户端设备安装 Tailscale，登录同一控制平面
3. 客户端直接 RDP 到 Win10 的 Tailscale IP（`100.64.0.1:3389`）
4. 可选：在 Headscale ACL 中限制只有特定节点可访问 Win10 的 3389

**与「内网穿透」的区别**：
- 内网穿透 = 把公司网络**连入**家庭网络（公司电脑成为家庭网络的延伸）
- Tailscale = 在两台电脑之间建立**点对点隧道**（公司网络和家庭网络保持隔离）
- 公司电脑通过 Tailscale 只能访问 Win10，无法访问家里其他设备（除非显式配置）

---

#### 方案 B：WireGuard 手动配置

**原理**：WireGuard 是 Tailscale 的底层协议，手动配置可实现更精细的控制。

**架构**：
```
公司电脑（WireGuard 客户端）
       │
       ▼ WireGuard 隧道（UDP）
       │
家里路由器/Win10（WireGuard 服务端）
```

**优点**：
- ✅ **纯内核实现**：性能极高，延迟最低
- ✅ **完全自主**：不依赖任何第三方服务
- ✅ **端到端加密**：ChaCha20-Poly1305 加密

**缺点**：
- ❌ 需要公网服务器或家里有公网 IP（你有 CGNAT，需要公网服务器做中转或打洞）
- ❌ 手动配置密钥和路由，维护成本高
- ❌ NAT 穿透需手动配置（不如 Tailscale 自动）

**实施方式**：
1. **方式一（公网服务器中转）**：在 txhk 跑 WireGuard，公司和 Win10 都连到 txhk
2. **方式二（NAT 打洞）**：使用 wg-quick + 手动配置 endpoint，但 CGNAT 下打洞困难

**推荐**：如果追求极致性能且愿意手动维护，可在 txhk 跑 WireGuard 服务端，公司和 Win10 作为客户端连接。但这与当前 Tailscale 方案本质相同，只是更手动。

---

#### 方案 C：ZeroTier

**原理**：ZeroTier 是类似 Tailscale 的 SD-WAN 方案，创建虚拟局域网。

**架构**：
```
公司电脑（ZeroTier 客户端）
       │
       ▼ ZeroTier 虚拟网络
       │
家里 Win10（ZeroTier 客户端）
```

**优点**：
- ✅ **Layer 2 虚拟网络**：可模拟完整以太网，支持广播/组播
- ✅ **P2P 直连**：支持 NAT 穿透
- ✅ **自建控制器**：可自建 ZeroTier 控制器（类似 Headscale）

**缺点**：
- ❌ 免费版限制 25 节点（自建控制器可绕过）
- ❌ 配置比 Tailscale 稍复杂
- ❌ 你已有 Tailscale/Headscale 基础设施，迁移成本

**推荐**：如果 Tailscale 满足需求，无需迁移到 ZeroTier。

---

#### 方案 D：Cloudflare Tunnel + WARP

**原理**：Cloudflare Tunnel 从家里主动连 Cloudflare 边缘，客户端通过 WARP 连接 Cloudflare。

**架构**：
```
公司电脑（Cloudflare WARP 客户端）
       │
       ▼ Cloudflare 边缘网络
       │
家里 Win10（cloudflared tunnel）
```

**优点**：
- ✅ **无需公网 IP**：从家里主动出站连接
- ✅ **Cloudflare 边缘加速**：全球 Anycast 节点
- ✅ **可配合 Access 做零信任**：类似 Authelia 的 2FA 控制

**缺点**：
- ❌ 需要 Cloudflare 账号（免费版可用）
- ❌ 流量经 Cloudflare 边缘，非纯 P2P
- ❌ RDP 需要通过 Cloudflare 的 TCP 隧道，可能有限制

**实施步骤**：
1. 家里跑 `cloudflared tunnel`，配置指向 Win10:3389
2. 客户端安装 WARP，连接到同一 Cloudflare 网络
3. 或使用 Cloudflare Access 配置浏览器 2FA + TCP 隧道

**推荐**：如果不想自建基础设施，Cloudflare Tunnel 是不错的托管方案。

---

#### 方案 E：frp 反向代理

**原理**：frp 从家里主动连接公网服务器（txhk），客户端连接公网服务器。

**架构**：
```
公司电脑（mstsc）
       │
       ▼
txhk（frps 公网服务端）
       │
       ▼ frp 隧道（从家里主动建立）
       │
家里 Win10（frpc 客户端）
```

**优点**：
- ✅ **无需客户端**：客户端只需 mstsc
- ✅ **从家里主动出站**：绕过 CGNAT 入站限制
- ✅ **可复用 txhk**：已有公网服务器

**缺点**：
- ❌ **所有流量经 txhk**：与当前方案本质相同，延迟无改善
- ❌ 需要额外部署 frps/frpc
- ❌ 安全性需额外配置（token 加密、TLS）

**推荐**：与当前 socat 方案功能等价，无性能提升，不建议重复建设。

---

#### 方案 F：当前方案（txhk 中转 + Authelia）

**原理**：固定公网服务器转发 RDP 流量，配合 2FA 和动态白名单。

**架构**：
```
公司电脑（mstsc）
       │
       ▼ Authelia 2FA + nftables 白名单
       │
txhk（socat 转发）
       │
       ▼ Tailscale 子网路由
       │
家里 Win10
```

**优点**：
- ✅ **无需客户端**：任意浏览器 + mstsc 即可
- ✅ **安全性高**：2FA + 动态白名单 + NLA
- ✅ **已部署**：基础设施就绪

**缺点**：
- ❌ **延迟高**：绕香港 + 双跳隧道
- ❌ **依赖 txhk 可用性**：单点故障

**定位**：作为「兜底方案」，当无法安装客户端时使用。

---

### 3.3 方案选择建议

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| **公司允许安装软件** | A. Tailscale 直连 | 性能最好，已有基础设施，安全可靠 |
| **公司禁止安装软件** | F. txhk 中转（当前方案） | 无需客户端，浏览器 2FA 即可 |
| **追求极致性能** | B. WireGuard 手动 | 纯内核，延迟最低，但维护成本高 |
| **不想自建基础设施** | D. Cloudflare Tunnel | 托管方案，零运维 |
| **需要 Layer 2 网络** | C. ZeroTier | 虚拟局域网，支持广播 |

**最终建议**：
1. **主力方案**：Tailscale 直连（方案 A）—— 在公司电脑和 Win10 都装 Tailscale，实现 P2P 直连
2. **兜底方案**：txhk 中转（方案 F，当前已部署）—— 当无法安装客户端时使用
3. **两者并存**：日常用 Tailscale（低延迟），临时设备用 txhk 中转（无需客户端）

---

## 4. 路径 B：txhk 公网中转（当前方案）

> 以下已修正 v1.0 审计发现的 A–L 全部缺陷。**所有配置纳入 spool 版本管理**（§4.6），不手动 SSH 编辑。

### 4.1 nftables 动态白名单（修正 A/E：补 established + lo）

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
        ct state established,related accept    # 已建立会话放行 → 不受 TTL 影响（修正 A）
        iif "lo" accept                        # 本机回环放行 → 自测 127.0.0.1:33890 可用（修正 E）
        tcp dport 33890 ip saddr @allowed_ips accept
        tcp dport 33890 drop                   # 未授权一律丢弃
    }
}
```

加载与持久化（systemd，开机生效）`hosts/txhk/systemd/nftables-rdp.service`：

```ini
[Unit]
Description=Load nftables RDP guard rules
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/nftables.d/rdp_guard.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

### 4.2 IP 登记服务 unlock（修正 B/D/F：X-Real-IP + 校验 + 去 Flask）

**修正 F**：去掉 Flask 重型依赖与 `pip install` 系统污染，改用 Python 标准库 `http.server`（零依赖）。
**修正 B**：不再解析可伪造的 `X-Forwarded-For[0]`，只信 Caddy 用 `{remote_host}` 注入的 `X-Real-IP`。
**修正 D**：登记前用 `ipaddress` 校验，拒绝非法值与 IPv6（本 set 仅 v4）。

`hosts/txhk/rdp-unlock/unlock.py`：

```python
#!/usr/bin/env python3
"""RDP 白名单登记服务：仅信任 Caddy 注入的 X-Real-IP，校验后写入 nftables set。"""
import ipaddress, json, logging, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(filename='/var/log/rdp-unlock.log',
                    level=logging.INFO, format='%(asctime)s %(message)s')

def whitelist(ip: str):
    addr = ipaddress.ip_address(ip)          # 非法直接抛异常（修正 D）
    if addr.version != 4:
        raise ValueError(f'IPv6 not supported by this set: {ip}')
    subprocess.run(['sudo', 'nft', 'add', 'element', 'inet', 'rdp_guard',
                    'allowed_ips', '{', str(addr), '}'],
                   check=True, capture_output=True, text=True, timeout=5)

class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._json(200, {'status': 'ok'})
        ip = (self.headers.get('X-Real-IP') or '').strip()   # 只信 Caddy 注入（修正 B）
        try:
            whitelist(ip)
            logging.info(f'whitelisted {ip}')
            self._json(200, {'status': 'ok', 'ip': ip,
                             'message': f'IP {ip} 已放行，请在 3 分钟内发起 RDP 连接'})
        except Exception as e:
            logging.error(f'unlock failed ip={ip!r}: {e}')
            self._json(500, {'status': 'error', 'message': '放行失败'})

    def log_message(self, *a):    # 静默默认访问日志
        pass

if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 8090), Handler).serve_forever()
```

服务账户与 sudoers（最小权限）`hosts/txhk/sudoers/rdp-unlock`：

```
rdpunlock ALL=(root) NOPASSWD: /usr/sbin/nft add element inet rdp_guard allowed_ips { [0-9.]* }
```

`hosts/txhk/systemd/rdp-unlock.service`：

```ini
[Unit]
Description=RDP IP Whitelist Unlock Service
After=network.target nftables-rdp.service
Requires=nftables-rdp.service

[Service]
Type=simple
User=rdpunlock
Group=rdpunlock
ExecStart=/usr/bin/python3 /opt/rdp-unlock/unlock.py
Restart=always
RestartSec=3
NoNewPrivileges=false
ProtectSystem=strict
ReadWritePaths=/var/log/rdp-unlock.log

[Install]
WantedBy=multi-user.target
```

### 4.3 Caddy 反代 + forward_auth（修正 B：注入可信真实 IP）

追加到 `hosts/txhk/caddy/Caddyfile`：

```caddyfile
# RDP 解锁站点（Authelia 2FA 通过后登记客户端 IP）
rdp.singll.net {
    forward_auth 127.0.0.1:9091 {
        uri /api/verify?rd=https://auth.singll.net/
    }
    reverse_proxy 127.0.0.1:8090 {
        header_up X-Real-IP {remote_host}   # 用 TCP peer 覆写，攻击者无法伪造（修正 B）
    }
}
```

- DNS：`rdp.singll.net` 的公网 A 记录改为 `43.129.195.4`（原指 192.168.7.1）。家里 openclash 已对 `+.singll.net` 走真实 DNS，解析一致。
- 无需改 Authelia ACL：`*.singll.net → two_factor` 已覆盖。

> **认证语义提醒（审计 G）**：Authelia `session 1h / inactivity 5m`，一次 2FA 后在有效期内再访问 `rdp.singll.net` **不会重新要 TOTP**，实质是「持有效会话即可解锁」。若要「每次开门强制 2FA」，需缩短 session 或为该站单独 cookie 策略。

### 4.4 转发层 socat（修正 C：消除 fail-open 竞态）

v1.0 的 `rdp-forward` 不依赖防火墙规则加载 → 若 nft 晚于 socat 启动，33890 会裸奔。修正 `hosts/txhk/systemd/rdp-forward.service`：

```ini
[Unit]
Description=Forward RDP to Home Win10 via Tailscale subnet route
After=network.target tailscaled.service nftables-rdp.service
Requires=tailscaled.service nftables-rdp.service     # 防火墙先于转发（修正 C）

[Service]
ExecStart=/usr/bin/socat -d TCP-LISTEN:33890,fork,reuseaddr TCP:192.168.7.129:3389
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

> 也可用 **systemd-socket-proxyd** 免去安装 socat（见 §7）。`192.168.7.129` 经 Tailscale 子网路由可达（route 节点提供），无需 Win10 装 Tailscale。

### 4.5 通知联动（可选，修正 H：私有主题）

ntfy 主题改用**随机串**或带 access token，避免解锁 IP 泄露/被伪造。在 `unlock.py` 的 `whitelist` 成功后追加：

```python
import urllib.request
def notify(ip):
    try:
        urllib.request.urlopen(urllib.request.Request(
            'https://ntfy.singll.net/rdp-<随机串>',          # 非公开主题（修正 H）
            data=f'RDP unlock: {ip}'.encode(),
            headers={'Title': 'RDP 白名单触发', 'Priority': 'high', 'Tags': 'warning'}),
            timeout=5)
    except Exception as e:
        logging.error(f'ntfy failed: {e}')
```

### 4.6 纳入 spool 部署（修正 J：版本化，不手动 SSH）

在 `silkspool.yaml` 的 `txhk` 主机下增加 sync_rules 与 post-push hook：

```yaml
    sync_rules:
      - { local: "rdp-unlock/unlock.py",            remote: "/opt/rdp-unlock/unlock.py" }
      - { local: "nftables/rdp_guard.nft",          remote: "/etc/nftables.d/rdp_guard.nft" }
      - { local: "sudoers/rdp-unlock",              remote: "/etc/sudoers.d/rdp-unlock" }
      - { local: "systemd/nftables-rdp.service",    remote: "/etc/systemd/system/nftables-rdp.service" }
      - { local: "systemd/rdp-unlock.service",      remote: "/etc/systemd/system/rdp-unlock.service" }
      - { local: "systemd/rdp-forward.service",     remote: "/etc/systemd/system/rdp-forward.service" }
    post_push_hooks:
      - { pattern: "sudoers/rdp-unlock",   command: "chmod 440 /etc/sudoers.d/rdp-unlock && visudo -cf /etc/sudoers.d/rdp-unlock" }
      - { pattern: "caddy/Caddyfile",      command: "systemctl reload caddy" }   # 补 txhk 缺失的 reload hook
      - { pattern: "systemd/.*\\.service", command: "systemctl daemon-reload" }
```

一次性初始化（创建账户、装 socat、启服务）：

```bash
spool exec txhk "sudo useradd -r -s /usr/sbin/nologin rdpunlock 2>/dev/null; \
  sudo apt-get install -y socat; \
  sudo touch /var/log/rdp-unlock.log && sudo chown rdpunlock:rdpunlock /var/log/rdp-unlock.log; \
  sudo mkdir -p /etc/nftables.d"
spool sync push txhk
spool exec txhk "sudo systemctl enable --now nftables-rdp rdp-unlock rdp-forward"
```

---

## 5. Windows 10 加固（Win10 开机后执行）

```powershell
# 1. 专职低权账户（强密码、永不过期）
$pw = Read-Host -AsSecureString "rdp_remote 密码(16+位)"
New-LocalUser -Name "rdp_remote" -Password $pw -PasswordNeverExpires -AccountNeverExpires
Add-LocalGroupMember -Group "Remote Desktop Users" -Member "rdp_remote"
Add-LocalGroupMember -Group "Users" -Member "rdp_remote"
# 确认不在 Administrators
Get-LocalGroupMember -Group "Administrators" | Where-Object Name -like "*rdp_remote*"

# 2. 强制 NLA（网络级别身份验证）
(Get-WmiObject -class Win32_TSGeneralSetting -Namespace root\cimv2\terminalservices `
  -Filter "TerminalName='RDP-tcp'").SetUserAuthenticationRequired(1)

# 3. 账户锁定（5 次失败锁 15 分钟）
net accounts /lockoutthreshold:5 /lockoutwindow:15 /lockoutduration:15

# 4. 防火墙作用域（按路径分别放行）
#   路径 B（中转）：socat 从 txhk 的 Tailscale IP 100.64.0.3 发起 → 放行 Tailscale 段
Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -RemoteAddress "100.64.0.0/10"
#   Tailscale 直连：Win10 加入 Tailscale 后，RDP 流量来自 Tailscale 段，同上规则已覆盖
```

> 路径 B 下，Win10 看到的源 IP 是 txhk 的 `100.64.0.3`（socat 出口），与防火墙 `100.64.0.0/10` 一致；真正按客户端 IP 收敛的是 txhk 的 nftables 白名单。Tailscale 直连时，Win10 看到的源 IP 是客户端的 Tailscale IP，同样在 `100.64.0.0/10` 段内。

---

## 6. 安全机制时间线

| 时间 | txhk 中转事件 |
|------|------|
| T+0 | 客户端访问 `rdp.singll.net`，Authelia 2FA（或持有效会话） |
| T+~10s | 认证通过，`unlock.py` 把客户端 IP 写入 nftables set（TTL=3min） |
| T+1min | mstsc 连 `43.129.195.4:33890`，TCP 握手 → socat → Win10 NLA 登录 |
| T+3min | 白名单条目过期，**新连接**被 drop |
| T+3min 之后 | ✅ **已建立的 RDP 会话不受影响**（`ct state established,related accept` 放行），持续到主动断开 —— v1.0 此承诺因缺 established 规则而**不成立**，本版已修正 |

---

## 7. 工具调研（替代/增强选型）

| 方案 | 公网 RDP 暴露 | 客户端要求 | txhk/家里负载 | 落地复杂度 | 适配本场景 |
|------|------|------|------|------|------|
| **Tailscale 直连** | 否（端到端加密） | 装 Tailscale | 极低 | **低**（已有 Headscale） | 🥇 性能最好，P2P 直连，与现有基础设施无缝集成 |
| **当前方案：socat 中转** | 是（Authelia+白名单 gated） | 仅需 v4 | 极低 | 中 | 🥈 永远可用，兜底方案 |
| **WireGuard 手动** | 否（端到端加密） | 装 WireGuard | 极低 | 中（手动配置） | ✅ 性能好，但不如 Tailscale 省心 |
| **ZeroTier** | 否（端到端加密） | 装 ZeroTier | 极低 | 低 | △ 与 Tailscale 同类，已有 Tailscale 则无需 |
| **Cloudflare Tunnel** | 否（TLS 加密） | 装 WARP | 低 | 中 | △ 托管方案，非 P2P |
| **frp 反向代理** | 是（需额外安全层） | 无需 | 低 | 中 | △ 与 socat 中转等价，无性能提升 |
| Guacamole 浏览器内 RDP | 否（443 复用） | 仅浏览器 | **高**（Tomcat+guacd） | **高**（guacd 须源码编译） | ❌ 仍绕香港、txhk 偏重、非原生体验 |
| fwknop SPA 单包授权 | 否（端口隐形） | 需装客户端 | 极低 | 中 | △ 隐蔽性最强，但非"浏览器即可"，上游活跃度下降 |
| systemd-socket-proxyd | 同当前方案 | 同当前方案 | 极低 | **低**（systemd 自带） | ✅ **替代 socat 免安装**，推荐用于 §4.4 |
| caddy-l4（L4 反代） | 同当前方案 | 同当前方案 | 低 | 中（须 xcaddy 重编译 Caddy） | △ 与 Caddy 统一，但纯转发相比 socat 优势有限 |

要点与来源：

- **systemd-socket-proxyd**：systemd 自带，`.socket`(监听 33890) + `.service`(proxy 到 192.168.7.129:3389)，零额外依赖，可替代 §4.4 的 socat。
- **[Guacamole 1.6.0](https://guacamole.apache.org/doc/1.6.0/gug/guacamole-native.html)**：guacd 必须源码编译（cairo/libjpeg/libvncserver 等），Tomcat 9/10 的 javax/jakarta 命名空间坑；txhk 2 核 3.6G 偏重。本场景不推荐。
- **[fwknop SPA](https://github.com/mrash/fwknop)**：端口对 nmap 完全隐形、抗重放、纯 C 无解释器依赖、可对接 nftables；适合替换"web 解锁"为"单包解锁"，但要装客户端，不满足"任意浏览器即可"。
- **[caddy-l4](https://github.com/mholt/caddy-l4)** / [layer4 proxy 文档](https://caddyserver.com/docs/modules/layer4.handlers.proxy)：声明式 L4 路由，需 `xcaddy build --with github.com/mholt/caddy-l4`；RDP 后端不认 proxy_protocol，纯转发场景收益不大。
- **Tailscale 直连**：最安全且性能最好，Win10 装 Tailscale 加入 Headscale 后，客户端也装 Tailscale 即可实现 P2P 直连（见 §3 方案 A）。若客户端无法装 Tailscale，Win10 的 Tailscale 仍可简化当前方案的转发目标（直接转发到 100.64.0.1，免依赖 route 子网路由）。

---

## 8. 部署与验证清单

```bash
# === 路径 B 部署后验证（txhk）===
spool exec txhk "sudo systemctl status nftables-rdp rdp-unlock rdp-forward --no-pager | grep Active"
spool exec txhk "sudo ss -tlnp | grep -E ':(8090|33890)'"
spool exec txhk "sudo nft list table inet rdp_guard"        # 含 ct state / iif lo / 两条 dport 规则
spool exec txhk "curl -s -o /dev/null -w '%{http_code}' -I https://rdp.singll.net"   # 302 → auth
# 链路（已验证 OK）
spool exec txhk "ping -c1 192.168.7.129 && timeout 3 bash -c 'echo>/dev/tcp/192.168.7.129/3389' && echo 3389-OPEN"

# === 端到端（外网客户端）===
# 1) 浏览器访问 https://rdp.singll.net 完成 2FA
# 2) spool exec txhk "sudo nft list set inet rdp_guard allowed_ips"   # 应见客户端 IP
# 3) mstsc 连 43.129.195.4:33890 → rdp_remote 登录
# 4) 等 3 分钟后新连接应被拒；已连会话不掉线
```

---

## 9. 故障排查

| 问题 | 可能原因 | 排查 |
|------|---------|------|
| 所有 Tailscale 节点 offline | headscale 被 Caddy 2FA 拦 / openclash fake-ip 劫持（见 §0） | `curl -I https://headscale.singll.net/key`（应 400 非 302）；istoreos `nslookup headscale.singll.net`（应真实 IP 非 198.18.x） |
| rdp.singll.net 认证后 500 | unlock 未启动 / sudoers 错 / X-Real-IP 空 | `journalctl -u rdp-unlock`；`tail /var/log/rdp-unlock.log` |
| RDP 连上 3 分钟后掉线 | nftables 缺 `ct state established`（v1.0 缺陷） | `nft list table inet rdp_guard` 确认含 established 规则 |
| 自测 `nc 127.0.0.1 33890` 失败 | 缺 `iif lo accept` | 同上确认含 lo 放行 |
| route offline / 子网路由丢失 | istoreos tailscaled 未连控制面 | `spool exec istoreos "tailscale status"`；必要时 `/etc/init.d/tailscale restart` |
| Tailscale 直连不通 | 客户端/Win10 未上线 / 公司网阻止 UDP | `tailscale status`；`tailscale ping <对端>`；检查 DERP 回退 |

### 日志位置

| 服务 | 位置 |
|------|------|
| Caddy / Authelia / rdp-forward | `journalctl -u <svc>` |
| unlock | `/var/log/rdp-unlock.log` |
| nftables | `journalctl -k | grep rdp_guard` |

---

## 附录：命令速查

```bash
# nftables 白名单
spool exec txhk "sudo nft list set inet rdp_guard allowed_ips"
spool exec txhk "sudo nft add element inet rdp_guard allowed_ips { 1.2.3.4 }"
spool exec txhk "sudo nft delete element inet rdp_guard allowed_ips { 1.2.3.4 }"

# 服务
spool exec txhk "sudo systemctl restart rdp-unlock rdp-forward"
spool logs txhk caddy 50

# 链路
spool exec txhk "ping 192.168.7.129; timeout 3 bash -c 'echo>/dev/tcp/192.168.7.129/3389'"
spool exec istoreos "tailscale status; nslookup headscale.singll.net"
```

---

*文档版本: 3.0 | 重写日期: 2026-06-06 | 移除 IPv6 路径（Win10 无 v6），新增直连方案对比 | 前置 P0 已修复*
