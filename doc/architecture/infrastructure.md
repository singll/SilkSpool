# 基础设施

> 本文档描述 SilkSpool 的服务器拓扑、网络、IaC 工具和运维边界。
> **设计原则**：稳定优先、少硬编码、服务可迁移、扩容不改基座。

---

## 架构概览

```text
Internet
  ↓
txhk（公网 / VPN / Matrix）
  ↓ Headscale VPN
istoreos（网关 / 反代）
  ↓ LAN
knowledge（检索 / 工作层） · keeper（应用 / 工作流） · aigateway（AI 网关）
```

核心服务通过 `silkspool` Docker 网络协同，入口统一由 Caddy 管理。

---

## 主机清单

| 主机 | IP | 角色 | 规格 | 容器数 |
|------|-----|------|------|--------|
| **istoreos** | 192.168.7.1 | 网关 / DNS / 反代 | 软路由 | 3 |
| **knowledge** | 192.168.7.220 | 检索 / 工作层 | 8C / 24G | 9 |
| **keeper** | 192.168.7.230 | 应用 / 工作流 / Matrix Bot Platform 控制中心 | 4C / 8G | 7 |
| **aigateway** | 192.168.7.110 | AI 网关 | 2C / 4G | 3 |
| **bili-node** | 192.168.7.108 | B 站录制 | 2C / 4G | 3 |
| **txhk** | 43.129.195.4 | 公网 / VPN / Matrix | 2C / 2G | 4 |

### knowledge — 检索 / 工作层

| 服务 | 容器名 | 端口 | 资源 |
|------|--------|------|------|
| RAGFlow | sp-ragflow | 8080 | 2-3GB |
| Elasticsearch | sp-ragflow-es | 9200 | 4-6GB |
| MySQL | sp-mysql | 3306 | 1GB |
| MinIO | sp-minio | 9000 / 9001 | 0.5GB |
| Redis | sp-redis | 6379 | 0.5GB |
| Firecrawl API | sp-firecrawl-api | 3002 | — |
| Firecrawl Playwright | sp-firecrawl-playwright | — | 3-5GB |
| Firecrawl PostgreSQL | sp-firecrawl-db | 5432 | — |
| Firecrawl RabbitMQ | sp-firecrawl-rabbitmq | 5672 | — |

### keeper — 应用 / 工作流

| 服务 | 容器名 | 端口 |
|------|--------|------|
| n8n | sp-n8n | 5678 |
| Bellkeeper | sp-bellkeeper | 8090 |
| Bellkeeper DB | sp-bellkeeper-db | 5432 |
| Memos | sp-memos | 5230 |
| RSSHub | sp-rsshub | 1200 |
| CouchDB | sp-couchdb | 5984 |
| Redis | sp-redis | 6379 |

### aigateway — AI 网关

| 服务 | 容器名 | 端口 |
|------|--------|------|
| new-api | sp-new-api | 3003 |
| PostgreSQL | sp-new-api-db | 5432 |
| Redis | sp-redis | 6379 |

---

## 网络

### 域名映射

所有核心服务通过 Caddy 提供统一的 `*.singll.net` 入口。

| 域名 | 后端 |
|------|------|
| ragflow.singll.net | knowledge:8080 |
| n8n.singll.net | keeper:5678 |
| bellkeeper.singll.net | keeper:8090 |
| memos.singll.net | keeper:5230 |
| minio.singll.net | knowledge:9001 |
| newapi.singll.net | aigateway:3003 |
| matrix.singll.net | txhk:8008 |

### VPN（Headscale）

- 网段：`100.64.0.0/10`
- 角色：txhk 作为控制器
- 用途：跨网统一管理各主机

当 VPN 不可用时，使用 [offline-fallback.md](offline-fallback.md) 中的应急访问策略。

---

## SilkSpool IaC

### 目录结构

```text
SilkSpool/
├── spool.sh
├── config.ini            # gitignore
├── bundles/              # 提交到 git 的模板
├── hosts/                # gitignore，主机实例配置
└── keys/                 # gitignore，SSH 密钥
```

### 核心命令

```bash
./spool.sh sync push <host>
./spool.sh restart <host> <service>
./spool.sh status <host>
./spool.sh logs <host> <service>
./spool.sh exec <host> "command"
./spool.sh backup <host>
./spool.sh n8n-sync push-import
```

### 部署原则

- 模板使用 `${VAR}` 占位符，实际值由 `hosts/<host>/.env` 提供
- 新增服务优先通过 bundle 模板扩展，而不是修改主逻辑
- 服务迁移优先调整 `.env` 与模板，不在工作流中硬编码地址

---

## 容器编排

### 命名规范

- 容器：`sp-<service>`
- 卷：`kb-<service>-data`
- 网络：`silkspool`

### 环境变量更新

| 场景 | 操作 |
|------|------|
| n8n | `./spool.sh restart keeper sp-n8n` |
| Bellkeeper | `./spool.sh restart keeper sp-bellkeeper` |
| 其他服务 | `up -d <service>` |
| 挂载配置文件 | `./spool.sh restart <host> <service>` |

---

## 容错与可靠性

### 已实现能力

| 措施 | 状态 |
|------|------|
| `restart: unless-stopped` | ✅ |
| n8n `N8N_ENCRYPTION_KEY` 持久化 | ✅ |
| NFS 挂载（knowledge → NAS） | ✅ |
| Git 管理模板与配置 | ✅ |
| O03 磁盘空间告警 | ✅ |
| O04 容器健康检查 | ✅ |
| O05 自动备份 | ✅ |
| 离线托底 | ✅ 本地网络直连可用 |

### 运维工作流

| 工作流 | 功能 | 频率 |
|--------|------|------|
| O01-服务健康监控 | HTTP 端点检查与状态通知 | 每 5 分钟 |
| O02-每日摘要 | 系统运行摘要 | 每日 |
| O03-磁盘空间告警 | 磁盘使用率 >80% 告警 | 每 6 小时 |
| O04-容器健康检查 | 异常容器检测与自动重启 | 每 5 分钟 |
| O05-自动备份 | 备份与旧备份清理 | 每日凌晨 2 点 |

### 故障恢复策略

```text
容器异常      → 自动重启
配置错误      → git revert + spool sync push
数据损坏      → spool backup restore
主机宕机      → PVE onboot 自动拉起
VPN 中断      → 本地网络直连托底
```

---

## 运维红线

1. 禁止直接 SSH 手工操作，优先使用 `spool.sh`
2. 禁止 `git add -f`
3. 禁止 `docker compose down`
4. 有状态容器重建需审批
5. n8n 数据不可丢失

---

## 参考

- [offline-fallback.md](offline-fallback.md) — 离线托底与应急访问
- [../old/guides/PVE_CREATE_LXC_GUIDE.md](../old/guides/PVE_CREATE_LXC_GUIDE.md) — LXC 创建参考
- [../README.md](../README.md) — 文档总入口
