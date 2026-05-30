# 自动化与应用

> 本文档描述 SilkSpool 的编排层与交互层实现。
> **定位**：n8n 是**协调与调用中心**，仅负责粘合各子系统，不承担重的业务逻辑。

---

## 核心原则：n8n 作为协调层

n8n 工作流的**设计原则**：

1. **只调用，不决策**：调用 Bellkeeper 等子系统的 API，由子系统内部做业务决策
2. **只编排，不处理**：编排流程调用，不做 XML 解析、URL 验证、HTML 格式化等重逻辑
3. **只转发，不存储**：转发请求和响应，不在 n8n 中存储业务状态
4. **只通知，不生成**：通知消息由子系统生成，n8n 仅负责调用发送接口

**禁止在 n8n 中实现**：
- XML/JSON 解析（交给子系统处理）
- URL 验证和去重逻辑
- HTML 富文本生成
- 业务状态判断和路由
- 复杂的数据转换

**正确做法**：
```
n8n → POST /api/xxx/submit → Bellkeeper → 决策 → 返回结果 → n8n → 通知
```

---

## 角色定位

在新的总架构中：

- 核心知识系统先独立成立（写入、查看、整理、沉淀）
- n8n 工作流负责把采集、AI、通知、检索、机器人交互等能力接到核心系统外侧
- 因此这里描述的是**外挂层 / 协调层**，不是知识系统真相源

与三层知识模型的对应关系：

- **K01 / K02 / K03**：主要属于 **Layer 1 → Layer 2** 的入口流程，其中主链已转向”文件优先落地”
- **K05 / K08**：主要属于 **Layer 2** 的 AI 加工与日报能力
- **K07**：属于 **Layer 3 / PKB → 检索增强** 的可选适配器，而不是默认主链路

---

### Matrix 机器人与平台边界

Matrix 机器人基础设施的**正式实施主体已转移到 Bellkeeper**。

当前长期目标口径：

- Matrix homeserver / 公网入口：`txhk`
- Matrix Bot Platform 控制中心：`keeper`
- Bellkeeper：承载 Matrix bot runtime、通知网关、命令路由、治理与管理 API
- n8n：仅作为被调用的工作流后端，不再轮询 Matrix Sync API

### 迁移进度（2026-04-10）

Bellkeeper Matrix 平台已完成：

- ✅ Gateway + Sync 循环（mautrix）
- ✅ Command Router + 权限引擎（owner/admin/member/guest）
- ✅ 通知网关（NATS 队列 + 频道路由 + 限速）
- ✅ Admin API（房间/频道/命令/角色/日志/统计）
- ✅ 前端管理页面（16 页）
- ✅ 种子数据 JSONB 修复
- ✅ Admin 管理命令（!health, !rooms, !commands）
- ✅ **B01 通知发送器** — 已改为调用 Bellkeeper `/api/matrix/notify`
- ✅ **M01 Matrix 机器人** — 已移除轮询，由 Bellkeeper Gateway 统一处理
- ✅ **M02 简化** — 移除 modify 操作，命令由 Bellkeeper DirectMemosHandler 接管

**待完成**：
- 🔶 DirectMemosHandler 部分命令仍是 stub（完成/删除待补全）
- 🔶 K02 RSS 采集 — XML 解析待迁移到 Bellkeeper

### n8n 工作流职责重构

**目标架构**：n8n 仅作为协调层，重的逻辑下沉到子系统

| 当前状态 | 目标状态 |
|---------|---------|
| M01 每 10 秒轮询 Matrix Sync API | Bellkeeper Gateway 统一处理 |
| M01 包含指令解析 (80+ 行 JS) | Bellkeeper Command Router 处理 |
| M01 包含 HTML 格式化 (200+ 行 JS) | Bellkeeper 返回已格式化消息 |
| B01 调用 n8n webhook | 调用 `/api/matrix/notify` |
| K02 包含 XML 解析 | Bellkeeper RSS 采集服务处理 |

详见 [../matrix/README.md](../matrix/README.md) 和 Bellkeeper `doc/NEXT-PHASE-PLAN.md`。

---

## n8n 工作流

**部署主机**: keeper  
**管理命令**: `./spool.sh n8n-sync push-import`

### 序号体系

| 前缀 | 含义 | 说明 |
|------|------|------|
| B | 基础设施 | 通知、日志等被广泛依赖的底层服务 |
| K | 知识管道 | 采集、入库、解析、总结 |
| M | 机器人/交互 | Matrix 指令、UI 联动 |
| O | 运维 | 监控、备份、清理 |

子工作流使用 `.1` 后缀，例如 `K02.1-rss-parse-trigger`。

### 工作流清单

#### B — 基础设施

| 序号 | 名称 | 文件 | 触发 | 被调用 | 状态 | 说明 |
|------|------|------|------|--------|------|------|
| B01 | 通知发送器 | B01-notify.json | Webhook `/notify` | K02, K08, M01, O01, O02, O03, O04, O05 | ✅ | 已改为调用 Bellkeeper API |

#### K — 知识管道

| 序号 | 名称 | 文件 | 触发 | 被调用 | 状态 | 说明 |
|------|------|------|------|--------|------|------|
| K01 | 文章智能入库 | K01-article-ingest.json | Webhook `/article-ingest` | K02, K03, K04 | ✅ | 验证/格式化下沉到 Bellkeeper |
| K02 | RSS定时采集 | K02-rss-fetch.json | Cron 6/12/18 点 | — | 🔶 | 包含 XML 解析，待迁移 |
| K03 | 手动批量提交 | K03-manual-ingest.json | Webhook `/manual-ingest` | — | ✅ | |
| K04 | 失败重试队列 | K04-error-retry.json | Schedule 30min + Webhook | — | ✅ | |
| K05 | AI智能总结 | K05-ai-summarize.json | Webhook `/ai-summarize` | — | ✅ | |
| K06 | 文档解析兜底 | K06-parse-fallback.json | Webhook | K02 | ✅ | |
| K07 | Obsidian笔记同步 | K07-obsidian-sync.json | Cron 每 15 分钟 | — | ✅ | |
| K08 | 每日资讯摘要推送 | K08-daily-digest.json | Cron 每日 20 点 | — | ✅ | |

#### M — 机器人/交互

**说明**：M01 轮询已由 Bellkeeper Gateway 处理，n8n 仅保留 webhook 接口。

| 序号 | 名称 | 文件 | 触发 | 被调用 | 状态 | 说明 |
|------|------|------|------|--------|------|------|
| M01 | Matrix机器人基础 | M01-matrix-bot-base.json | Webhook `/matrix-command` | — | ✅ | 轮询已移除，Bellkeeper 处理命令路由 |
| M02 | Memos待办管理 | M02-memos-todo.json | Webhook `/memos-todo` | — | ✅ | 已简化（移除 modify），Bellkeeper DirectMemosHandler 处理 |
| M03 | 知识问答处理器 | M03-qa-handler.json | Webhook `/qa-handler` | — | ✅ | Bellkeeper Command Router 转发 |

#### O — 运维

| 序号 | 名称 | 文件 | 触发 | 被调用 | 状态 |
|------|------|------|------|--------|------|
| O01 | 服务健康监控 | O01-health-monitor.json | Cron 每 5 分钟 | — | ✅ |
| O02 | 每日摘要报告 | O02-daily-summary.json | Cron 每日 21 点 | — | ✅ |
| O02.1 | 待办同步 | O02.1-todo-sync.json | Cron 每分钟 | — | ✅ |
| O03 | 磁盘空间告警 | O03-disk-alert.json | Cron 每 6 小时 | — | ✅ |
| O04 | 容器健康检查 | O04-container-health.json | Cron 每 5 分钟 | — | ✅ |
| O05 | 自动备份 | O05-auto-backup.json | Cron 每日凌晨 2 点 | — | ✅ |

---

## 工作流在三层模型中的位置

### Layer 1 / Raw Capture 入口

| 工作流 | 角色 |
|------|------|
| K02-RSS定时采集 | RSS 自动采集器，负责把 RSSHub 输出的候选文章送入文件优先入库链路 |
| K03-手动批量提交 | 手工 URL / 批量导入入口 |
| K01-文章智能入库 | 原始内容校验、去重、提取、分类并落地到 `raw|working` |

### Layer 2 / Working Layer

| 工作流 | 角色 |
|------|------|
| K05-AI智能总结 | AI 摘要与中间加工工具 |
| K06-文档解析兜底 | 工作层解析 / 提取兜底 |
| K08-每日资讯摘要推送 | 日报 / digest 能力 |
| M03-知识问答处理器 | 基于文件索引结果提供搜索与问答 |

### Layer 3 / PKB 适配器

| 工作流 | 角色 |
|------|------|
| K07-Obsidian笔记同步 | 让部分笔记进入检索增强链路的可选桥接器 |

这里的关键口径是：

- **PKB 本身不依赖 K07 才成立**
- K07 的意义是“把已有笔记接入增强层”，不是“定义知识主库”

---

## 调用关系

```text
B01-通知发送器
  ├─ 被 K02 / K08 / M01 / O01 / O02 / O03 / O04 / O05 调用

K01-文章智能入库
  ├─ 被 K02 / K03 / K04 调用
  └─ 负责把 Layer 1 输入落地到 `raw|working` 并提交索引任务

K05-AI智能总结
  ├─ 被 K08 调用
  └─ 提供 Working Layer 的摘要加工能力

K06-文档解析兜底
  ├─ 被 K02 / K01 调用（主提取失败时兜底）

K07-Obsidian笔记同步
  ├─ CouchDB _changes → Bellkeeper /api/ragflow/ingest/obsidian
  └─ 语义上是 PKB → 检索增强的可选桥接

K08-每日资讯摘要推送
  ├─ 调用 Bellkeeper /api/logs 获取当日入库记录
  ├─ 调用 K05 生成摘要
  └─ 调用 B01 推送到 Matrix

M01-Matrix机器人基础
  ├─ 路由到 M02 / M03
  └─ 调用 B01 统一发送回复

O02.1-待办同步
  ├─ Cron 每分钟 → sync-todos.py
  └─ Memos #待办 → TrueNAS `knowledge/todos/todo.txt`
```

---

## 工作流 API

```bash
./spool.sh n8n-sync push-import        # 导入或更新工作流
PUT  /api/v1/workflows/{id}            # 更新已有工作流（不含只读字段）
POST /api/v1/workflows/{id}/activate   # 激活工作流
```

### 扩展新工作流

1. 在 `hosts/keeper/n8n-workflows/` 按编号体系新增 JSON。
2. 运行 `./spool.sh n8n-sync push-import` 导入。
3. 如需更新已有工作流，使用 n8n API 的 PUT 接口。

---

## Matrix 机器人

### 目标架构

```text
Matrix 服务器 (Conduit)
    ↓ WebSocket 长连接
Bellkeeper Gateway (统一 Sync + 路由)
    ├─ Command Router (解析指令)
    ├─ Policy Engine (权限检查)
    └─ 返回已格式化消息
```

**n8n 角色**：仅作为被调用的工作流后端，不轮询 Matrix。

### 当前状态

- Bellkeeper Gateway ✅ 运行中
- B01 通知 ✅ 已切换到 Bellkeeper API
- M01 ✅ 已移除轮询，Bellkeeper 统一处理
- M02 ✅ 已简化，DirectMemosHandler 接管命令

### 使用摘要

- **主触发方式**：前缀命令 `!` 或 `！`
- **响应预期**：通常 10-15 秒（包含轮询延迟）
- **房间用途**：
  - todo 房间：待办管理
  - qa 房间：知识检索与问答
- **提及触发**：仅作为补充方式；日常以前缀命令为主

### 待办机器人

**说明**：使用 Memos + todo.txt 格式融合方案。

| 指令 | 功能 |
|------|------|
| `!待办 列表` | 查看所有待办 |
| `!待办 新增 P1 D4/20 内容 +项目 @上下文` | 创建待办（支持参数） |
| `!待办 完成 123` | 标记完成 |
| `!待办 删除 123` | 删除待办 |
| `!待办 显示 123` | 查看详情 |

**参数格式**：

| 参数 | 示例 | 说明 |
|------|------|------|
| `P1` / `P2` / `P3` | `P1` | 优先级：高/中/低 |
| `D4/20` / `D2026-04-20` | `D4/20` | 截止日期（短格式/完整格式） |
| `+项目名` | `+工作` | 项目分类 |
| `@上下文` | `@办公室` | 上下文标签 |

**Memos 存储格式**：
```
#待办 #P1 #D:2026-04-20 完成报告 +工作 @办公室
```

**Matrix 显示格式**：
```
(A) 完成报告 +工作 @办公室 due:2026-04-20
```

**导出 API**：`GET /api/todos/export`

### 问答机器人

| 指令 | 功能 | 后端 |
|------|------|------|
| `!问 问题` | 知识库问答 | Bellkeeper AskService → LLM Proxy |
| `!搜 关键词` | 语义检索 | Bellkeeper SearchService (Meilisearch) |
| `!帮助` | 查看帮助 | 本地 |

架构决策背景见 [../../old/evaluations/MATRIX-BOT-EVALUATION.md](../../old/evaluations/MATRIX-BOT-EVALUATION.md)。

---

## RSS 采集管道

### 当前流程

```text
RSSHub 聚合 RSS 源
  ↓
K02-RSS定时采集
  ↓
逐条交给 K01 / Bellkeeper 文件治理入口
  ↓
Bellkeeper 去重 / 提取 / 分类 / 标签 / frontmatter / 落地 raw|working
  ↓
进入 Layer 1 原始输入与 Layer 2 工作层文件资产
  ↓
按文件索引策略建立搜索 / 问答能力
  ↓
K08 汇总摘要 → B01 推送到 Matrix
```

### 路由与提取

- K02 读取 RSSHub feed 后，把文章 URL 与元数据投递给 K01。
- K01 / Bellkeeper 先做去重，再按 **Trafilatura 主力 + Firecrawl 兜底** 的策略提取正文。
- 提取成功后由 Bellkeeper 生成文件名、frontmatter、分类与标签，并落地到 `raw|working`。
- 检索与问答从落地文件派生，不再默认围绕 RAGFlow dataset 路由。
- K04 负责失败重试与兜底处理。

### 提取器策略

- 主力：**Trafilatura**
- 兜底：**Firecrawl**
- 默认不再把 Firecrawl 写成全量主提取器
- 失败统一返回业务态结果，避免被误判为整个工作流失败

### 错误处理

- 爬取失败统一返回业务态结果，避免被误判为工作流整体失败
- `continueOnFail` 保证单篇失败不阻断整批流程
- 汇总通知显示入库成功、已存在、失败、解析触发等统计

### 扩展 RSS 源

1. 在 Bellkeeper 添加 RSS 订阅（`POST /api/rss`）。
2. 配置分类并映射到目标 dataset。
3. 采集工作流自动纳入新源，无需修改工作流定义。

---

## Bellkeeper 与工作流衔接

**技术栈**：Go + SolidJS

### 常用接口

| 端点 | 功能 | 备注 |
|------|------|------|
| `POST /api/ragflow/upload/with-routing` | 文章入库（RAGFlow 上传 + 分类路由） | Bellkeeper 决策 |
| `GET /api/ragflow/check-url` | URL 去重与 RAGFlow 文档校验 | Bellkeeper 决策 |
| `POST /api/ragflow/ingest/obsidian` | Obsidian 笔记入库 | Bellkeeper 处理 |
| `POST /api/ragflow/documents/parse/smart` | 智能解析（自动重试 + 兜底） | Bellkeeper 处理 |
| `POST /api/ragflow/documents/parse/throttled` | 节流解析 | Bellkeeper 处理 |
| `GET /api/rss/list` | RSS 订阅源列表 | Bellkeeper 管理 |
| `GET /api/documents` | 文档列表 | Bellkeeper 管理 |
| `GET /api/logs` | 活动日志查询 | Bellkeeper 管理 |
| `POST /api/matrix/notify` | 发送 Matrix 通知 | Bellkeeper 处理 |
| `POST /api/classify/article` | 文章分类 | Bellkeeper LLM 处理 |

### 关键约束

- `auto_create_tags` 默认关闭，需要显式传 `true`
- 去重命中后会继续校验 RAGFlow 文档是否存在，并清理陈旧记录
- 删除文档时同步清理 `article_tags`
- **Bellkeeper 负责知识入口治理和重的业务逻辑**，n8n 仅负责调用

---

## 笔记系统联动

### 当前组成

| 组件 | 用途 | 状态 |
|------|------|------|
| Memos | 碎片笔记 + 待办 | ✅ todo.txt 融合已实现 |
| Sleek | 轻量待办 (.txt 存储) | ✅ 已评估，采用 Memos + todo.txt 融合方案 |
| CouchDB | Obsidian LiveSync | ✅ |
| Obsidian | 系统化长篇笔记 / PKB | ✅ |
| K07-Obsidian笔记同步 | PKB → Bellkeeper → 检索增强 | ✅ |

### 当前解释

```text
知识 → 笔记：RSS / Working Layer / AI 摘要 → Matrix / Memos / Obsidian
笔记 → 检索增强：Obsidian → LiveSync → CouchDB → K07 → Bellkeeper → RAG / Search
```

K07 每 15 分钟轮询 CouchDB `_changes`，过滤 `.md` 文件，推送到 Bellkeeper `/api/ragflow/ingest/obsidian` 入库。

这个链路应视为：

- 可选增强
- 为了让部分笔记可检索、可问答
- 而不是定义 Obsidian 本体的存在理由

### 待办系统评估（Sleek vs Memos）

**详细调研报告**：[../../evaluations/SLEEK-VS-MEMOS.md](../../evaluations/SLEEK-VS-MEMOS.md)

**Sleek**（ransome1/sleek）：
- 定位：桌面待办管理器，基于 todo.txt 语法
- 存储：本地 `todo.txt` + `done.txt` 文件
- API：**无 API**，仅通过文件监视与其他应用集成
- 生态：有 todo.txt CLI 工具、Obsidian 插件支持

**核心对比**：

| 维度 | Memos | Sleek/todo.txt |
|------|-------|----------------|
| API 完整性 | ⭐⭐⭐⭐⭐ | ⭐ 无原生 API |
| 文件可移植性 | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| Obsidian 集成 | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| 移动端支持 | ⭐⭐⭐⭐⭐ | ⭐ 无官方支持 |
| Matrix 集成 | ⭐⭐⭐⭐ | ⭐⭐⭐ (需 Bellkeeper 处理) |
| 多人协作 | ⭐⭐⭐⭐ | ⭐ 无 |

**推荐方案**：混合模式

1. **保留 Memos** - 作为主要待办系统（API 完善、移动端支持）
2. **增量引入 todo.txt** - 用于 Obsidian 笔记联动
3. **Bellkeeper 支持两种格式** - DirectMemosHandler + todo.txt 解析器

**当前方案**：Memos + todo.txt 融合（已实现）

```
Phase 1: 并行运行 ← 当前阶段
  - Memos 作为主系统
  - O02.1 每分钟同步 Memos #待办 → TrueNAS todo.txt
  - Bellkeeper DirectMemosHandler 处理 Matrix 命令

Phase 2: 指令统一
  - Bellkeeper !待办 同时查询两种格式

Phase 3: 评估迁移
  - 根据使用情况决定长期待办格式
```

---

## 跨服务通信

服务间通过 `hosts/<host>/.env` 配置地址，不在工作流中硬编码 IP。

| 调用方 | 目标 | 环境变量 |
|--------|------|---------|
| n8n → Firecrawl | 网页爬取 | `FIRECRAWL_URL` |
| n8n → RAGFlow | 知识引擎 / 检索增强 | `RAGFLOW_URL` + `RAGFLOW_API_KEY` |
| n8n → 同机服务 | Memos / CouchDB / RSSHub | 容器名直连 |
| n8n → Bellkeeper | 通知发送 | `BELLKEEPER_URL` |
| Bellkeeper → RAGFlow | 文档管理 | `RAGFLOW_URL` + `RAGFLOW_API_KEY` |
| Bellkeeper → n8n | 工作流触发 | `N8N_URL` + `N8N_API_KEY` |
| Bellkeeper → Matrix | 通知发送 | Matrix Gateway |
| RAGFlow → new-api | Chat LLM | RAGFlow 内置配置 |
| RAGFlow → SiliconFlow | Embedding / Rerank | RAGFlow 内置配置 |

迁移主机或调整地址时优先修改 `.env`，避免改工作流定义。
