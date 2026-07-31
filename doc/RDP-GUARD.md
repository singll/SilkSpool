# RDP 安全网关实施方案 v3.4

> ## ✅ v3.4 已落地（2026-06-06，经 spool 部署并验证）
>
> 本方案已从纸面落到生产。三项技术裁决与实现：
> 1. **授权连接页 = 自研（Go），非开源现成品**：无开源产品恰好做"Authelia forward_auth → 动态 v4 白名单 + 经 Tailscale 跨主机开 v6 pinhole + 返回当前 GUA 页"；fwknop/敲门用的是非 Web、非 2FA 模型，无法与 Authelia 集成。
> 2. **语言 = Go 静态二进制，替换文档中所有 Python**：istoreos 路由器**无 python3** + musl + flash 受限，装 python 不划算；Go `CGO_ENABLED=0 GOARCH=amd64` 单文件零依赖。两机均 x86_64。**txhk 转发也并入 Go（免 socat）**。
>    - `cmd/rdp-gateway`（txhk）：授权页 + v4 白名单(nft+内存双闸) + 调 istoreos agent + **TCP/UDP 代理**，取代 §4.4 `unlock.py` 与 §4.6 socat。
>    - `cmd/rdp6-agent`（istoreos）：仅监听 Tailscale + token + **动态发现 Win10 真实 GUA** + 写 fw4 set，取代 §6.3 `agent.py`。
> 3. **IPv6 获取法 = agent 运行时动态发现真实 GUA**（优先级：EUI-64已观测→邻居表→DHCPv6租约→::129→EUI-64计算）。实测 Win10 用 **SLAAC stable-privacy**（非 EUI-64），agent 经 neigh 命中并返回其真实 GUA `2408:832e:208a:abe0:4d52:fe70:9926:a35d`，比文档"纯算 ::129"稳。DHCPv6 ::129 预留保留作稳定器。
>
> **验证通过**：路径 A（agent 仅 100.64.0.2:8091 监听、返回真实 GUA、错 token 403、fw4 set 开关正常）；路径 B（授权页同时给出 v6/v4 地址、nft 白名单写入、TCP/UDP 代理转发到 192.168.7.129:3389）；**内嵌 DERP 已启用**（/health=200、STUN udp/3478、txhk→home **直连 ~62ms**、netcheck 最近 DERP=txhk）。
>
> **§7 重要修正**：Win10 **不在 Tailscale**、是内网常开机 192.168.7.129。路径 B 经 istoreos 子网路由（`NoSNAT:false`）**SNAT**，Win10 看到的源是 **`192.168.7.1`**，故文档旧 §7 的 `RemoteAddress 100.64.0.0/10` **错**。加固见 `doc/rdp-win10-hardening.ps1`。
>
> **部署坑（spool）**：`spool sync push` 的 `ensureRemoteDir` 对非 root 主机会把"目标文件父目录"`chown` 给同步用户。曾因把文件推到 `/etc/*` 而误把 txhk 的 `/etc`、`/etc/sudoers.d` chown 成 silkspool → sudo 失效（用户 root 执行 `chown root:root /etc /etc/sudoers.d` 已恢复）。**规避**：txhk 的 RDP 文件全部 `spool` 推到 `/opt/rdp-gateway/` 暂存区，再 `spool exec` 用 `sudo install` 落位到 `/etc`。istoreos（root@）不受此影响。
>
> **v3.5 UI/状态增强（2026-06-08）**：`cmd/rdp-gateway` 增加新版控制页、倒计时结束弹窗并跳转 `GW_LOGIN_URL`、当前出口 IP、长期白名单、已加入白名单、连接历史与 `/api/state`；长期白名单持久化到 `GW_STATE_FILE`（默认 `/var/lib/rdp-gateway/state.json`），并通过 `GW_PERMANENT_REFRESH` 周期刷新 nft 短 TTL。连接语义调整为“TTL 只限制新会话”：TCP 已建立会话不重检，UDP 只在创建 per-client 会话时检查白名单，默认空闲 `GW_UDP_IDLE=1800` 秒后回收。`rdp6-agent` 增加 `/status?token=...`，`/open` 返回 `expires_at`。sudoers 需允许 gateway 执行 `nft delete element ... allowed_ips ...`，用于移除长期白名单。
>
> **v3.6 路径 A-v4（IPv4 直连）+ 按需单独开通（2026-06-11）**：
> 1. **§1.2 勘误**：家宽实测**非 CGNAT** —— `pppoe-wan` 直接持有公网动态 v4（如 119.109.63.120/32），公司→家同省联通 ping ~25ms。「IPv4 动态直连不可行」结论作废。
> 2. **新增路径 A-v4**：`rdp6-agent` 增加 `/open4?token&client=<v4>`，把 2FA 客户端 v4 写入 fw4 限源集合 `rdp4_clients`（uci `config ipset` 声明，TTL 180s）并返回家宽当前公网 v4 与入口端口（`RDP4_EXT_PORT=33891`）。`/etc/nftables.d/90-rdp4-dnat.nft`（fw4 include，与 fw4 同表）做静态 DNAT `pppoe-wan:33891 → 192.168.7.129:3389`（仅命中集合内源，集合空=端口关闭，无 fail-open；prerouting `dstnat-5` 先于 OpenClash 劫持链）+ SNAT 伪装 `192.168.7.1`（Win10 防火墙仅放行 `192.168.7.0/24` 无需改动）；转发放行走 uci `Allow-RDP4-dynamic`（独立 base-chain 的 accept 拦不住 fw4 reject，同 rdp6 经验）。**比 v6 路径更严：按客户端源 IP 精确放行**。动态 IP 漂移由授权页实时返回当前家宽 v4 解决。
> 3. **开通模型改为按需单独武装**（最小授权）：登录 2FA 后**不再自动开通任何通路**，控制页三张卡片（v4 直连推荐 / v6 直连 / 香港中转托底）各自带「开通」按钮，分别调 `/api/open/v4|v6|relay`，开哪条武装哪条，各自独立 TTL 倒计时。长期白名单语义不变（中转常通）。gateway 新增 `GW_AGENT_V4_URL`（默认 `http://100.64.0.2:8091/open4`）。
> 4. **动机**：txhk 2Mbps 出口限速导致中转刷屏断连（cubic cwnd 崩塌，已另启 BBR 缓解）+ 113ms 香港 trombone；v4 直连同时根治延迟与带宽，公司无 v6 也可用。中转保留为托底。
>
> **待用户侧**：① Cloudflare 加 `rdp.singll.net A → 43.129.195.4`（v6 不绑 DNS——会公开 GUA 且漂移，授权页已实时给）；② 腾讯云安全组放行 `udp/3478`（STUN，DERP 增强）；③ 公司设备 v6 测试；④ Win10 跑加固脚本；⑤ 浏览器 2FA 实连。

> **v3.7 v4 直连稳定性：TCP-only + 连接保活（2026-07-31）**：
> 1. **问题**：v4 直连（路径 A-v4）"翻网页过快即直接断连"，且因是临时短窗口，断开后**打不进去重连**。目标机是 **PVE 显卡直通的弱显卡 Win10**、家宽上行已到顶。
> 2. **根因**：① **RDP-UDP(RemoteFX)** 在弱显卡高码率 + 受限上行丢包下，图形管线 reset → 整条会话被拉断（UDP 无重传）；② v4 限源集合元素 **短 TTL 180s** 到期即关窗，断线自动重连的新 TCP 连接**不命中 DNAT**、落入 fw4 默认拒绝。
> 3. **修复（四处）**：
>    - **`90-rdp4-dnat.nft` 改 TCP-only**：去掉 UDP 的 DNAT/SNAT，只保留 `tcp dport 33891 → 192.168.7.129:3389`。RDP 被迫走 TCP（有重传），弱上行下不再掉线。
>    - **`rdp6-agent` 连接保活**：v4 从 v6 的 `RDP6_TTL` 拆出独立 **`RDP4_TTL`**（默认 300、部署 600）+ **`RDP4_REFRESH`**（默认 60）。新增 `v4Keeper`：读 `/proc/net/nf_conntrack`，按 `dport=<RDP4_EXT_PORT> && src=<client>` 累计双向包数；有增长则每 `RDP4_REFRESH` 秒重放限源集合元素续期；持续 `RDP4_TTL` 秒无新流量则停止续期、元素在 fw4 自然过期 → 窗口自动关闭。**效果**：活跃连接永不掉、翻页触发的 RDP 自动重连仍命中 DNAT、真断开后窗口自动收口（安全不长开）。`/open4` 响应加 `keepalive`/`refresh`，`/status` 加 `v4_ttl`/`v4_refresh`。
>    - **`rdp-gateway`**：`/api/open/v4` 透传保活标志，控制页 v4 卡片显示「保活中」。必需 env `GW_AGENT_V4_URL`（`http://100.64.0.2:8091/open4`）。
>    - **Win10 加固脚本**：由"启用 RDP-UDP"改为**强制 TCP-only**（`SelectTransport=1`）+ 服务端 **KeepAlive**（`KeepAliveEnable=1` / `KeepAliveInterval=1min`）+ `fDisableAutoReconnect=0`。传输层与网络层一致，连接更快、无 UDP 探测停顿。
> 4. **部署注记（避坑）**：gateway 的 `EnvironmentFile=/etc/rdp-gateway.env` 与 `spool push` 落点 `/opt/rdp-gateway/rdp-gateway.env` **是两个文件**——push 只到暂存区，必须 `spool exec txhk "sudo install -m640 -o root -g root /opt/rdp-gateway/rdp-gateway.env /etc/rdp-gateway.env"` 落位后再 `restart`，否则新增 env（如 `GW_AGENT_V4_URL`）不生效、gateway `envRequired` 崩溃循环。agent 的 `RDP4_TTL`/`RDP4_REFRESH` 由 `rdp6-agent.init` 的 `procd_set_param env` 注入（istoreos root@ 直接生效）。

> **目标**：让「装不了 Tailscale 的临时设备」通过原生 RDP（mstsc）安全连接家里内网的 Win10（192.168.7.129）。
> **架构**：**双路径** —— 快车道 A（IPv6 端到端直连，公司侧有 v6 时启用，最低延迟）+ 兜底 B（txhk 香港公网中转，任意 IPv4 客户端永远可用）。
> **认证底座**：**单点 2FA 在 txhk** —— 一次 Authelia 2FA 同时武装两条路径（v4 中转白名单 + 经 Tailscale 令 istoreos 开 v6 pinhole 并返回当前 Win10 GUA）；最后底线：Windows NLA + 弱权账户 + 账户锁定。
>
> **v3.3 关键变更（2026-06-06）**：
> 1. **IPv6 直连改为 txhk 统一控制**（应需求）：控制面（2FA）留在 txhk，执行面（v6 pinhole）落在 istoreos —— v6 流量只经过家里，pinhole 只能落在那。txhk 经 **Tailscale** 命令 istoreos，**家里不新增任何对公网暴露的服务**（优于 v3.2 的家侧 Authelia 方案）。详见 §6。
> 2. **放行策略选定方案 A（开窗不限源）**：2FA 后 3 分钟内 pinhole 对任意 v6 源开放到 `[Win10 GUA]:3389`，依赖 GUA 不可枚举 + 短窗口 + NLA + 锁定。残余风险与升级到「源限制」的路径见 §8.3。
> 3. **解决 v6 地址漂移**：实测前缀为 ISP 动态委托（重连/重启会变），Win10 用 stable-privacy 地址。方案：DHCPv6 把 Win10 钉到 `::129`（§5.3），**连接前由 txhk 返回当前 GUA**，无需固定地址。
> 4. **修正 v3.2 缺陷**：§8.3「绕过 2FA」措辞改写（实为「不经过 txhk 现有网关，须重建等价网关」）；§6 的 nft 改用 **fw4 `config ipset`+`config rule`** 正确集成（修掉独立 base-chain 被 fw4 默认 drop 覆盖的 bug）。
>
> v3.2 的中转优化（§4.1 内嵌 DERP）、§4 加固、§8 安全审查保留。v1.0–v3.1 数据多处过期，**勿再参照**。

---

## 0. 前置修复记录（2026-06-05，已完成）

部署本方案前必须保证 Tailscale 子网路由可用。06-04 给 txhk 上 Authelia 时引发**两个连锁故障**，导致所有 Tailscale 节点控制面失联。已修复：

| 编号 | 根因 | 修复 | 验证 |
|------|------|------|------|
| P0-1 | txhk 的 Caddy 给 `headscale.singll.net` 整站套了 `forward_auth`（Authelia 2FA），节点用 machine key 走 `/key`、`/ts2021` 控制协议无法过 2FA → 控制面被 302 拦截 | `hosts/txhk/caddy/Caddyfile` 移除 headscale 段的 `forward_auth`，仅保留 `reverse_proxy 127.0.0.1:8080` | `curl /key` 由 302 变 400（直达 Headscale） |
| P0-2 | 家里 istoreos 的 openclash 把 `headscale.singll.net` 分配成 fake-ip（198.18.0.30），本机 tailscaled 连控制面被劫持走代理 → noise 握手 `EOF` | `hosts/istoreos/openclash/openclash_custom_overwrite.sh` 的 `fake-ip-filter` 增加 `+.singll.net`，重启 openclash | 解析回归 43.129.195.4；`route` 节点恢复 online |

> **经验**：部署在 txhk 的自建服务域名必须用真实公网 IP 直连，既不能套面向人的 2FA，也不能进 openclash 的 fake-ip/代理。
> **v3.3 强化**：§4.1 内嵌 DERP 跑在 `headscale.singll.net/derp`，**P0-1/P0-2 现在同时守护着 DERP**；且 §6 的 v6 控制信令走 Tailscale（依赖 route 节点 online），也建立在这条修复之上。

---

## 1. 环境现状（2026-06-06 实测）

### 1.1 txhk 云服务器（中转入口 / 控制面 / DERP）

| 项目 | 值 | 备注 |
|------|-----|------|
| 公网 IPv4 | `43.129.195.4` | 腾讯云 EIP，本机 eth0 实为 `172.19.0.11`（云内网，DNAT 映射） |
| 公网 IPv6 | **无（实测 rc=1）** | 仅 Tailscale ULA。**txhk 无任何全球 v6 出口** → v6 只能用于「公司↔家」端到端，帮不了香港中转段；也意味着「客户端 v6」对 txhk 不可见（§6 设计前提） |
| Tailscale | `100.64.0.3` | 可达 istoreos `route` `100.64.0.2`、Win10 `future` `100.64.0.1` |
| Caddy | v2.10.2 | 入口反代 `*:443`；`/etc/caddy/Caddyfile` |
| headscale | `127.0.0.1:8080`（Caddy 反代 `headscale.singll.net`，`server_url: https://headscale.singll.net`） | DERP 当前 `enabled:false`，待开（§4.1） |
| Authelia | `127.0.0.1:9091` | session `1h`/inactivity `5m`；regulation `3 次/2min → 封 5min`；ACL `*.singll.net → two_factor` |
| 当前对外监听 | `tcp/443` + `udp/41641` | `udp/3478` 当前关闭（内嵌 DERP 需开） |

### 1.2 家里网络（被连目标侧）

| 项目 | 值 | 结论 |
|------|-----|------|
| 路由器 | iStoreOS **24.10.6**，`192.168.7.1`（spool `istoreos` = Tailscale `route` `100.64.0.2`）；防火墙 **fw4（nftables）**，`table inet fw4`；跑 Caddy/Authelia/openclash（Docker）+ tailscaled（subnet router + exit node） | 子网路由把 `192.168.7.0/24` 宣告给 txhk |
| Win10 | `192.168.7.129`，MAC `bc:24:11:98:25:18`（Proxmox VM）；RDP 3389 开放；Tailscale `future` `100.64.0.1` | 已开启 v6，获公网 GUA（stable-privacy 随机接口 ID） |
| **IPv4 公网入站** | PPPoE NAT 出口 | **CGNAT，无法无请求入站**；UDP 打洞可穿透（Tailscale 直连实测成功） |
| **IPv6 公网（家侧）** | br-lan 持 `2408:832e:208a:abe0::1/60`（联通）；RA/DHCPv6 已开，LAN 设备已分配公网 GUA | **家侧 v6 就绪**。前缀为 **`dynamic` 动态委托**（WAN 侧 `2408:832e:2070:e205::/64` valid≈30d/preferred≈7d）→ **重连/重启会变**（§5/§6 应对） |
| **家侧入站 v6 默认策略** | `network.wan.ipv6='auto'`（v6 在 wan/PPPoE 同接口）；fw4 `wan` zone `input=REJECT`/`forward=REJECT` **覆盖 v6** | **入站 v6 默认拒绝** → 开公网 v6 不暴露 LAN；v6 直连须**显式 + 受控**的 fw4 pinhole（§6.3） |

### 1.3 关键结论

- ❌ **IPv4 动态直连不可行**：CGNAT，端口不归你。
- ✅ **IPv4 必经 txhk 中转**（路径 B）：任何 v4 客户端可用，兜底基线。
- ✅ **txhk→home 延迟可砍半**：瓶颈是公共 DERP 绕行（130ms），直连仅 52ms；txhk 内嵌 DERP 锁定 ~52ms（§4.1）。
- △ **IPv6 端到端直连是唯一消除「香港 trombone」的路径**（路径 A，~30–60ms）：家侧已就绪，**唯一未知是公司电脑是否有 v6 出网**（§6.1 测）。

---

## 2. 架构总览：双路径（单点 2FA 在 txhk）

```
                          公司临时设备（仅原生 mstsc）
                                   │
              ① 浏览器访问 https://rdp.singll.net（v4）→ txhk Authelia 2FA
                                   │   一次 2FA 同时武装两条路径：
              ┌────────────────────┴─────────────────────────────┐
              │ ②a 写 txhk nft 白名单（客户端 v4，TTL 3min）       │
              │ ②b 经 Tailscale 令 istoreos 开 v6 pinhole（TTL 3min）│
              │ ②c 返回当前 Win10 GUA（= 当前前缀 + ::129）         │
              └────────────────────┬─────────────────────────────┘
        路径 A（快车道，公司有 v6）  │  路径 B（兜底，永远可用）
   mstsc → [当前 Win10 GUA]:3389    │  mstsc → 43.129.195.4:33890（txhk）
     → 不经香港，直达家里            │    → nft 白名单 gate → socat(TCP+UDP)
     → istoreos fw4 pinhole 放行     │    → Tailscale 直连/内嵌DERP（§4.1）
     → Win10:3389                    │    → route → Win10:3389
   ~30–60ms                          │  ~90–100ms（优化后）
```

| 维度 | 路径 A：IPv6 直连 | 路径 B：txhk 中转 |
|------|------------------|------------------|
| 前提 | 公司电脑有 v6 出网（需测）+ Win10 有 GUA | 仅需客户端有 v4（**永远满足**） |
| 路径 | 公司 → 家（直连，无香港） | 公司 → 香港 txhk → Tailscale → route → Win10 |
| 延迟 | ~30–60ms | ~90–100ms（直连/内嵌 DERP）；未优化 ~170ms |
| 控制面 | **txhk 2FA**（与 B 同一次） | **txhk 2FA** |
| 执行面 | istoreos fw4 `inet fw4` 动态 set（经 Tailscale 受 txhk 命令） | txhk nft `inet rdp_guard` 动态 set |
| 公网新增暴露 | 仅 Win10 v6:3389（窗口期，方案 A 不限源）；**家里无新增公网服务** | txhk:33890（白名单）+ txhk:443（Authelia） |
| 定位 | 有 v6 时优先 | 默认兜底 |

> **决策**：§6.1 测公司 v6。**有 v6** → A 为主、B 兜底（一次 2FA 都开）。**无 v6** → 仅用优化后的 B。两路径共用同一次 txhk 2FA。

---

## 3. 延迟实测与归因（推翻 v3.1 估算）

`spool exec txhk "tailscale ping -c 12 100.64.0.2"`：

```
pong from route (100.64.0.2) via DERP(hkg) in 131ms     ← 冷启动走 Tailscale 公共香港 DERP
pong from route (100.64.0.2) via DERP(hkg) in 130ms
pong from route (100.64.0.2) via 113.227.140.75:41641 in 52ms   ← 第 4 包 UDP 打洞成功，直连
...（持续打流后稳定）via 113.227.140.75:41641 in 53ms
```

- txhk 与公共 `DERP(hkg)` 同在香港，但该 DERP 到家里联通对等极差，绕 ~78ms；txhk→家**直连**仅 52ms。
- `headscale config.yaml`：`derp.server.enabled: false` + 公共 derpmap → 回退落到 130ms 的 hkg。
- v3.1 把 130ms 误当物理延迟。

| 段 | v3.1 口径 | 实测真相 | 优化后（§4.1） |
|---|---|---|---|
| 公司 → txhk | 30–50ms | ~40ms（估，公司侧不可测） | ~40ms |
| **txhk → home** | 80–100ms | **DERP 130ms / 直连 52ms** | **~52ms** |
| home → Win10 | <1ms | <1ms | <1ms |
| **端到端 RTT** | **130–170ms** | **~170ms（DERP）/ ~92ms（直连）** | **~90–100ms** |

---

## 4. 路径 B：txhk 公网中转（优化 + 加固）

### 4.1 ★中转优化：消除 DERP 绕行（txhk 内嵌 DERP）

改 `/etc/headscale/config.yaml` 的 `derp.server`（**占位 IP 必须改对，否则下发坏地址、反而降级**）：

```yaml
derp:
  server:
    enabled: true                       # 原 false
    region_id: 999
    region_code: "txhk"
    region_name: "SilkSpool txhk DERP"
    verify_clients: true                # ★关键安全控制：仅本 tailnet 已认证节点可中继
    stun_listen_addr: "0.0.0.0:3478"
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: 43.129.195.4                  # ★必须改成真实公网 IP（原占位 198.51.100.1）
    # ipv6:                             # ★必须删除（txhk 无全球 v6；原占位 2001:db8::1 须删）
  urls:
    - https://controlplane.tailscale.com/derpmap/default   # 保留作冗余（region 999 对 home 更近，会被优先）
  paths: []
```

开放 STUN：`udp/3478` 需 **host 防火墙 + 腾讯云安全组**都放行。应用：

```bash
spool exec txhk "sudo systemctl restart headscale && sleep 3 && headscale nodes list"   # 数据面不断
spool exec txhk "sudo ss -ulnp | grep ':3478'; tailscale ping -c 8 100.64.0.2"          # 期望直连~52ms / 回退 DERP(txhk)
```

> DERP 经 `headscale.singll.net/derp`（复用 443，TLS）+ STUN `udp/3478`。安全分析见 §8.1。

### 4.2 ★RDP-UDP 传输（提升跟手度）

RDP 8+ 用 UDP/3389（RemoteFX，FEC、无队头阻塞）。补 UDP 转发（§4.6）+ nft UDP gate（§4.3，**须加 `udp drop` 防 fail-open**）。RDP 不通自动回退 TCP，无副作用。

### 4.3 nftables 动态白名单（TCP+UDP gate）

```nft
#!/usr/sbin/nft -f
table inet rdp_guard {
    set allowed_ips { type ipv4_addr ; flags timeout ; timeout 3m }
    chain input {
        type filter hook input priority 0; policy accept;
        ct state established,related accept
        iif "lo" accept
        udp dport 3478 accept                  # STUN（内嵌 DERP）
        tcp dport 33890 ip saddr @allowed_ips accept
        udp dport 33890 ip saddr @allowed_ips accept    # RDP-UDP gate
        tcp dport 33890 drop
        udp dport 33890 drop                   # ★防 UDP fail-open
    }
}
```

### 4.4 IP 登记服务 unlock（v4 白名单 + 触发 v6 开门 + 返回 GUA）

> ⚠️ **v3.4：以下 Python 已被 Go 取代** —— 实际实现为 `cmd/rdp-gateway`（授权页 + v4 白名单 + 调 agent + TCP/UDP 代理一体）。下文 Python 仅留作设计参考。

`hosts/txhk/rdp-unlock/unlock.py`（Python 标准库；只信 Caddy 注入的 `X-Real-IP`；2FA 后**一次性武装两条路径**并返回 HTML）：

```python
#!/usr/bin/env python3
"""2FA 通过后：①把客户端 v4 写入 txhk nft（路径 B）；②经 Tailscale 令 istoreos 开 v6 pinhole（路径 A）；③返回两条连接地址。"""
import ipaddress, json, os, logging, subprocess, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PUB_V4 = '43.129.195.4'; PORT_B = 33890
AGENT  = 'http://100.64.0.2:8091/open'          # istoreos rdp6-agent（仅 Tailscale 可达）
TOKEN  = os.environ.get('RDP6_TOKEN', '')
logging.basicConfig(filename='/var/log/rdp-unlock.log', level=logging.INFO, format='%(asctime)s %(message)s')

def wl_v4(ip):
    a = ipaddress.ip_address(ip)
    if a.version != 4: raise ValueError('need v4')
    subprocess.run(['sudo','nft','add','element','inet','rdp_guard','allowed_ips','{',str(a),'}'],
                   check=True, capture_output=True, text=True, timeout=5)

def open_v6():
    try:
        with urllib.request.urlopen(f'{AGENT}?token={TOKEN}', timeout=5) as r:
            return json.load(r)                 # {'gua':..,'port':3389,'ttl':180}
    except Exception as e:
        logging.error(f'v6 open failed: {e}'); return None

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/health'):
            self.send_response(200); self.end_headers(); return self.wfile.write(b'ok')
        ip = (self.headers.get('X-Real-IP') or '').strip()
        try: wl_v4(ip); logging.info(f'v4 whitelisted {ip}')
        except Exception as e: logging.error(f'v4 fail {ip!r}: {e}')
        v6 = open_v6()
        v6line = (f'IPv6 直连(快，需公司有 v6)：<b>[{v6["gua"]}]:{v6["port"]}</b>（{v6["ttl"]//60} 分钟内）'
                  if v6 else 'IPv6 直连：本次不可用（家侧 agent 无响应，请用中转）')
        body = (f'<meta charset=utf-8><h3>✅ 已授权（约 3 分钟内有效）</h3>'
                f'<p>{v6line}</p>'
                f'<p>中转(兜底，任意网络)：<b>{PUB_V4}:{PORT_B}</b></p>').encode()
        self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8')
        self.end_headers(); self.wfile.write(body)
    def log_message(self,*a): pass

if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 8090), H).serve_forever()
```

sudoers `hosts/txhk/sudoers/rdp-unlock`：需允许受限执行 `nft add element inet rdp_guard allowed_ips { <ipv4> timeout <ttl>s }` 与 `nft delete element inet rdp_guard allowed_ips { <ipv4> }`，分别用于临时/长期放行与移除长期白名单。
service：`rdp-unlock.service` 同 v3.1，并在 `[Service]` 加 `Environment=RDP6_TOKEN=<与 istoreos 同一随机串>`（经 `EnvironmentFile` 注入更佳，文件 gitignored）。

### 4.5 Caddy 反代 + forward_auth

```caddyfile
rdp.singll.net {
    forward_auth 127.0.0.1:9091 { uri /api/verify?rd=https://auth.singll.net/ }
    reverse_proxy 127.0.0.1:8090 { header_up X-Real-IP {remote_host} }   # TCP peer 覆写，防伪造
}
```

- DNS：`rdp.singll.net` A → `43.129.195.4`（openclash 已对 `+.singll.net` 走真实 DNS）。
- **认证语义**：session 1h/inactivity 5m，有效期内再访问不重新要 TOTP（持有效会话即可解锁）。

### 4.6 转发层 socat（TCP + UDP）

`rdp-forward.service`（TCP）：`ExecStart=/usr/bin/socat -d TCP-LISTEN:33890,fork,reuseaddr TCP:192.168.7.129:3389`
`rdp-forward-udp.service`（UDP）：`ExecStart=/usr/bin/socat -d UDP4-LISTEN:33890,fork,reuseaddr UDP4:192.168.7.129:3389`
二者 `After/Requires=tailscaled.service nftables-rdp.service`（防火墙先于转发，防 fail-open）。

> 不改用 nftables DNAT：DNAT 需迁 gate 到 forward 链 + masquerade，多 fail-open 面；socat 用户态拷贝对交互式 RDP 延迟可忽略。

### 4.7 纳入 spool 部署（txhk）

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

---

## 5. IPv6 本地确认与 Win10 地址钉定（家里）

家侧 v6 基本就绪（§1.2）。本节做三件事：①确认入站默认拒绝；②把 Win10 钉到 `::129`（解决地址漂移）；③确认 Win10 拿到该地址。

### 5.1 确认入站默认拒绝（安全前提）

```bash
spool exec istoreos "uci show firewall.@zone[2]; uci show network.wan | grep ipv6"   # wan REJECT + ipv6=auto
```

### 5.2 ★把 Win10 钉到 `::129`（DHCPv6 预留，解决地址漂移）

前缀动态（重连/重启会变），Win10 用 stable-privacy 随机地址。钉定后 GUA = **当前前缀 + ::129**，istoreos 永远能算出当前 GUA（供 §6 返回）。`/etc/config/dhcp` 增加：

```
config host
    option name 'win10'
    option mac 'bc:24:11:98:25:18'
    option ip '192.168.7.129'
    option hostid '129'        # DHCPv6 分配 <前缀>::129
    option duid '<可选，更可靠>'
```

应用：`spool exec istoreos "/etc/init.d/odhcpd reload"`（istoreos 是 root@ 主机，服务控制用 init.d，不用 spool restart）。

### 5.3 确认 Win10 获得 `::129`（开机后）

```powershell
Get-NetIPAddress -AddressFamily IPv6 | ? IPAddress -like "2408:832e:208a:abe0::129"
```

- 有 → 成。RDP 监听所有地址，连 `::129` 即可（其它 SLAAC 地址不影响）。
- 无 → Win10 v6 未启用 DHCPv6（M 标志应触发）；改用 DUID 预留，或临时在 Win10 设静态 `<前缀>::129`（**注意前缀变时需手动改，故首选 DHCPv6 预留**）。

---

## 6. 路径 A：IPv6 端到端直连（txhk 统一控制 + istoreos 经 Tailscale 执行）

> 控制面（2FA）在 txhk，执行面（v6 pinhole）在 istoreos。一次 §4 的 txhk 2FA 即触发本路径（§4.4 的 `open_v6()`）。**家里不新增任何对公网暴露的服务** —— istoreos 的 agent 仅监听 Tailscale 接口，受 txhk 经 100.64 内网调用。

### 6.1 前置测试（公司电脑，必做）

公司临时设备访问 `https://test-ipv6.com/`：拿到 v6 且能连外部 v6 → 路径 A 可行；无 v6 → 仅用路径 B（很多企业网纯 v4）。

### 6.2 架构

```
公司电脑 ──① https://rdp.singll.net（v4）── txhk Authelia 2FA → unlock.py
                                                  │
                            ②（经 Tailscale，100.64）GET http://100.64.0.2:8091/open?token=…
                                                  ▼
istoreos rdp6-agent（仅监听 100.64.0.2）：算出当前 GUA(<前缀>::129) → nft 加入 fw4 set rdp6_open（TTL 180s）→ 回 GUA
                                                  │
                            ③ txhk 把 GUA 显示给用户（[<前缀>::129]:3389）
                                                  ▼
公司电脑 ──④ mstsc 连 [<前缀>::129]:3389（v6 直连，不经香港）── istoreos fw4 放行 → Win10（NLA+锁定）
```

### 6.3 istoreos 侧：fw4 动态放行 + rdp6-agent

**(a) fw4 集成（一次性，`/etc/config/firewall`）—— 用 `config ipset`+`config rule`，规则常驻 fw4、只有 set 成员是动态 TTL：**

```
config ipset
    option name 'rdp6_open'
    option family 'ipv6'
    list match 'dest_ip'
    option timeout '180'

config rule
    option name 'Allow-RDP6-dynamic'
    option src 'wan'
    option dest 'lan'
    option family 'ipv6'
    option proto 'tcp'
    option dest_port '3389'
    option ipset 'rdp6_open'        # 匹配 dest_ip ∈ @rdp6_open（fw4 编译进转发链，不会被默认 drop 覆盖）
    option target 'ACCEPT'
```

应用：`spool exec istoreos "fw4 reload"`。集合空时 → 规则不匹配 → 默认 REJECT（关闭）。

> **为何这样写**：v3.2 用独立 `table inet rdp6_guard` base chain，在 nftables 里 `accept` 不跨链终结，会被 fw4 priority 0 的默认 drop 覆盖（2FA 过了也连不上）。改用 fw4 自己的 set+rule 即并入其转发链，正确生效并随 `fw4 reload` 存活。

**(b) rdp6-agent（`/opt/rdp6-agent/agent.py`，仅监听 Tailscale IP，token 校验，GUA 服务端计算）：**

> ⚠️ **v3.4：以下 Python 已被 Go 取代** —— 实际实现为 `cmd/rdp6-agent`，且 GUA 改为**动态发现真实地址**（neigh/DHCPv6 租约/EUI-64/::129 多法兜底），而非纯算 ::129。下文 Python 仅留作设计参考。

```python
#!/usr/bin/env python3
"""仅监听 Tailscale；校验 token 后把当前 Win10 GUA(<前缀>::129) 加入 fw4 set rdp6_open（TTL），返回该 GUA。"""
import json, os, subprocess, hmac, logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

TS_IP, PORT, HOSTID, TTL = '100.64.0.2', 8091, '129', 180
TOKEN = os.environ.get('RDP6_TOKEN', '')
logging.basicConfig(filename='/tmp/rdp6-agent.log', level=logging.INFO, format='%(asctime)s %(message)s')

def current_gua():
    out = subprocess.run(['ip','-6','addr','show','dev','br-lan','scope','global'],
                         capture_output=True, text=True, timeout=5).stdout
    for ln in out.split('\n'):
        ln = ln.strip()
        if ln.startswith('inet6 2408:') and '::1/' in ln:        # 路由器 <前缀>::1/60
            return ln.split()[1].split('::')[0] + '::' + HOSTID  # <前缀>::129
    raise RuntimeError('no global prefix on br-lan')

class H(BaseHTTPRequestHandler):
    def _j(self,c,o): b=json.dumps(o).encode(); self.send_response(c); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        if not hmac.compare_digest(q.get('token',[''])[0], TOKEN):
            logging.warning('bad token'); return self._j(403, {'error':'forbidden'})
        try:
            gua = current_gua()
            subprocess.run(['nft','add','element','inet','fw4','rdp6_open','{',gua,'timeout',f'{TTL}s','}'],
                           check=True, capture_output=True, text=True, timeout=5)
            logging.info(f'opened {gua}'); self._j(200, {'gua':gua,'port':3389,'ttl':TTL})
        except Exception as e:
            logging.error(f'fail: {e}'); self._j(500, {'error':'open failed'})
    def log_message(self,*a): pass

if __name__ == '__main__':
    HTTPServer((TS_IP, PORT), H).serve_forever()
```

**(c) procd 服务（`/etc/init.d/rdp6-agent`，OpenWRT 用 procd 非 systemd；root 运行因需 nft，动作受限于 GUA 服务端计算）：**

```sh
#!/bin/sh /etc/rc.common
START=95          # 晚于 tailscale，确保 100.64.0.2 已就绪
USE_PROCD=1
start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/python3 /opt/rdp6-agent/agent.py
    procd_set_param env RDP6_TOKEN="$(cat /opt/rdp6-agent/token)"
    procd_set_param respawn
    procd_close_instance
}
```

token 文件 `/opt/rdp6-agent/token`（随机串，与 txhk 同值，spool 同步、gitignored）。纳入 istoreos `sync_rules`，post-push hook 加 `chmod +x /etc/init.d/rdp6-agent`，部署后 `spool exec istoreos "/etc/init.d/rdp6-agent enable && /etc/init.d/rdp6-agent restart"`。

### 6.4 Win10（无需特殊设置）

启用 RDP + NLA（§7）即可；RDP 监听全部地址，连 `::129` 自然可达。可选：若公司 v6 前缀稳定，`Set-NetFirewallRule ... -RemoteAddress "<公司v6前缀>::/64"` 收敛（方案 A 的纵深防御，见 §8.3）。

---

## 7. Windows 10 加固（开机后执行，两路径共用）

```powershell
# 1. 专职低权账户
$pw = Read-Host -AsSecureString "rdp_remote 密码(16+位)"
New-LocalUser -Name "rdp_remote" -Password $pw -PasswordNeverExpires -AccountNeverExpires
Add-LocalGroupMember -Group "Remote Desktop Users" -Member "rdp_remote"
Add-LocalGroupMember -Group "Users" -Member "rdp_remote"
Get-LocalGroupMember -Group "Administrators" | ? Name -like "*rdp_remote*"   # 确认不在管理员组

# 2. 强制 NLA
(Get-WmiObject -class Win32_TSGeneralSetting -Namespace root\cimv2\terminalservices `
  -Filter "TerminalName='RDP-tcp'").SetUserAuthenticationRequired(1)

# 3. 账户锁定（5 次失败锁 15 分钟）—— v6 直连尤为重要
net accounts /lockoutthreshold:5 /lockoutwindow:15 /lockoutduration:15

# 4. 防火墙作用域 —— ★v3.4 修正：Win10 不在 Tailscale，路径 B 经 istoreos 子网路由 SNAT，
#    Win10 看到的源是 192.168.7.1（不是 100.64.0.0/10）。完整脚本见 doc/rdp-win10-hardening.ps1。
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"   # 放行 RDP；门控在上游(txhk 2FA / istoreos 3min pinhole)+NLA+锁定
#   可选收敛：禁用过宽 TCP-In/UDP-In，仅放行 192.168.7.0/24(v4 路径B) 与 2000::/3(v6 路径A)，见 ps1 §5b

# 5. 【v3.7】强制 RDP 传输 TCP-only + 服务端 KeepAlive（根治弱显卡+受限上行下翻页快即断连；取代旧"启用 UDP"）
$ts = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"
Set-ItemProperty $ts -Name "SelectTransport"      -Value 1 -Type DWord   # 0=TCP+UDP 1=仅TCP 2=任一
Set-ItemProperty $ts -Name "KeepAliveEnable"      -Value 1 -Type DWord
Set-ItemProperty $ts -Name "KeepAliveInterval"    -Value 1 -Type DWord   # 分钟
Set-ItemProperty $ts -Name "fDisableAutoReconnect" -Value 0 -Type DWord
```

---

## 8. 安全审查

### 8.1 ★headscale 内嵌 DERP（§4.1）

| 维度 | 分析 | 结论 |
|------|------|------|
| 会泄露 RDP 内容吗 | DERP **只中继 WireGuard 密文，不能解密**；且 txhk 本就是 RDP 明文点（socat），DERP 不增加新暴露 | ✅ 不增加数据暴露 |
| 开放中继滥用 | `verify_clients: true` 仅为本 tailnet 已认证节点中继 | ✅ **必须保持 true** |
| STUN `udp/3478` | 反射放大系数 ~1x，非 DDoS 放大源；需开 host 防火墙 + **腾讯云安全组** | △ 低风险 |
| 信任边界 | txhk 本就持控制面 + RDP 明文 + 唯一公网，失陷即全失；DERP 不增 blast radius | ✅ 不扩大 |
| 可用性坑 | 占位 `198.51.100.1`/`2001:db8::1` 不改会下发坏地址→降级 | ⚠️ **必须改真实 v4、删 v6** |
| 与 P0 联动 | DERP 跑在 `headscale.singll.net/derp`，受 P0-1/P0-2 守护 | ✅ 已覆盖 |

### 8.2 RDP-UDP 转发（§4.2/4.6）

`policy accept` 下必须有 `udp dport 33890 drop`，否则 UDP 全网敞开（§4.3 已加）。RDP-UDP 承载 RDP 自身加密，无新增明文；不通自动回退 TCP。

### 8.3 ★IPv6 直连（§6）—— 措辞修正 + 方案 A 风险

**先澄清 v3.2 措辞**：之前写「绕过 2FA」不准确。准确说：**v6 直连不经过 txhk，故 txhk 现有防火墙网关对它物理无效（防火墙只拦经过自己的流量）**。v3.3 已把控制面留在 txhk（同一次 2FA）、执行面经 Tailscale 落到 istoreos —— **仍是 2FA 门控，不存在绕过**。真正「绕过」只发生在「家侧裸开端口、不挂网关」，本方案明确不采用。

| 风险 | 分析 | 处置 |
|------|------|------|
| **方案 A 不限源** | 2FA 后 3min 内 pinhole 对**任意 v6 源**开放到 `[GUA]:3389` | GUA 不可枚举（/64 扫不出）+ 已 DHCPv6 钉定但**随前缀漂移、从不公开** + 3min 窗口 + NLA + 锁定 + 低权账户。残余风险 = 攻击者**已知**当前 GUA 且在窗口内 + 过 NLA。**实际风险低** |
| 升级到源限制（方案 B） | 需客户端 v6（txhk 不可见） | 解锁页让用户**粘贴自己的 v6**（test-ipv6.com 查），或家里加极小 v6 echo 自动探测 → agent 把 set 改为「源+目的」匹配 |
| **istoreos rdp6-agent** | 提权动作（nft add） | ✅ **仅监听 Tailscale IP `100.64.0.2`**（非公网）；token 校验（`hmac.compare_digest`）；**GUA 服务端计算、不接受客户端传入**（无注入）；动作上限=开 Win10:3389（即方案 A 窗口） |
| **为何用 agent 而非给 txhk SSH-root** | txhk 是公网节点，若给它 istoreos root SSH，txhk 失陷=家路由器失陷 | ✅ agent 是最小权限单动作，**不扩大 blast radius**（重要安全收益） |
| 家侧暴露面 | **无新增公网服务**（agent 仅 Tailscale） | ✅ 优于 v3.2 的家侧 Authelia 公网暴露 |
| fw4 集成正确性 | 独立 base chain 的 accept 会被 fw4 默认 drop 覆盖 | ✅ §6.3 改用 fw4 `config ipset`+`config rule`，并入其转发链 |

**§8.3 小结**：方案 A 仍是 txhk 2FA 门控，配 GUA 不可枚举 + 3min + NLA + 锁定，实际风险低；rdp6-agent 经 Tailscale + token + 服务端算 GUA，是最小权限设计，且家里零新增公网服务。要更严可按上表升级到源限制。

### 8.4 IPv6 本地开启（§5）

LAN 全员获公网 GUA（仅寻址），但 fw4 `wan input/forward=REJECT` 覆盖 v6 → 入站默认拒绝，不暴露 LAN。已实测 `ipv6=auto` 在 wan 同接口（被 wan zone 覆盖），§5.1 复核。

### 8.5 整体威胁模型

| 资产 | 主要威胁 | 控制 | 残余风险 |
|------|---------|------|---------|
| Win10 RDP | 爆破 / RDP 漏洞 | NLA + 低权 + 锁定 + 两路径 2FA 门控 | 中→低；建议补安全更新、监控登录失败 |
| txhk（皇冠明珠） | 失陷→控制面+明文+DERP | 最小权限、443/3478/33890 外不暴露 | 取决于 txhk 加固（SSH key、fail2ban） |
| istoreos rdp6-agent | token 泄露 / 越权 | 仅 Tailscale 监听 + token + 服务端算 GUA + 动作上限 | 低；泄露上限=方案 A 窗口 |
| 中转白名单 | fail-open / TTL 绕过 | `policy accept` + 显式 TCP/UDP drop + `ct established` | 低；部署后核对 4 条 dport 规则 |
| v6 pinhole | 方案 A 窗口期不限源 | 3min TTL + GUA 不可枚举 + NLA + 锁定 | 低；可升级源限制 |

---

## 9. 安全机制时间线

| 时间 | 路径 B（txhk） | 路径 A（v6 直连） |
|------|------|------|
| T+0 | 访问 `rdp.singll.net`，**txhk** Authelia 2FA | （同一次 2FA） |
| T+~10s | unlock 写客户端 v4 → txhk nft（TTL 3min） | unlock 经 Tailscale 令 istoreos 把 `<当前前缀>::129` 加入 fw4 `rdp6_open`（TTL 180s）；返回该 GUA |
| T+1min | mstsc 连 `43.129.195.4:33890` → socat → Win10 NLA | mstsc 连 `[当前 GUA]:3389` → istoreos fw4 放行 → Win10 NLA |
| T+3min | 白名单过期，新连接 drop | set 元素过期，pinhole 关闭，新连接 REJECT |
| T+3min 后 | ✅ 已建立会话不受影响（`ct established`） | ✅ 同（fw4 对 established 已放行） |

---

## 10. 工具调研

| 方案 | 公网 RDP 暴露 | 客户端 | 复杂度 | 适配 |
|------|------|------|------|------|
| txhk 内嵌 DERP（§4.1） | 不增加 | 无 | 低 | 🥇 零成本砍 130→52ms |
| RDP-UDP 转发（§4.2） | 不增加 | 无 | 低 | 🥇 跟手度提升，自动回退 |
| IPv6 直连（§6，txhk 控制） | 是（方案 A 窗口，不限源） | 仅需 v6 出网 | 中 | 🥇 消除 trombone，~30–60ms |
| socat 中转（§4.6） | 是（白名单 gated） | 仅需 v4 | 中 | 🥈 永远可用兜底 |
| 国内 VPS 中转 | — | — | — | ❌ 用户约束：不买新 VPS |
| RD Gateway over HTTPS | 否 | 仅 mstsc | 高（需 WinServer/AD） | ❌ 用户约束：不搭 AD |
| Guacamole | 否 | 浏览器 | 高 | ❌ 仍绕香港、非原生 |

---

## 11. 部署与验证清单

```bash
# === 中转优化（§4.1）===
spool exec txhk "sudo systemctl restart headscale && sleep 3 && headscale nodes list"
spool exec txhk "sudo ss -ulnp | grep ':3478'; tailscale ping -c 8 100.64.0.2"   # 直连~52ms / 回退 DERP(txhk)
# 腾讯云安全组手动放行 udp/3478

# === 路径 B（§4.3-4.7）===
spool exec txhk "sudo systemctl status nftables-rdp rdp-unlock rdp-forward rdp-forward-udp --no-pager | grep Active"
spool exec txhk "sudo nft list table inet rdp_guard"                 # 核对 ct/lo/3478 + TCP&UDP 各 accept+drop
spool exec txhk "curl -s -o /dev/null -w '%{http_code}' -I https://rdp.singll.net"   # 302

# === 路径 A（§5/§6）===
spool exec istoreos "uci show firewall.@zone[2]"                     # wan REJECT
spool exec istoreos "/etc/init.d/odhcpd reload"                      # 钉 ::129 后
spool exec istoreos "fw4 reload && nft list set inet fw4 rdp6_open"  # 空集（关闭态）
spool exec istoreos "/etc/init.d/rdp6-agent enable && /etc/init.d/rdp6-agent restart; logread | grep rdp6 | tail"
spool exec istoreos "ss -tlnp | grep 100.64.0.2:8091"               # agent 仅 Tailscale 监听
# 公司电脑：访问 test-ipv6.com 确认 v6（§6.1）
# Win10：Get-NetIPAddress -AddressFamily IPv6 | ? IPAddress -like '2408:832e:208a:abe0::129'

# === 端到端 ===
# 浏览器 2FA https://rdp.singll.net → 解锁页显示两地址
# 路径 A：mstsc [当前 GUA]:3389 ；路径 B：mstsc 43.129.195.4:33890
# 等 3 分钟：新连接均被拒；已连会话不掉线
```

---

## 12. 故障排查

| 问题 | 可能原因 | 排查 |
|------|---------|------|
| 所有 Tailscale 节点 offline | headscale 被 2FA 拦 / openclash fake-ip（§0） | `curl -I https://headscale.singll.net/key`（应 400）；istoreos `nslookup headscale.singll.net` |
| 改 DERP 后 headscale 起不来 | config 语法 / 占位 IP 未改 | `journalctl -u headscale`；`cp config.yaml.save config.yaml` 回滚 |
| `tailscale ping` 仍 via DERP(hkg) | 内嵌 DERP 未生效 / 3478 被云安全组挡 / 占位 IP | `ss -ulnp\|grep 3478`；核对 `ipv4:`；腾讯云安全组 |
| v6 直连：2FA 过了但连不上 | fw4 set 没生效 / Win10 无 ::129 / 公司无 v6 | `nft list set inet fw4 rdp6_open`（应含 GUA）；§5.3 查 Win10；§6.1 测公司 v6 |
| 解锁页「IPv6 本次不可用」 | rdp6-agent 没起 / token 不符 / route 节点 offline | istoreos `logread\|grep rdp6`；`/tmp/rdp6-agent.log`；核对两端 token；`tailscale status` |
| v6 直连刚连上就被拒 | fw4 缺 established 放行（一般 fw4 自带） | `nft list chain inet fw4 ...`；确认 ct established 早于 reject |
| RDP 3min 后掉线（中转） | nft 缺 `ct state established` | `nft list table inet rdp_guard` |
| route offline | istoreos tailscaled 未连控制面 | `spool exec istoreos "tailscale status"`；`/etc/init.d/tailscale restart` |

### 日志位置

| 服务 | 位置 |
|------|------|
| Caddy/Authelia/headscale/rdp-forward | `journalctl -u <svc>`（txhk） |
| unlock（txhk） | `/var/log/rdp-unlock.log` |
| rdp6-agent（istoreos） | `/tmp/rdp6-agent.log`、`logread \| grep rdp6` |
| nftables（txhk） | `journalctl -k \| grep rdp_guard` |

---

## 附录：命令速查

```bash
# 中转优化诊断
spool exec txhk "tailscale ping -c 8 100.64.0.2; tailscale status; sudo ss -ulnp | grep 3478"

# txhk v4 白名单
spool exec txhk "sudo nft list set inet rdp_guard allowed_ips"
spool exec txhk "sudo nft add element inet rdp_guard allowed_ips { 1.2.3.4 }"

# istoreos v6 pinhole（方案 A）
spool exec istoreos "nft list set inet fw4 rdp6_open"                       # 当前放行的 GUA（空=关闭）
spool exec istoreos "nft add element inet fw4 rdp6_open { 2408:832e:208a:abe0::129 timeout 180s }"  # 手动开
spool exec istoreos "ip -6 addr show br-lan scope global | grep '::1/'"     # 查当前前缀（算 ::129）

# 服务
spool exec txhk "sudo systemctl restart rdp-unlock rdp-forward rdp-forward-udp; sudo systemctl restart headscale"
spool exec istoreos "/etc/init.d/rdp6-agent restart; /etc/init.d/odhcpd reload"

# 链路
spool exec istoreos "tailscale status; uci show firewall.@zone[2]"
```

---

*文档版本: 3.3 | 重写日期: 2026-06-06 | IPv6 直连改为 txhk 统一控制 + istoreos 经 Tailscale 执行（方案 A 开窗）、DHCPv6 钉 ::129 解决地址漂移、连接前由 txhk 返回当前 GUA；修正「绕过 2FA」措辞与 fw4 集成 bug | 中转优化（内嵌 DERP）与安全审查保留 | 前置 P0 已修复*
