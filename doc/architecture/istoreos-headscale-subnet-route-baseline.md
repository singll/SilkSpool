# iStoreOS + Headscale 子网路由稳定配置基线

> 适用场景：iStoreOS/OpenWrt 作为家庭网关加入 Headscale/Tailscale Tailnet，对外提供 `192.168.7.0/24` 子网路由访问。
> 目标：保证外部 Tailscale 节点可稳定访问内网 IP，避免 `tailscale0` 接口异常、路由半残、LuCI 配置误操作导致的不可达问题。

---

## 1. 推荐拓扑

```text
外部设备（Tailscale 客户端）
  ↓
Headscale 控制面
  ↓
iStoreOS（route，100.64.0.2，192.168.7.1）
  ↓ 子网路由
192.168.7.0/24
  ├─ knowledge  192.168.7.220
  ├─ keeper     192.168.7.230
  ├─ aigateway  192.168.7.110
  └─ 其他 LAN 设备
```

关键原则：

- **Headscale 负责控制面**：节点注册、路由审批、MagicDNS。
- **iStoreOS 负责数据面**：`tailscale0` 接口、内核转发、LAN 转发、SNAT。
- **子网路由优先稳定**：先只发布 `192.168.7.0/24`，不要在同一节点混用 exit node，除非明确需要。

---

## 2. 推荐 Tailscale 启动参数

在 iStoreOS 上使用以下基线命令：

```bash
tailscale up \
  --login-server=https://headscale.singll.net \
  --accept-dns=false \
  --accept-routes \
  --advertise-routes=192.168.7.0/24 \
  --hostname=route \
  --snat-subnet-routes=true
```

### 参数说明

- `--login-server=https://headscale.singll.net`
  - 使用自建 Headscale 控制面。
- `--accept-dns=false`
  - 不让 Tailscale 覆盖 iStoreOS 本机 DNS。
  - 网关自身仍由本地 dnsmasq / OpenClash / 上游 DNS 体系管理。
- `--accept-routes`
  - 允许该节点学习 Tailnet 中其他已批准路由。
- `--advertise-routes=192.168.7.0/24`
  - 对外宣告家里 LAN 网段。
- `--hostname=route`
  - 固定节点名，便于 Headscale 识别。
- `--snat-subnet-routes=true`
  - **建议始终开启。**
  - 让 LAN 主机回包统一回到 iStoreOS，避免内网设备缺少 `100.64.0.0/10` 回程路由时访问失败。

### 不建议默认启用的参数

```bash
--advertise-exit-node
```

除非明确要让 iStoreOS 充当出口节点，否则不要和子网路由混用。混用会提高排障复杂度，也更容易在变更时误伤现有转发。

---

## 3. iStoreOS / OpenWrt 网络基线

### 3.1 `tailscale0` 接口处理原则

`tailscale0` 是由 `tailscaled` 动态维护的接口。

基线建议：

- 可以在防火墙 zone 中引用 `tailscale0`
- **不要频繁在 LuCI 里手动切换 `tailscale0` 的协议类型**
- 不要把它当作普通 WAN/LAN 接口去回收、重建、桥接
- 如接口显示异常，**优先重启 tailscaled**，不要先在 LuCI 中反复改协议

### 3.2 内核转发

必须开启：

```bash
sysctl net.ipv4.ip_forward
sysctl net.ipv6.conf.all.forwarding
```

理想输出：

```text
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
```

### 3.3 防火墙转发

至少要允许：

- `tailscale0 -> br-lan`
- `br-lan -> tailscale0`

可用以下命令检查：

```bash
iptables -S | grep tailscale
```

常见有效规则示例：

```text
-A FORWARD -i tailscale0 -o br-lan -j ACCEPT
-A FORWARD -i br-lan -o tailscale0 -j ACCEPT
```

---

## 4. Headscale 基线

### 4.1 路由审批

Headscale 侧必须批准 iStoreOS 节点发布的子网路由：

```bash
headscale nodes list-routes
```

理想状态：

- `192.168.7.0/24` 出现在 `Approved`
- `192.168.7.0/24` 出现在 `Serving (Primary)`

如果未批准，外部节点不会真正使用这条子网路由。

### 4.2 MagicDNS

MagicDNS 是否开启不影响子网 IP 直连；它只影响名称解析体验。

也就是说：

- `ping 192.168.7.220` 不依赖 MagicDNS
- `访问 xxx.example.com` 可能依赖 MagicDNS / 本地 DNS / split DNS 配置

不要把“域名还能开”误判成“子网路由正常”。

---

## 5. 稳定性红线

### 红线 1：不要把 `tailscale0` 当普通接口来回切协议

曾出现过的故障表现：

- LuCI 中 `tailscale0` 显示错误
- 手动改成“未配置协议”再切换/保存后
- 外部无法访问 `192.168.7.1` 和 `192.168.7.220`
- Headscale 看起来仍在线、路由也已批准

这类情况通常意味着：

- 控制面正常
- 数据面（接口 / fwmark / 本地转发）异常

正确做法：

```bash
/etc/init.d/tailscale restart
```

然后重新执行基线 `tailscale up` 命令。

### 红线 2：默认不要关闭 SNAT

不要默认使用：

```bash
--snat-subnet-routes=false
```

等价表现通常是：

- 外部节点能看到子网路由
- 但访问内网主机失败
- 尤其是目标主机默认网关、静态路由不统一时更明显

只有在你明确为整个 LAN 配置了到 `100.64.0.0/10 -> 192.168.7.1` 的回程路由时，才考虑关闭 SNAT。

### 红线 3：不要在未验证前混用 exit node

如果只是为了“远程访问家里内网”，不要同时启用：

```bash
--advertise-exit-node
```

先把子网路由跑稳定，再考虑是否追加出口节点能力。

---

## 6. 标准排障流程

### Step 1：看控制面是否在线

```bash
tailscale status
```

确认：

- 本机在线
- 对端在线
- 节点名称正确

### Step 2：看当前偏好配置

```bash
tailscale debug prefs
```

重点检查：

- `AdvertiseRoutes` 是否包含 `192.168.7.0/24`
- `NoSNAT` 是否为 `false`
- 是否意外带上了 `0.0.0.0/0`、`::/0`

理想示例：

```json
{
  "AdvertiseRoutes": ["192.168.7.0/24"],
  "NoSNAT": false
}
```

### Step 3：看 Headscale 是否批准路由

```bash
headscale nodes list-routes
```

确认 `192.168.7.0/24` 已批准并处于 primary。

### Step 4：看本地接口

```bash
ip addr show tailscale0
```

如果接口不存在、状态异常、或明显和 tailscaled 状态不一致，先重启 tailscaled。

### Step 5：看本地转发规则

```bash
iptables -S | grep tailscale
ip route
ip rule
```

### Step 6：双向测试

从外部节点：

```bash
ping 100.64.0.2
ping 192.168.7.1
ping 192.168.7.220
```

从 iStoreOS：

```bash
tailscale ping 100.64.0.3
```

判断逻辑：

- `tailscale ping` 通，但外部 `ping 192.168.7.x` 不通：优先查转发 / SNAT / firewall
- Headscale 已批准，但 `100.64.0.2` 都不通：优先查 `tailscale0` / tailscaled 本地状态

---

## 7. 标准恢复流程

当发现 `tailscale0` 异常、外部无法访问 LAN IP 时，优先执行以下流程：

### 7.1 重启 tailscaled

```bash
/etc/init.d/tailscale restart
```

### 7.2 重新应用基线配置

```bash
tailscale up \
  --login-server=https://headscale.singll.net \
  --accept-dns=false \
  --accept-routes \
  --advertise-routes=192.168.7.0/24 \
  --hostname=route \
  --snat-subnet-routes=true \
  --reset
```

### 7.3 重新验证

```bash
tailscale debug prefs
tailscale status --json
ip addr show tailscale0
```

然后从外部节点再测试：

```bash
ping 192.168.7.1
ping 192.168.7.220
```

---

## 8. 本次故障经验归纳

本项目已遇到过一次典型故障：

- 白天 `tailscale0` 在 iStoreOS 中显示错误
- 外部无法访问子网 IP
- 但仍可借助 `192.168.7.1` 上的 DNS / 本机入口访问部分内网 WebUI
- 后续手动将 `tailscale0` 改为未配置协议，再切换协议并保存
- 导致外部连 `192.168.7.1` 和 `192.168.7.220` 都无法访问
- 最终通过重新设置 `--snat-subnet-routes=true` 并重启 tailscaled 恢复

结论：

> 这类问题通常不是 Headscale 路由审批失败，而是 iStoreOS 上 `tailscale0` 接口和本地转发状态异常；LuCI 手动改协议会进一步扰乱数据面状态。正确修法是重启 tailscaled，并重新应用稳定的子网路由基线配置。

---

## 9. 推荐最小检查清单

每次变更后至少检查以下项目：

```bash
tailscale debug prefs
tailscale status
ip addr show tailscale0
iptables -S | grep tailscale
```

并从外部节点验证：

```bash
ping 192.168.7.1
ping 192.168.7.220
```

只要这两项能通，通常说明子网路由链路已恢复。
