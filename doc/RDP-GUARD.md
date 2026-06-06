# RDP 安全网关实施方案 v3.1

> **目标**：让「装不了 Tailscale 的临时设备」通过原生 RDP（mstsc）安全连接家里内网的 Win10（192.168.7.129）。
> **路径**：txhk 香港公网中转（唯一路径，任意 IPv4 客户端可用）。
> **认证底座**：Authelia 2FA → 动态防火墙白名单（短 TTL）；最后底线：Windows NLA + 弱权账户 + 账户锁定。
>
> 本版基于 2026-06-06 实测：**Win10 无公网 IPv6**，v2.0 的路径 A（IPv6 直连）不可行，已移除。
> 新增 §3「低延迟方案对比」，列出在「公司电脑禁止安装虚拟网卡/虚拟网络、禁止内网穿透、禁止向日葵等远程工具」约束下的替代方案。
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
- △ **如需降低延迟**：在「禁止虚拟网卡/虚拟网络」约束下，需用应用层隧道或优化中转路径，详见 §3。

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

## 3. 低延迟方案对比（公司网络约束下的替代路径）

> **硬约束**：
> - ❌ **禁止安装虚拟网卡/虚拟网络**：Tailscale、WireGuard、ZeroTier、Cloudflare WARP 等创建虚拟网卡的工具全部不可用
> - ❌ **禁止内网穿透**：不可将公司网络桥接到家庭网络（公司电脑不能成为家庭网络的延伸）
> - ❌ **禁止向日葵、ToDesk、TeamViewer 等商业远程工具**
> - ✅ 可安装不修改网络栈的普通应用（如浏览器、SSH 客户端、端口转发工具等）
> - ✅ 目标是原生 RDP 体验（mstsc），而非浏览器或第三方客户端

### 3.1 延迟瓶颈分析

当前方案（txhk 中转）的延迟构成：

```
公司电脑 ──①──→ txhk 香港 ──②──→ Tailscale 隧道 ──③──→ iStoreOS route ──④──→ Win10
          ~30-50ms      ~10ms(本机)      ~80-100ms        ~5ms
                                                         总计: ~130-170ms
```

- **① 公司→txhk**：取决于公司到香港的公网路由，通常 30-50ms（中国大陆→香港）
- **② txhk 本机 socat 转发**：几乎为 0
- **③ txhk→iStoreOS（Tailscale 隧道）**：80-100ms（Tailscale WireGuard 隧道 + 跨境回大陆）
- **④ iStoreOS→Win10**：局域网 <1ms

**关键发现**：延迟的大头是 ①+③ 两段跨境公网路由。要降低延迟，核心是**缩短或合并跨境路径**。

### 3.2 方案总览

| 方案 | 原理 | 客户端要求 | 延迟改善 | 安全性 | 复杂度 | 推荐度 |
|------|------|-----------|---------|--------|--------|--------|
| **A. RD Gateway over HTTPS** | Windows RD Gateway 封装 RDP 到 HTTPS | 仅需 mstsc | 中（减少一跳） | 🥇 SSL+2FA | 高 | ⭐⭐⭐⭐ |
| **B. 国内 VPS 中转** | 用国内 VPS 替代 txhk，免去跨境 | 无需客户端 | **高**（消除跨境延迟） | 🥈 白名单+NLA | 中 | ⭐⭐⭐⭐⭐ |
| **C. SSH 隧道（PuTTY/portable）** | SSH 本地端口转发 | 免安装 portable PuTTY | 中（同 B，换中转服务器） | 🥇 SSH 加密 | 低 | ⭐⭐⭐⭐ |
| **D. frp over WebSocket/TLS** | 从家里主动出站，经公网中转 | 仅需 mstsc | 中（换中转服务器） | 🥈 TLS+token | 中 | ⭐⭐⭐ |
| **E. Win10 安装 Tailscale（仅服务端）** | Win10 加入 Tailscale，简化路径 B | 无需客户端 | 低（仅消除 route 中转） | 🥇 Tailscale 加密 | 低 | ⭐⭐⭐ |
| **F. 当前方案（txhk 中转）** | 固定公网服务器转发 | 无需客户端 | 基线 | 🥈 2FA+白名单 | 中 | ⭐⭐（兜底） |

### 3.3 方案详解

#### 方案 A：RD Gateway over HTTPS

**原理**：Windows Server 的 RD Gateway（远程桌面网关）将 RDP 协议封装在 HTTPS/TLS 隧道内传输。客户端用原生 mstsc 连接时，在「高级」标签页设置 RD Gateway 服务器地址，mstsc 自动通过 HTTPS 443 端口建立隧道，再由 RD Gateway 转发到内网 RDP 目标。

**架构**：
```
公司电脑（mstsc，设置 RD Gateway）
       │
       ▼ HTTPS/443（TLS 加密，看起来就是普通 HTTPS 流量）
       │
txhk 或国内 VPS（RD Gateway 服务）
       │
       ▼ 内网转发
       │
家里 Win10（RDP 3389）
```

**优点**：
- ✅ **客户端零安装**：mstsc 原生支持 RD Gateway，只需在连接设置里填网关地址
- ✅ **流量伪装**：RDP over HTTPS，对网络层而言就是普通 HTTPS 流量，公司防火墙通常不拦截
- ✅ **SSL/TLS 加密**：传输层加密，无需额外 VPN
- ✅ **支持 2FA**：RD Gateway 可对接 RADIUS/NPS 实现 MFA
- ✅ **443 端口复用**：可与 Caddy 共存（SNI 路由或不同路径）

**缺点**：
- ❌ 需要 Windows Server 授权（RD Gateway 是 RDS 角色的一部分）
- ❌ 部署复杂度较高（需 IIS + RD Gateway 角色安装 + 证书配置）
- ❌ 如果仍部署在 txhk，跨境延迟 ① 仍在
- ❌ txhk 是 Linux，需用 Docker 跑 Windows Server 或换其他方案

**实施步骤**：
1. 在国内 VPS 上部署 Windows Server + RD Gateway 角色
2. 配置 SSL 证书 + RD CAP/RAP 策略
3. 客户端 mstsc 连接时设置 RD Gateway 地址
4. 或：在 txhk 上用 Linux 替代方案（如 `guacd` + RDP over WebSocket → 但这又回到 Guacamole 方案）

**延迟分析**：若部署在国内 VPS，可消除跨境段 ③（~80-100ms），保留段 ①（~30ms 国内），总延迟降至 ~40-60ms。

---

#### 方案 B：国内 VPS 中转（最推荐）

**原理**：当前延迟的大头是「公司→香港 txhk→跨境回大陆→家里」。如果把中转服务器换成国内 VPS（如阿里云/腾讯云上海节点），公司→VPS 和 VPS→家里 都是国内路由，跨境延迟完全消除。

**架构**：
```
公司电脑（mstsc）
       │
       ▼ 国内公网（~20-30ms）
       │
国内 VPS（socat/端口转发，Authelia 2FA + 白名单）
       │
       ▼ frp/Tailscale 出站隧道（~20-40ms，国内→家里）
       │
家里 Win10
```

**优点**：
- ✅ **延迟大幅降低**：全部走国内路由，预估 40-70ms（vs 当前 130-170ms）
- ✅ **客户端无需改动**：mstsc 连国内 VPS 的公网 IP:33890 即可
- ✅ **安全架构可复用**：nftables 白名单 + Authelia 2FA + unlock 服务，与 txhk 完全对称
- ✅ **公司防火墙友好**：连接国内 IP，不会被当作异常出境流量

**缺点**：
- ❌ **需要额外购买国内 VPS**（成本 ~30-50 元/月，轻量应用服务器即可）
- ❌ **国内 VPS 需备案**：若用域名访问 Authelia 解锁页面，域名需 ICP 备案；若仅用 IP:端口直连则不需要
- ❌ **家里到国内 VPS 的隧道**：需要从家里主动连出（frp/Tailscale），与当前 txhk 架构类似

**实施步骤**：
1. 购买国内轻量 VPS（1 核 1G 即可，如阿里云/腾讯云/华为云上海节点）
2. 在家里 iStoreOS 上部署 frpc，主动连接国内 VPS 的 frps，建立 RDP 端口映射
3. 或：国内 VPS 安装 Tailscale，加入 Headscale 网络，用 Tailscale 子网路由转发到 Win10
4. 在国内 VPS 上复刻 txhk 的 nftables 白名单 + unlock 服务
5. 客户端 mstsc 连国内 VPS 公网 IP:33890

**不需要备案的情况**：
- 如果只用 `VPS_IP:33890` 直连 RDP，不需要域名，不需要备案
- 如果想用 `rdp.singll.net` 解析到国内 VPS，需要备案（但可以不绑定域名，用 IP 直连）
- unlock 页面可以用 `http://VPS_IP:8090` 而非域名

**延迟预估**：
```
公司→国内VPS: ~20-30ms（国内骨干网）
国内VPS→家里: ~20-40ms（国内→家里，Tailscale 或 frp 隧道）
总计: ~40-70ms（vs 当前 txhk 的 ~130-170ms，改善约 60-70%）
```

---

#### 方案 C：SSH 本地端口转发（PuTTY Portable）

**原理**：利用 SSH 的本地端口转发（`-L`），在公司电脑上通过 SSH 隧道把本地端口映射到远程 RDP 端口。PuTTY 有 portable 版本，无需安装，不创建虚拟网卡。

**架构**：
```
公司电脑
  ├─ PuTTY Portable（SSH -L 13389:192.168.7.129:3389 user@中转服务器）
  └─ mstsc → localhost:13389 → SSH 隧道 → 中转服务器 → Win10:3389
```

**优点**：
- ✅ **不创建虚拟网卡**：SSH 是应用层隧道，仅占用一个本地端口
- ✅ **PuTTY Portable 免安装**：U 盘拷贝即可运行，不写注册表、不装驱动
- ✅ **SSH 加密**：传输安全
- ✅ **公司防火墙友好**：SSH 22 或 443 端口，通常不被拦截（尤其是 443）
- ✅ **可复用现有服务器**：txhk 或国内 VPS 均可

**缺点**：
- ❌ 需要手动配置 PuTTY 端口转发（可保存 session 文件）
- ❌ 如果用 txhk，跨境延迟仍在
- ❌ SSH 隧道不如 WireGuard 高效（用户态转发 vs 内核态）
- ❌ 每次连接需先开 PuTTY 再开 mstsc，步骤稍多

**实施步骤**：
1. 在中转服务器（国内 VPS 或 txhk）上确保 SSH 服务运行
2. 下载 PuTTY Portable，配置 Session：`中转服务器IP`，端口 22 或 443
3. 配置 Connection → SSH → Tunnels：`L13389  192.168.7.129:3389`
4. 中转服务器上需确保能访问 Win10:3389（Tailscale 子网路由或 frp）
5. Open PuTTY 连接后，mstsc 连 `localhost:13389`

**推荐搭配**：PuTTY + 国内 VPS（方案 B），可获得最低延迟 + 无需安装的体验。

**安全增强**：
- SSH 服务器配置 `AllowUsers` 限制可登录用户
- 使用 SSH key 认证而非密码
- 可用 `fail2ban` 防暴力破解

---

#### 方案 D：frp over WebSocket/TLS

**原理**：frp（Fast Reverse Proxy）从家里主动连接公网服务器，建立反向代理隧道。frp 支持 WebSocket/TLS 加密，客户端只需 mstsc 连接公网服务器的映射端口。

**架构**：
```
公司电脑（mstsc → VPS:33890）
       │
       ▼
国内 VPS（frps）
       │
       ▼ frp TLS 隧道（从家里主动建立）
       │
家里 Win10（frpc）
```

**优点**：
- ✅ **客户端无需任何软件**：mstsc 直连即可
- ✅ **从家里主动出站**：绕过 CGNAT 入站限制
- ✅ **frp 支持 TLS 加密**：传输安全
- ✅ **可复用国内 VPS**：与方案 B 共用

**缺点**：
- ❌ 需要在家里 Win10 上运行 frpc（或 iStoreOS 上跑 frpc Docker）
- ❌ frp 端口转发本身不提供 2FA，需额外安全层（nftables 白名单 + Authelia）
- ❌ frpc 进程需持续运行，Win10 重启后需自启

**实施步骤**：
1. 国内 VPS 部署 frps
2. 家里 Win10 或 iStoreOS 部署 frpc，配置 `[rdp]` 节：`local_ip = 192.168.7.129, local_port = 3389, remote_port = 33890`
3. VPS 上配置 nftables 白名单（复用 txhk 的 rdp_guard 方案）
4. 可选：配置 Authelia + unlock 服务

**延迟预估**：与方案 B 相同（~40-70ms），因为路径相同，只是隧道技术从 Tailscale 换成 frp。

---

#### 方案 E：Win10 安装 Tailscale（仅服务端）

**原理**：当前路径 B 中，txhk 到 Win10 需要经过 iStoreOS 的 Tailscale 子网路由（route 节点中转）。如果让 Win10 自己安装 Tailscale 成为独立节点，txhk 可以直接连 Win10 的 Tailscale IP（100.64.0.1），消除 route 节点这一跳。

**架构**：
```
公司电脑（mstsc → txhk:33890）
       │
       ▼
txhk（socat → 100.64.0.1:3389）    ← 直接连 Win10 Tailscale IP
       │
       ▼ Tailscale mesh
       │
家里 Win10（Tailscale 节点 100.64.0.1）  ← 不再经 route 中转
```

**注意**：此方案 **Win10 安装 Tailscale 创建虚拟网卡**，但这是在家里电脑上，不在公司电脑上。公司电脑仍然只用 mstsc，不安装任何东西。

**优点**：
- ✅ **消除 route 节点中转**：txhk 直连 Win10，减少一跳
- ✅ **公司电脑无需改动**：仍用 mstsc → txhk:33890
- ✅ **实施简单**：Win10 装 Tailscale 加入 Headscale 即可

**缺点**：
- ❌ **延迟改善有限**：只省了 route→Win10 的局域网跳（<5ms），跨境延迟 ①+③ 仍在
- ❌ **Win10 需常开 Tailscale**：关机或 Tailscale 离线则不可用
- ❌ **Win10 上装虚拟网卡**（但这是家里电脑，非公司电脑）

**延迟预估**：改善约 5-10ms，总延迟 ~120-160ms，意义不大。

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

**定位**：兜底方案，当无法使用任何辅助工具时使用。

---

### 3.4 方案选择建议

| 场景 | 推荐方案 | 预估延迟 |
|------|---------|---------|
| **可购买国内 VPS** | B. 国内 VPS 中转 | ~40-70ms |
| **可购买国内 VPS + 愿配置** | B + C（SSH 隧道） | ~40-70ms + SSH 加密 |
| **不能买 VPS，可接受 portable 工具** | C. SSH 隧道到 txhk | ~130-170ms（但加密） |
| **不能用任何额外工具** | F. txhk 中转（当前方案） | ~130-170ms |
| **需要 mstsc 原生 RD Gateway 体验** | A. RD Gateway | 取决于服务器位置 |

**最终建议**：
1. **最优方案**：**购买国内 VPS + frp/socat 中转**（方案 B）—— 延迟降低 60-70%，客户端零改动
2. **进阶组合**：方案 B + 方案 C —— 国内 VPS 跑 SSH，公司用 PuTTY Portable 端口转发，额外获得 SSH 加密层
3. **零成本方案**：方案 C（SSH 到 txhk）—— 延迟不变，但获得 SSH 加密 + 不装软件
4. **兜底方案**：方案 F（当前 txhk 中转）—— 无需任何额外配置

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

| 方案 | 公网 RDP 暴露 | 客户端要求 | 服务器负载 | 落地复杂度 | 适配本场景 |
|------|------|------|------|------|------|
| **国内 VPS 中转** | 是（白名单 gated） | 仅需 v4 | 极低 | 中 | 🥇 延迟最优，消除跨境跳 |
| **RD Gateway over HTTPS** | 否（HTTPS 封装） | 仅需 mstsc | 中 | 高（需 WinServer） | ✅ 原生支持，流量伪装，但部署重 |
| **SSH 本地端口转发** | 否（SSH 加密） | PuTTY Portable | 极低 | **低** | ✅ 免安装，加密，可与国内 VPS 搭配 |
| **当前方案：socat 中转** | 是（Authelia+白名单 gated） | 仅需 v4 | 极低 | 中 | 🥈 永远可用，兜底方案 |
| **frp 反向代理** | 是（需额外安全层） | 无需 | 低 | 中 | △ 换中转服务器后有意义 |
| **Win10 装 Tailscale（仅服务端）** | 否（Tailscale 加密） | 无需 | 极低 | 低 | △ 仅省一跳局域网，改善有限 |
| Guacamole 浏览器内 RDP | 否（443 复用） | 仅浏览器 | **高**（Tomcat+guacd） | **高**（guacd 须源码编译） | ❌ 仍绕香港、txhk 偏重、非原生体验 |
| fwknop SPA 单包授权 | 否（端口隐形） | 需装客户端 | 极低 | 中 | △ 隐蔽性最强，但非"浏览器即可"，上游活跃度下降 |
| systemd-socket-proxyd | 同当前方案 | 同当前方案 | 极低 | **低**（systemd 自带） | ✅ **替代 socat 免安装**，推荐用于 §4.4 |
| caddy-l4（L4 反代） | 同当前方案 | 同当前方案 | 低 | 中（须 xcaddy 重编译 Caddy） | △ 与 Caddy 统一，纯转发相比 socat 优势有限 |

要点与来源：

- **systemd-socket-proxyd**：systemd 自带，`.socket`(监听 33890) + `.service`(proxy 到 192.168.7.129:3389)，零额外依赖，可替代 §4.4 的 socat。
- **[Guacamole 1.6.0](https://guacamole.apache.org/doc/1.6.0/gug/guacamole-native.html)**：guacd 必须源码编译（cairo/libjpeg/libvncserver 等），Tomcat 9/10 的 javax/jakarta 命名空间坑；txhk 2 核 3.6G 偏重。本场景不推荐。
- **[fwknop SPA](https://github.com/mrash/fwknop)**：端口对 nmap 完全隐形、抗重放、纯 C 无解释器依赖、可对接 nftables；适合替换"web 解锁"为"单包解锁"，但要装客户端，不满足"任意浏览器即可"。
- **[caddy-l4](https://github.com/mholt/caddy-l4)** / [layer4 proxy 文档](https://caddyserver.com/docs/modules/layer4.handlers.proxy)：声明式 L4 路由，需 `xcaddy build --with github.com/mholt/caddy-l4`；RDP 后端不认 proxy_protocol，纯转发场景收益不大。
- **国内 VPS 中转**：延迟最优方案，购买国内轻量 VPS（阿里云/腾讯云上海节点），复刻 txhk 的 nftables 白名单 + unlock 服务，延迟从 ~130-170ms 降至 ~40-70ms（见 §3 方案 B）。
- **SSH 本地端口转发**：PuTTY Portable 免安装，配置 `-L 13389:Win10:3389`，mstsc 连 `localhost:13389`，适合与国内 VPS 搭配使用（见 §3 方案 C）。
- **Win10 装 Tailscale（仅服务端）**：Win10 加入 Headscale 后，txhk 可直接转发到 100.64.0.1，省去 route 节点一跳，但改善有限（~5-10ms）。

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
| 国内 VPS 中转延迟仍高 | VPS 到家里路由绕路 | `traceroute` 检查 VPS→家里路由；考虑换 VPS 节点位置 |
| SSH 隧道连不上 | SSH 服务未开 / 端口被封 | 检查 SSH 服务状态；尝试 443 端口 |

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

*文档版本: 3.1 | 重写日期: 2026-06-06 | 移除 IPv6 路径，重写直连方案（排除虚拟网卡方案，聚焦国内 VPS 中转 + SSH 隧道） | 前置 P0 已修复*
