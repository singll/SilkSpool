# SilkSpool 项目进度

> 最后更新: 2026-05-26
>
> 本文档是跨仓库的全局进度视图（SilkSpool IaC + Bellkeeper 应用 + n8n 工作流）。
>
> 演进规划见 [ROADMAP.md](ROADMAP.md)。

---

## 当前架构口径（2026-05）

```
                        Matrix（控制平面）
                              │
            ┌─────────────────┼────────────────┐
            ▼                 ▼                ▼
       Bellkeeper      n8n（编排层）        TrueNAS
       Matrix Gateway  K* / M* / O*        data/knowledge/
       LLM Proxy                            ├ raw/
       Meilisearch                          ├ working/
       CrawlQueue                           ├ KNOWLEDGE/
                                            └ notes-assets/
                                                  ▲
                                                  │ LiveSync
                                              CouchDB
                                                  ▲
                                                  │
                                       Obsidian Vault（PKB 真相源）
```

**核心定位**:
- **Markdown / Obsidian Vault** 是知识真相源（PKB 层）
- **TrueNAS** 是文件存储平面（raw / working / pkb-assets）
- **Bellkeeper** 是治理中台（爬取队列、入库、分类、检索、LLM 代理、Matrix Gateway）
- **n8n** 仅承担定时编排与跨服务粘合（B/K/M/O 四类工作流）
- **Matrix** 是控制平面（命令路由 + 通知）
- **RAGFlow 已退役**：服务不再部署，代码兼容层待清理

---

## 模块成熟度

| 模块 | 状态 | 说明 |
|------|------|------|
| 基础设施 | ✅ 稳定 | 6 台主机、反代、Headscale VPN、IaC、Authelia |
| Bellkeeper 后端 | ✅ 稳定 | 知识入库 + LLM Proxy + Matrix Gateway + CrawlQueue + LogCenter |
| Bellkeeper 前端 | ✅ 稳定 | 四大核心域（Knowledge / LLM / Logs / Matrix），SolidJS |
| LLM 代理 | ✅ 稳定 | DB 动态配置 + 3 模型组 + 熔断 + 粘性 + OpenAI/Anthropic 双协议 |
| n8n 工作流 | ✅ 稳定 | 20 个工作流（B/K/M/O），重逻辑下沉到 Bellkeeper |
| RSS + 入库 | ✅ 稳定 | K02 (RSS) → K01 (入库) → Bellkeeper CrawlQueue → 文件落盘 |
| Meilisearch 检索 | ✅ 稳定 | `/api/files/search\|ask`，文件级派生索引 |
| Matrix 控制平面 | ✅ 稳定 | Bellkeeper Gateway 取代 n8n 轮询；`!问/!搜/!待办/!帮助` 可用 |
| 通知网关 | ✅ 稳定 | B01 → Bellkeeper `/api/matrix/notify` → NATS → worker → Matrix |
| 知识问答 | ✅ 稳定 | M03 走 Bellkeeper `/api/files/ask`，LLM 走 `pool-chat-balanced` |
| Obsidian 知识库（MVP）| ✅ 已上线 | 单 Vault → CouchDB LiveSync 同步；TrueNAS 文件可选回流 |
| 日报与运维 | ✅ 稳定 | O01 健康监控 + O02 每日摘要 + O03/04/05 磁盘/容器/备份 |
| TrueNAS 存储 | 🔶 进行中 | dataset 已规划；部分应用仍挂旧路径，迁移未全部完成 |
| K07 Obsidian 回流 | ⏸ 暂停 | 工作流存在但 `active: false`，可选适配器 |
| RAGFlow 兼容代码 | ⚠️ 待清理 | 服务已停，handler 路由仍注册，约 9 个 Go 文件待删 |

---

## 最近主线动作（2026-04 至 2026-05）

| 时间 | 动作 |
|------|------|
| 2026-05-26 | 文档大扫除：删除 RAGFlow 历史规划/审查文档，新增 ROADMAP.md |
| 2026-05-02 | K02 移除 RAGFlow 解析死代码（commit `19343cd`） |
| 2026-04-29 | Bellkeeper 前端四大核心域全面重构（commit `341cf44`） |
| 2026-04-下 | LLM Proxy 增加 Anthropic 协议 + 流式（commit `34ca7b4`） |
| 2026-04-下 | 爬取队列系统（CrawlQueue）上线（commit `f8f27e4`） |
| 2026-04-中 | 知识库切换到 Meilisearch（commit `4994d99` `db9a148`） |
| 2026-04-中 | 前端日志组件从 LogCenter 拆分到 `/logs/*` 子域 |
| 2026-04-初 | Bellkeeper Matrix Gateway 完整上线（替代 n8n 轮询） |
| 2026-04-初 | RAGFlow 服务从 keeper bundle 移除 |

---

## 已知问题与待办

详细的优化方向、问题清单、改造计划写在 [ROADMAP.md](ROADMAP.md)。本节只列摘要：

| 类型 | 摘要 | 详情 |
|------|------|------|
| 技术债 | Bellkeeper 仍有 ~9 个 RAGFlow 兼容文件，handler 路由仍注册 | ROADMAP §代码清理 |
| 技术债 | bundles/knowledge/（旧 RAGFlow bundle）仍在仓库 | ROADMAP §代码清理 |
| 优化 | LLM Proxy 缺少日志归档、token 计费聚合、配额报警 | ROADMAP §LLM Proxy |
| 优化 | n8n 工作流之间存在间接调用层（K02 → K01 webhook） | ROADMAP §n8n |
| 优化 | 日志系统缺少全文检索、聚合仪表盘、告警规则 | ROADMAP §日志 |
| 优化 | Bellkeeper 前端缺少 Vault 内文件编辑、爬取队列可视化 | ROADMAP §前端 |
| 功能 | K07 Obsidian 回流链路未端到端验证 | ROADMAP §知识库 |
| 功能 | RAG 问答 Rerank、引用展示、上下文压缩待优化 | ROADMAP §知识问答 |

---

## 文档导航

- [doc/README.md](README.md) — 文档总览
- [doc/ROADMAP.md](ROADMAP.md) — 演进规划（当前优化方向）
- [architecture/overview.md](architecture/overview.md) — 架构总览
- [architecture/infrastructure.md](architecture/infrastructure.md) — 基础设施与运维红线
- [modules/automation/README.md](modules/automation/README.md) — n8n 工作流与编排
- [modules/knowledge/README.md](modules/knowledge/README.md) — 知识工作层与检索
- [modules/matrix/README.md](modules/matrix/README.md) — Matrix 控制平面
- [modules/notes/README.md](modules/notes/README.md) — Obsidian 主库
- [modules/storage/README.md](modules/storage/README.md) — TrueNAS 存储
- [modules/rss/README.md](modules/rss/README.md) — RSS 来源
- Bellkeeper 文档：`../Bellkeeper/doc/`（README.md、ARCHITECTURE.md、API.md、LLM_PROXY_GUIDE.md、documents/、matrix/）

---

## 核心设计决策

| 选择 | 原因 |
|------|------|
| Markdown / Obsidian Vault 为知识真相源 | 数据主权、纯文本、长寿、可手工整理 |
| Meilisearch 替代 RAGFlow 作为检索 | 轻量、易部署、文件级派生、不需要重型向量库 |
| Matrix + Conduit | 自托管、数据主权、跨设备 |
| Bellkeeper 承担 Matrix Gateway | 集中处理长连接 sync、命令路由、权限、通知 |
| n8n 仅做编排 | 重逻辑下沉到 Bellkeeper，n8n 专注调度与可视化粘合 |
| SilkSpool | 面向 Docker Compose 的轻量 IaC，无 K8s/Ansible 复杂度 |
| LLM Proxy 三模型组 | 免费 / 平衡 / 总结，跨渠道熔断与粘性兜底 |
| 三层知识模型 (Raw/Working/PKB) | 采集 → 加工 → 沉淀，逐层有边界 |
