# X-Forwarded-For（XFF）伪造影响研究报告

> 研究目的：确定应用代码在什么代理配置下会获取到被攻击者篡改的 XFF 客户端 IP，给出可信/不可信的完整边界，以及 .NET 技术栈下的正确与错误实现。
>
> 方法：本地 Docker 实验环境实测（ASP.NET Core net8.0 + nginx 多种代理形态 + 双代理链），攻击流量统一为伪造 `X-Forwarded-For: 6.6.6.6`；云厂商行为均以官方文档原文核实（Azure Front Door / Application Gateway / App Service、AWS ALB / NLB / CloudFront、GCP Cloud Load Balancing、ASP.NET Core 官方文档）。

---

## 目录

- [〇、概念澄清：XFF 是谁的行为](#〇概念澄清xff-是谁的行为)
- [一、实验环境与使用方法](#一实验环境与使用方法)
- [二、全云 + 中间件完整矩阵](#二全云--中间件完整矩阵)
- [三、代码完整指南：真实 IP vs 篡改值](#三代码完整指南真实-ip-vs-篡改值)
- [四、实测数据（证据附录）](#四实测数据证据附录)
- [五、针对公司代码片段的缺陷分析](#五针对公司代码片段的缺陷分析)
- [六、黑盒探测法（配置不可见时的验证手段）](#六黑盒探测法配置不可见时的验证手段)

---

## 〇、概念澄清：XFF 是谁的行为

**XFF 既不是"中间件 HTTP 服务器的专利"，也不是"云服务独有的配置"——它是"反向代理这个角色"的行为。**

XFF 只是一个**约定俗成的 HTTP 头**（事实标准，非 RFC 标准；标准化版本是 RFC 7239 的 `Forwarded` 头，业界未普及）。微软官方文档原文："*By convention, proxies forward information in HTTP headers.*" 规则只有一条：

> **谁终止了客户端的 HTTP 连接、并代表客户端重新发起请求（即 L7 反向代理/LB），谁就有权对这个头读、写、改、删。**

因此"XFF 行为是什么"必须翻译成：**链路上有哪几跳反代？每一跳归谁管、默认怎么写、能不能配？** 后端最终收到的 XFF = 每一跳行为的叠加。

### 反代层归属总表

| 层 | 角色 | 典型实现 | 能否配置 XFF | 默认行为 |
|---|---|---|---|---|
| L4 负载均衡 | TCP 转发，**看不到 HTTP 头** | AWS NLB、Azure LB | 不涉及 | **不碰 XFF**（伪造值原样穿过，但 TCP 层保留真实 IP） |
| 边缘 CDN/WAF | 托管反代，行为固化 | Front Door、CloudFront、GFE | ❌ 不可配（CloudFront Function 例外） | append |
| L7 LB/网关 | 托管资源但可配 | AppGW v2、AWS ALB、GCP LB | ✅ 可配 | append |
| 集群 Ingress | 自建反代 | nginx-ingress、AGIC、Traefik | ✅ 完全可配 | 依实现（ingress-nginx 默认覆盖） |
| 应用前置 | 藏在运行时里的反代 | IIS+ANCM（进程外）、Apache mod_proxy | 半自动 | ANCM 自动设 XFF + 自动启用受限中间件 |
| 应用服务器 | **源站** | Kestrel、IIS（进程内） | 只读 | 不写 XFF；TCP 对端 = 上一层代理 |

### 常规 SaaS + .NET + Azure 典型拓扑

**拓扑 A：客户 → Azure Front Door → App Service → 代码**

```
浏览器 ──TLS──> [① Front Door] ──> [② App Service 前端FE] ──> [③ ANCM] ──> [④ Kestrel/代码]
                 微软托管边缘        微软托管平台层(不可见)      沙箱内localhost反代    源站
```

代码最终看到的 XFF = `[客户端伪造值...], 真实客户端IP, FD的IP`（每层 append 一次）。①② 微软托管均不可配，可控的只有三件事：应用侧 ForwardedHeaders 中间件、访问限制锁直连、或直接读 `X-Azure-SocketIP`。

**拓扑 B：客户 → FD → Application Gateway → AKS(ingress) → Pod**：②③ 均可配（AppGW Rewrite Set / ingress ConfigMap）——企业"统一配置"通常落在这一层。

**拓扑 C：自建 VM：nginx / IIS+ARR / YARP / HAProxy → Kestrel**：完全自控，XFF 行为就是配置文件里那几行——这是"运维配置好了"最常见的实际含义。

**拓扑 D：纯 Serverless（Container Apps 等）**：平台内置托管 Envoy ingress，行为固化；官方推荐 `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`（**官方警告：此开关不设 KnownProxies 限制，防伪造完全靠网络层**）。

---

## 一、实验环境与使用方法

### 1.1 访问地址

实验虚拟机内网 IP：**`192.168.7.246`**，15 个端口监听 `0.0.0.0`，同网段直接访问（若启用 ufw 需放行 8081-8113/tcp）。

每个服务暴露两个端点：

| 端点 | 含义 |
|---|---|
| `/vuln` | 被测漏洞代码（`GetClientIP` 裸读 XFF 取第一个值）的原样复刻 + 现场证据 |
| `/whoami` | 诊断端点：中间件视角的 `RemoteIpAddress` + 原始 XFF + 应用当前配置 |

`/vuln` 返回字段：`getClientIP_Result`（代码最终算出的"客户端 IP"，等于伪造值即被攻破）、`rawXffHeader`（后端实际收到的 XFF 原文）、`xRealIp`、`remoteAddrHeader`、`remoteIpAddress`（TCP 层对端）。

### 1.2 场景 × 端口对照

**单层代理（后端 = 漏洞代码）：**

| 端口 | 场景 | 代理对 XFF 的动作 |
|---|---|---|
| 8081 | 直连后端（绕过代理） | 无代理 |
| 8091 | 追加模式 | `$proxy_add_x_forwarded_for`（保留客户端 XFF + 追加真实对端） |
| 8092 | 覆盖模式 | `X-Forwarded-For $remote_addr`（丢弃客户端 XFF，重写为真实对端） |
| 8093 | 透传模式 | 不处理 XFF |
| 8101 | 删除模式 | 显式清空 XFF |
| 8102 | X-Real-IP 模式 | 只设 `X-Real-IP=真实对端`，XFF 透传 |

**双代理链（模拟 CDN/FrontDoor → 网关 → 应用）：**

| 端口 | 边缘→内层 | 后端 |
|---|---|---|
| 8110 | 追加→追加（Azure/AWS 默认形态） | 漏洞代码 |
| 8111 | 覆盖→追加（边缘净化，正确企业配置） | 漏洞代码 |
| 8112 | 追加→覆盖（净化太晚，真实 IP 被洗丢） | 漏洞代码 |
| 8096 | 追加→追加 | 中间件 ForwardLimit=1（跳数不配） |
| 8097 | 追加→追加 | 中间件 ForwardLimit=2（跳数匹配） |
| 8113 | 覆盖→追加 | 中间件 ForwardLimit=2（双保险） |
| 8094 | 追加（单层） | 中间件正确配置 |
| 8095 | 追加（单层） | 中间件默认配置（只信 loopback） |
| 8098 | 追加→追加 | 中间件默认配置 |

### 1.3 标准测试流程

```bash
# 攻击流量（伪造 XFF）
curl -s -H "X-Forwarded-For: 6.6.6.6" http://192.168.7.246:8091/vuln

# 对照流量（正常用户，验证真实 IP 传递链路）
curl -s http://192.168.7.246:8091/vuln

# 全场景扫描
for p in 8081 8091 8092 8093 8101 8102 8094 8095 8096 8097 8098 8110 8111 8112 8113; do
  echo "--- $p ---"; curl -s -H "X-Forwarded-For: 6.6.6.6" http://192.168.7.246:$p/vuln; echo
done

# 补充攻击向量
curl -s -H "X-Forwarded-For: 2001:db8::1234" http://192.168.7.246:8091/vuln    # IPv6 截断 bug
curl -s -H "REMOTE_ADDR: 9.9.9.9" http://192.168.7.246:8081/vuln               # REMOTE_ADDR 死代码路径
curl -s -H "X-Forwarded-For: 6.6.6.6, 7.7.7.7, 8.8.8.8" http://192.168.7.246:8091/vuln  # 多值注入
```

**结果判读三问**：

1. `rawXffHeader` 里有没有伪造值 → 伪造值是否传递过去
2. 对照组 `rawXffHeader` 里有没有真实客户端 IP → 真实 IP 是否丢失
3. `getClientIP_Result` 等于什么 → 被测代码在该配置下的实际行为

### 1.4 环境运维

```bash
# 查看 / 重启（虚拟机重启后）
docker ps --filter network=xff-lab
docker start $(docker ps -aq --filter network=xff-lab)

# 修改代理配置后重建某场景（例：8091 改为覆盖模式）
docker rm -f px-append-raw
docker run -d --name px-append-raw --network xff-lab -p 8091:80 \
  -v /tmp/opencode/xff-lab/proxy/templates/overwrite.conf.template:/etc/nginx/templates/default.conf.template:ro \
  -e APP_UPSTREAM=xa-raw -e APP_PORT=8080 nginx:alpine

# 修改应用代码后重建（代码在 /tmp/opencode/xff-lab/app/）
cd /tmp/opencode/xff-lab && docker build -t xff-lab-app ./app
# 然后删掉 xa-* 容器按原环境变量重新 run，并 restart 所有 nginx 容器重新解析上游

# 整体销毁
docker rm -f $(docker ps -aq --filter network=xff-lab) && docker network rm xff-lab
```

> ⚠️ `/tmp` 在部分系统重启后会清空，建议将 `/tmp/opencode/xff-lab` 拷贝至 home 目录长期保存。

---

## 二、全云 + 中间件完整矩阵

### 2.0 判定模型

任何一跳 L7 反代对 XFF 只有四种行为：

| 行为 | 伪造值 | 真实IP | 一句话 |
|---|---|---|---|
| **append 追加** | ✅ 透传到后端 | 在链中，需从右按跳数解析 | 业界默认，裸读必伪造 |
| **overwrite 覆盖/净化** | ❌ 丢弃 | 唯一值 | 边缘做 = 推荐 |
| **preserve 透传** | ✅ 原样到达 | ❌ 不在 header 里 | 危险 |
| **remove 删除** | ❌ | ❌ | 安全但审计失真 |

### 2.1 自建中间件/反代完整对照

| 组件 | 默认行为 | ❌ 不安全配置 | ✅ 安全配置 | 后端侧配套 |
|---|---|---|---|---|
| **nginx** | 不写 `proxy_set_header` = **透传**（客户端头原样转发） | 透传；或 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`（append，伪造值保留） | 边缘：`proxy_set_header X-Forwarded-For $remote_addr;`（净化） | nginx 做后端时：`set_real_ip_from <代理网段>; real_ip_header X-Forwarded-For; real_ip_recursive on;`（等价 .NET 中间件，从右跳过可信代理） |
| **Apache mod_proxy** | **自动 append**（官方：XFF is added automatically） | 默认 append，伪造值保留 | 净化技巧：`RequestHeader unset X-Forwarded-For` 先删，mod_proxy 再自动写入真实 IP = 等效覆盖 | Apache 做后端：`mod_remoteip` + `RemoteIPHeader X-Forwarded-For` + `RemoteIPTrustedProxy <代理IP>` |
| **HAProxy**（HTTP 模式） | `option forwardfor` = **append** | `option forwardfor` 且后端裸读 | `http-request set-header X-Forwarded-For %[src]`（覆盖净化） | 无内置解析，交给应用中间件 |
| **IIS + ARR** | 反代时 **append** XFF | 默认 append | URL Rewrite 入站规则把 `HTTP_X_FORWARDED_FOR` 重写为 `{REMOTE_ADDR}`（净化） | ASP.NET Core ForwardedHeaders 中间件 |
| **Traefik** | `forwardedHeaders.insecure: true` = 信任一切 | `insecure: true`（官方命名即 insecure） | `forwardedHeaders.trustedIPs: ["代理CIDR"]`：只信清单内的 XFF，清单外客户端的 XFF 被覆盖为真实 IP ✅ | 应用中间件 |
| **Envoy** | `use_remote_address: true` = append | append + 后端裸读 | `xff_num_trusted_hops: N`（= 跳数，从右取信）；`skip_xff_append` 控制追加 | 应用中间件 |
| **YARP**（.NET 网关） | 默认 transform = **append** `X-Forwarded-*` | 默认 append | transform 中 X-Forwarded 的 action 改 `Set`（覆盖净化）或 `Remove` | 应用中间件 |
| **ingress-nginx**（K8s） | `use-forwarded-headers: "false"`（默认）= **忽略客户端 XFF，自写真实 IP（覆盖净化）✅ 默认即安全** | `use-forwarded-headers: "true"`（前方还有 L7 代理时才需要）且 `proxy-real-ip-cidr` 未配 → 信任伪造值 | 链式部署：`use-forwarded-headers: "true"` + `proxy-real-ip-cidr: "上层代理网段"` | 应用中间件 |
| **IIS ANCM**（进程外托管） | ANCM localhost 反代自动设 XFF/XFP；IIS Integration **自动启用受限中间件**（只信 localhost 单跳，官方注明是出于 IP spoofing 顾虑） | 之上又有多层代理但未配中间件 → 只能拿到 localhost 前一跳的信息 | 多层代理时手动配 ForwardedHeaders（KnownNetworks + ForwardLimit） | 进程内托管（in-process）无此层 |

### 2.2 Azure

| 服务 | 默认 XFF 行为 | ❌ 不安全配置 | ✅ 安全配置 | 可信替代通道 |
|---|---|---|---|---|
| **Front Door** | **append（固化不可改）**：保留客户端 XFF + 追加 socket IP（官方原文："appends the client socket IP to it"） | 裸读 XFF 第一个值；源站公网裸奔 | 源站锁死：Private Link 或校验 `X-Azure-FDID` + `AzureFrontDoor.Backend` IP ACL；应用中间件按跳数配 ForwardLimit | `X-Azure-SocketIP`（TCP 对端，用户不可篡改）、`X-Azure-ClientIP` |
| **Application Gateway v2** | 插入 XFF = 已有值 + `client_ip:port`（append 且**带端口**） | 默认 append + 后端裸读 First | **Rewrite Set：`X-Forwarded-For = {var_client_ip}`（净化为单值，推荐）**；或 `{var_add_x_forwarded_for_proxy}`（append 去端口）；`{http_req_X-Forwarded-For}`（透传，官方场景：防止追加 FD 的 IP）；后端 NSG 只放行 AppGW 子网 | 无 |
| **App Service** | 平台 FE **append**（固化） | 裸读 First；不开访问限制（默认公网可达 = 可绕过直连） | ForwardedHeaders 中间件（KnownNetworks=FE 网段，ForwardLimit=跳数）+ **访问限制**（IP/服务标签/私有终结点）封锁直连 | Linux 下 `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`（官方警告：不设 KnownProxies，防伪造靠网络层） |
| **API Management** | 由 policy 决定 | 不设头 → 后端 TCP 只见 APIM | `<set-header name="X-Forwarded-For">@(context.Request.IpAddress)</set-header>` 覆盖净化 ✅ | `context.Request.IpAddress` |
| **Container Apps** | 内置托管 Envoy ingress，append 家族（固化） | 默认 + 裸读 | ingress 设 `internal` 锁直连 + `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` | — |

### 2.3 AWS

| 服务 | 默认 XFF 行为 | ❌ 不安全配置 | ✅ 安全配置 | 可信替代通道 |
|---|---|---|---|---|
| **ALB** | `routing.http.xff_header_processing.mode = append`（默认，官方警告：XFF entries "can only be considered trustworthy if added by properly secured systems"） | append + 裸读 First；preserve（透传） | **ALB 无原生 overwrite 模式！** 正确姿势：目标安全组只允许 ALB 安全组（锁直连）+ 应用从右解析（单跳时最右 = 真实客户端）；或 mode=remove + 前置 CDN；或前后加自建 nginx 净化 | 可选 `xff_client_port` 带端口 |
| **NLB** | **L4，不碰 XFF**（伪造值原样穿过） | **NLB 后面读 XFF = 100% 伪造**，架构性错误 | 直接用 TCP 层 `RemoteIpAddress`（NLB 默认保留客户端真实 IP）或启用 **PROXY protocol v2** | TCP 层本身 |
| **CloudFront** | **append** viewer IP（保留客户端 XFF）；同时**删除客户端的 `X-Real-IP`** | 默认 + 裸读 First；源站公网可达 | **CloudFront Function 边缘重写 XFF（净化）✅**；源站用官方托管前缀列表 `origin-facing` + 自定义秘密头锁直连 | `CloudFront-Viewer-Address` |
| **API Gateway** | append 链 | 后端解析 XFF | 后端读 `$context.identity.sourceIp`（TCP 层可信）✅ | `identity.sourceIp` |

### 2.4 GCP

| 服务 | 默认 XFF 行为 | ❌ 不安全配置 | ✅ 安全配置 | 可信替代通道 |
|---|---|---|---|---|
| **外部 HTTPS LB**（全球/经典/区域） | **append 两个值**：`[客户端XFF...], client-ip, lb-ip` —— **真实客户端是倒数第二个**；官方明示 "does not verify any IP addresses that precede" | 裸读 First（伪造）或裸读 Last（拿到 LB 的 IP） | **后端服务自定义头净化 ✅**：`--custom-request-header=x-forwarded-for:{client_ip_address},{server_ip_address}`（官方方案，代价：原始链不可恢复）；防火墙只放行 GFE/健康检查网段（`130.211.0.0/22`、`35.191.0.0/16`，区域型为 proxy-only 子网） | 无 |
| **Cloud CDN** 前置 | 链上再 append 一跳 | 同上 | 同上，跳数 +1 | — |
| **Cloud Run** | 平台前端 append | 默认 ingress=all（公网可直连） | ingress = `internal-and-cloud-load-balancing`（只许 LB 流量）+ 应用中间件 | — |

### 2.5 组合判定总表

> 前提：攻击流量带伪造 `X-Forwarded-For: 6.6.6.6`。"裸读First" = 被测漏洞代码写法。

| # | 边缘/代理配置 | 应用代码方式 | 直连封锁 | 代码拿到的 IP | 判定 |
|---|---|---|---|---|---|
| 1 | 任意 append 单层 | 裸读 **First** | 是 | **6.6.6.6 伪造值** | ❌ |
| 2 | 任意 append 单层 | 裸读 **Last** | 是 | 真实客户端（单跳碰巧对） | ⚠️ 多跳/GCP 下拿到代理 IP 失真 |
| 3 | 边缘 **overwrite 净化** + 内层 append | 裸读 First | 是 | **真实客户端** | ✅ |
| 4 | 边缘 overwrite 净化 | 裸读 First | **否** | 绕过直连 → 伪造值 | ❌ |
| 5 | 透传（nginx 不写 / ALB preserve / 无净化前置） | 任意 | 任意 | **伪造值** | ❌ |
| 6 | 删除（nginx `""` / ALB remove） | 回退 RemoteIpAddress | 是 | 代理 IP（失真但不可伪造） | ⚠️ |
| 7 | append + **中间件正确**（KnownNets + Limit=跳数） | 只读 RemoteIpAddress | 是 | **真实客户端** | ✅ 推荐 |
| 8 | append + 中间件正确 | **旧代码裸读 First** | 是 | **仍是伪造值**（伪造值残留在 header，代码优先读 header） | ❌ 实测 |
| 9 | append + 中间件正确 | 只读 RemoteIpAddress | **否** | **伪造值**（攻击者直连且其 IP 在 KnownNetworks 内 → 中间件信任并采用伪造值） | ❌ 实测 |
| 10 | 双链 append→append + 中间件 **Limit=1** | 只读 RemoteIpAddress | 是 | 中间代理 IP（失真，fail-closed） | ⚠️ |
| 11 | NLB / L4 透传 | 读 XFF | — | 伪造值 | ❌ 架构错误 |
| 12 | NLB / L4 透传 | 读 RemoteIpAddress（TCP 层） | — | **真实客户端** | ✅ |
| 13 | FD/AppSvc/CloudFront 等固化 append 托管层 | 读官方替代头（`X-Azure-SocketIP` / `sourceIp`） | 源站已锁 | **真实客户端** | ✅ |

**XFF 可信的充要条件（三条缺一不可）**：

1. 后端直连被网络层封锁（NSG / 安全组 / 防火墙只放行代理 IP 段）
2. 边缘净化 **或** 应用按"从右跳过已知代理"解析（中间件 + 跳数配对）
3. 代码只读 `RemoteIpAddress` / 云官方可信头，不裸读 XFF 原文

---

## 三、代码完整指南：真实 IP vs 篡改值

### 3.1 各云/拓扑下真实客户端 IP 在 XFF 中的位置（从右数）

| 拓扑 | 后端收到的 XFF 形态 | 真实客户端位置 | ForwardLimit 应配 |
|---|---|---|---|
| 单层 append（nginx/ALB/AppGW/Apache/HAProxy） | `[伪造...], 客户端` | **倒数第 1** | 1 |
| GCP HTTPS LB | `[伪造...], 客户端, LB-IP` | **倒数第 2** | 2 |
| CloudFront → ALB | `[伪造...], 客户端, CF边缘IP` | 倒数第 2 | 2 |
| Front Door → App Service | `[伪造...], 客户端, FD-IP` | 倒数第 2 | 2 |
| Front Door → AppGW → 应用 | `[伪造...], 客户端, FD-IP` | 倒数第 2 | 2 |
| Front Door → AppGW → ingress-nginx(append) | `[伪造...], 客户端, FD-IP, AppGW-IP` | 倒数第 3 | 3 |
| 边缘 overwrite 净化 | `客户端`（单值） | 唯一值 | 1（或不需中间件） |

> 规律：**每个 append 型反代把"它看到的对端 IP"追加到最右**。从右往左跳过你拥有的代理个数，落点就是真实客户端。

### 3.2 ❌ 错误写法（全部有实测背书）

```csharp
// 错误1：取第一个值 = 攻击者声称的值（被测漏洞代码的写法）
ip = Request.Headers["X-Forwarded-For"].ToString().Split(',').First();
// → append/透传/Azure/AWS/GCP 默认配置下必为伪造值（实验端口 8091/8093/8110 实测）

// 错误2：取最后一个值
ip = xff.Split(',').Last();
// → 多跳链路拿到自己代理的 IP；GCP 拿到 LB 的 IP；所有客户端日志长成同一个代理 IP

// 错误3：裸信 X-Real-IP
ip = Request.Headers["X-Real-Ip"];
// → 代理不覆盖时 = 透传伪造值；CloudFront 默认还会删掉它

// 错误4：优先级倒挂 —— 先读可伪造的 header，为空才读 TCP 层 RemoteIpAddress
// 错误5：字符串截断 ip.Substring(0, ip.IndexOf(":"))
// → IPv6 "2001:db8::1234" 被截成 "2001"（实测），审计错乱，且可能绕过 IP 前缀审计规则
// 错误6：读 "REMOTE_ADDR" 头 = 死代码（CGI 变量不是 HTTP 头；nginx 默认丢弃下划线头）
```

### 3.3 ✅ 写法 A（首选）：ForwardedHeadersMiddleware + 只读 RemoteIpAddress

```csharp
// Program.cs（必须放管道最前）
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.KnownProxies.Clear(); o.KnownNetworks.Clear();          // 默认只信 loopback，必须重建
    foreach (var cidr in builder.Configuration.GetSection("TrustedProxyCidrs").Get<string[]>() ?? [])
        o.KnownNetworks.Add(IPNetwork.Parse(cidr));           // 只填真实拥有的代理网段
    o.ForwardLimit = builder.Configuration.GetValue<int>("ProxyHopCount", 1); // 查 3.1 表
});
app.UseForwardedHeaders();

// 业务代码收敛为一行：
private string GetClientIP(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString() ?? "";
```

**原理解释**：中间件从右往左跳过 KnownProxies/KnownNetworks 中的可信代理，把"第一个不可信 IP"写进 `RemoteIpAddress`，被消费的值移入 `X-Original-For`。这回答了一个常见疑问——"`RemoteIpAddress` 不是会拿到反代的 IP 吗？"：裸用时确实是（TCP 对端 = 代理），但中间件处理后它就是真实客户端 IP（实测：TCP 对端是中间代理容器，RemoteIpAddress 返回真实客户端）。**XFF 仍是信息载体，但解析必须交给中间件，业务代码一个 header 都不碰。**

- 拿到真实 IP：直连已封锁 + 跳数配对（组合表 #7）
- 拿到篡改值：① 直连未封锁（#9）；② 旧代码逻辑仍在、先读 header（#8——中间件配对后伪造值仍残留在 header 中，实测）

### 3.4 ✅ 写法 B（无法引入中间件时）：手写从右解析

```csharp
string GetClientIpSafe(HttpRequest req, IConfiguration cfg)
{
    var hopCount = cfg.GetValue<int>("ProxyHopCount", 1);   // 按 3.1 表配置
    var xff = req.Headers["X-Forwarded-For"].ToString();
    var entries = xff.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    var idx = entries.Length - hopCount;                     // 从右数第 hopCount 个
    if (idx >= 0 && IPAddress.TryParse(entries[idx], out var ip))
        return ip.ToString();                                // 严格格式校验，防注入防截断 bug
    return req.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "";  // 失败回退 TCP 层
}
```

### 3.5 ✅ 写法 C（边缘已确认净化）：读单值 + 防退化

```csharp
// 前提：黑盒探测已验证边缘为 overwrite，且直连已封锁
var xff = Request.Headers["X-Forwarded-For"].ToString();
if (xff.Contains(','))                    // 净化链路不应出现多值；出现 = 链路变了，拒绝信任
    return Connection.RemoteIpAddress?.ToString() ?? "";
return IPAddress.TryParse(xff.Trim(), out var ip) ? ip.ToString() : Connection.RemoteIpAddress?.ToString() ?? "";
```

### 3.6 ✅ 写法 D（云托管层可信替代头）

```csharp
// Azure Front Door 直连后端：SocketIP 是 TCP 层值，客户端不可篡改（配合 X-Azure-FDID + IP ACL 锁源站）
var ip = Request.Headers["X-Azure-SocketIP"].FirstOrDefault();
// AWS API Gateway：$context.identity.sourceIp
// GCP / Azure AppGW：无替代头，靠边缘净化或中间件
```

### 3.7 判定口诀

> **左数第一个是攻击者的，右数第 N 个（N = 你的可信代理跳数）才是客户端的；TCP 层永远只说最后一跳。** 代码只读 `RemoteIpAddress`（经中间件）或云官方可信头；解析交给中间件；边缘能净化就净化；后端永远锁直连。

---

## 四、实测数据（证据附录）

攻击流量统一为 `X-Forwarded-For: 6.6.6.6`；`172.18.0.1` = 真实客户端 IP；打的是被测漏洞代码（裸读 XFF 取第一个值）的原样复刻。

| 场景 | 后端收到的 XFF | GetClientIP 结果 | RemoteIpAddress |
|---|---|---|---|
| 直连后端 | `6.6.6.6` | **6.6.6.6（伪造成功）** | 真实客户端 |
| 追加 | `6.6.6.6, 172.18.0.1` | **6.6.6.6（伪造成功）** | 代理 IP |
| 覆盖 | `172.18.0.1` | 172.18.0.1（真实） | 代理 IP |
| 透传 | `6.6.6.6` | **6.6.6.6（伪造成功）** | 代理 IP |
| 删除 | （无） | 代理 IP（失真） | 代理 IP |
| X-Real-IP 模式 | `6.6.6.6`（透传） | **6.6.6.6（伪造成功）** | 代理 IP |
| 追加 + 中间件正确 | `6.6.6.6`（伪造值残留） | **6.6.6.6（仍伪造成功）** | **172.18.0.1（真实）** |
| 追加→追加（双链） | `6.6.6.6, 172.18.0.1, midIP` | **6.6.6.6（伪造成功）** | 代理 IP |
| 覆盖→追加（边缘净化） | `172.18.0.1, edgeIP` | 172.18.0.1（真实） | 代理 IP |
| 追加→覆盖（净化太晚） | `172.18.0.25`（边缘代理IP） | 边缘代理 IP（真实IP丢失） | 代理 IP |
| 双链 + Limit=1 | `6.6.6.6, 172.18.0.1` | 6.6.6.6 | 中间代理 IP（失真） |
| 双链 + Limit=2 | `6.6.6.6`（伪造值残留） | **6.6.6.6（仍伪造成功）** | **172.18.0.1（真实）** |
| 覆盖→追加 + Limit=2 | （无） | 172.18.0.1（真实） | 172.18.0.1（真实） |
| **直连配置了正确中间件的后端** | （无） | — | **6.6.6.6（伪造成功）** |

三个关键实测结论：

1. **追加 ≠ 净化**：`$proxy_add_x_forwarded_for` 保留客户端带来的 XFF 再追加真实对端，伪造值原样混在 header 中到达后端。
2. **中间件配对也救不了裸读代码**：Limit=2 配对后 `RemoteIpAddress` 已是真实 IP，但旧代码优先读 header 第一个值，仍返回伪造值——**修复必须改代码**。
3. **直连不封锁一切白搭**：攻击者绕过代理直连时，即使中间件配置完全正确，`RemoteIpAddress` 本身也会变成伪造值（攻击者连接来自"可信网段"内）。

---

## 五、针对公司代码片段的缺陷分析

被测代码（已原样复刻进实验环境 `/vuln` 端点）：

```csharp
private string GetClientIP(HttpContext context)
{
    string ip = string.Empty;//GetHeaderValueAs(context, "X-Real-Ip");
    if (string.IsNullOrWhiteSpace(ip))
        ip = GetHeaderValueAs(context, "X-Forwarded-For")?.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
    if (string.IsNullOrWhiteSpace(ip) && context.Connection?.RemoteIpAddress != null)
        ip = context.Connection.RemoteIpAddress.ToString();
    if (string.IsNullOrWhiteSpace(ip))
        ip = GetHeaderValueAs(context, "REMOTE_ADDR");
    if (!string.IsNullOrWhiteSpace(ip) && ip.IndexOf(":") > 0)
        ip = ip.Substring(0, ip.IndexOf(":"));
    return ip?.Trim();
}
```

| # | 缺陷 | 实测/说明 |
|---|---|---|
| 1 | `Split(',').FirstOrDefault()` 取**最左**值 | XFF 语义 `客户端声称, 代理1, 代理2`，最左 = 攻击者完全可控。追加/透传/三云默认配置下全部伪造成功 |
| 2 | 回退优先级倒挂 | 可伪造的 header 排在 TCP 层 `RemoteIpAddress` 之前，顺序应相反 |
| 3 | `IndexOf(":") > 0` 字符串截断 | IPv6 客户端 `2001:db8::1234` 被截成 `2001`（实测复现），审计日志错乱；本意去端口，应用 `IPAddress.TryParse` |
| 4 | `Headers["REMOTE_ADDR"]` | CGI 变量不是 HTTP 头；nginx 默认丢弃下划线头（实测未到达）→ 死代码，且若框架映射成可读 header 反而多一条伪造路径 |
| 5 | `X-Real-Ip` 被注释 | 若统一配置恰好是 X-Real-IP 覆盖模式，代码反而读不到可信值（实测：可信值在 `xRealIp` 字段里，代码却走了可伪造的 XFF） |

---

## 六、黑盒探测法（配置不可见时的验证手段）

统一配置不可见时，让配置"自证"（在授权的测试环境执行）：

1. **标记探测**：发 `curl -H "X-Forwarded-For: 6.6.6.6" https://测试环境/`，应用入口临时打印完整 XFF：
   - 收到 `6.6.6.6, 真实IP` → **追加** → 漏洞成立
   - 收到 `6.6.6.6` 原样 → **透传** → 漏洞成立
   - 只收到真实 IP（单值）→ **边缘覆盖** → 配置可信，进入第 3 步
   - 收不到 XFF → **删除** → 不可伪造但审计失真
2. **正常用户对照**：不带 XFF 发一次，确认真实 IP 出现在链中哪个位置（验证真实 IP 传递）。
3. **直连测试**：从内网/VNet 内绕过代理直接请求后端端口并带伪造 XFF——能通则无论配置如何都不可信，必须 NSG/安全组只放行代理 IP 段。
4. **直接向运维索取一行配置**：nginx 的 `proxy_set_header X-Forwarded-For` / AppGW 的 Rewrite Set / ingress 的 ConfigMap 中 XFF 相关条目，一行即可对上本文组合矩阵中的某一行得出结论。

---

## 参考来源

- Microsoft Learn：Configure ASP.NET Core to work with proxy servers and load balancers（中间件默认值、ANCM 行为、`ASPNETCORE_FORWARDEDHEADERS_ENABLED` 警告）
- Microsoft Learn：Protocol support for HTTP headers in Azure Front Door（append 行为、X-Azure-SocketIP/FDID）
- Microsoft Learn：Rewrite HTTP headers and URL with Azure Application Gateway（rewrite set 四种 XFF 模式、`{var_client_ip}` 净化）
- AWS Docs：HTTP headers and Application Load Balancers（append/preserve/remove 三模式）
- AWS Docs：CloudFront Request and response behavior for custom origins（append viewer IP、删除 X-Real-IP）
- Google Cloud Docs：External Application Load Balancer overview（append 两个值、"does not verify" 警告、custom-request-header 净化方案）
- 本地实验环境实测数据（本报告第四节）
