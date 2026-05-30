# SilkSpool & Bellkeeper 演进规划

> 编写日期: 2026-05-26
>
> 本文档是当前优化方向的汇总，承接 [STATUS.md](STATUS.md)（现状）→ ROADMAP（演进）→ git commit（实施）→ STATUS（回写）这个反馈环。
>
> 范围覆盖：① 代码清理（RAGFlow 退役）② LLM 代理 ③ n8n 工作流 ④ 日志中心 ⑤ Bellkeeper 前端 ⑥ Bellkeeper 后端功能 ⑦ 知识库与问答 ⑧ 运维与可观测性。

---

## 0. 优先级总览

| 优先级 | 类别 | 摘要 | 工期估算 |
|--------|------|------|---------|
| **P0** | 代码清理 | Bellkeeper 删除 9 个 RAGFlow Go 文件 + 路由 + 前端调用 + 配置块 | 2 天 |
| **P0** | n8n 清理 | M03 / K06 / K07 / K08 中的 RAGFlow 调用迁移或下线 | 2 天 |
| **P0** | 配置清理 | `bundles/knowledge/` 整体下线；`bellkeeper-init.sh` 与 `.env` 移除 RAGFLOW_* 变量 | 0.5 天 |
| P1 | LLM Proxy | 对标 new-api：Token + 定价 + **真实余额** + **任务感知池子分层（Coding 三策略）** + **会话粘性** + **自适应限流学习** + 错误码熔断 + 告警聚合 + Kimi Code 接入 + Dashboard 重做，停 new-api | 26.5 天 |
| P1 | n8n 编排 | K02 RSS 解析下沉到 Bellkeeper，移除 K02→K01 间接调用 | 2 天 |
| P1 | 日志中心 | Meilisearch 索引日志全文 + 仪表盘 + 告警规则 | 4 天 |
| P1 | 前端 | 爬取队列可视化页 + Worker 健康详情 + Vault 内联预览 | 3 天 |
| P2 | 问答 | Rerank + 引用展示 + 上下文压缩 + 历史会话 | 3 天 |
| P2 | 后端 | Bellkeeper 单元/集成测试覆盖到 60% | 5 天 |
| P2 | 可观测性 | Prometheus 抓取 + Grafana 看板 + n8n 工作流 SLA 指标 | 3 天 |
| P3 | 知识库 | K07 端到端验证 + 文件级权限标签 + 智能归档建议 | 5 天 |
| P3 | 前端 | Vault 文件在线编辑 + 元数据批量编辑 + 模板插入 | 5 天 |

---

## 1. 代码清理：RAGFlow 退役 (P0)

### 1.1 Bellkeeper Go 代码

**需删除的文件**（核心 9 个）：

- [internal/handler/ragflow.go](../../../Bellkeeper/internal/handler/ragflow.go) — 478 行，26 个 API 端点
- [internal/service/ragflow_upload.go](../../../Bellkeeper/internal/service/ragflow_upload.go)
- [internal/service/ragflow_http.go](../../../Bellkeeper/internal/service/ragflow_http.go)
- [internal/service/ragflow_dataset_sync.go](../../../Bellkeeper/internal/service/ragflow_dataset_sync.go)
- [internal/service/ragflow_parse_queue.go](../../../Bellkeeper/internal/service/ragflow_parse_queue.go)
- [internal/service/ragflow_api.go](../../../Bellkeeper/internal/service/ragflow_api.go)
- [internal/service/ragflow_obsidian.go](../../../Bellkeeper/internal/service/ragflow_obsidian.go)

**需检视并部分清理的文件**：

| 文件 | 处理方式 |
|------|---------|
| `internal/router/router.go` | 删除 `/api/ragflow/*` 路由组（约 27 行）|
| `internal/service/service.go` | 移除 `Services.RagFlow` 字段及其装配 |
| `internal/handler/handler.go` | 移除 RagFlow handler 实例化 |
| `internal/app/app.go` | 移除 RagFlow service 注入 |
| `internal/config/config.go` | 移除 `RagFlowConfig` 结构体 + 默认值 |
| `internal/model/dataset.go` | 删除 `RagFlowID` / `DatasetMapping.RagFlowDatasetID` 等字段（DB AutoMigrate 自动处理）|
| `internal/model/db.go` | 移除 DatasetMapping migrate 中残留 |
| `internal/model/matrix.go` | 检查并移除 ragflow_upload 等模块名常量 |
| `internal/matrix/command/router.go` | 移除 `ragflow_*` 命令分类 |
| `internal/metrics/metrics.go` | 移除 `ragflow_*` 指标 |
| `internal/pkg/defaults/defaults.go` | 移除 RAGFlow 相关默认值 |
| `internal/pkg/errors/errors.go` | 移除 RAGFlow 错误码 |
| `internal/service/dataset.go` | 重命名/重设 `RagFlowID` 概念（保留为 Meilisearch 索引分区）|
| `internal/service/health.go` | 移除 RAGFlow 健康检查 |
| `internal/service/report_test.go` | 更新测试中的 ragflow 期望 |
| `config/bellkeeper.yaml` | 删除 `ragflow:` 配置块 |

**前端清理（Bellkeeper web/）**：

| 文件 | 处理方式 |
|------|---------|
| `web/src/pages/Documents.tsx` | 整页删除或重写为 Meilisearch 文档列表 |
| `web/src/pages/Datasets.tsx` | 重写：Dataset 改为 Meilisearch 索引分区/标签分组 |
| `web/src/api/index.ts` | 删除 `ragflow*` API 客户端方法 |
| `web/src/pages/logs/shared.ts` | 模块筛选下拉移除 `ragflow_*` 选项 |
| `web/src/pages/logs/LogParseTasks.tsx` | 整页删除（解析任务概念随 RAGFlow 退役）|
| `web/src/pages/logs/LogBrowser.tsx` `LogAlerts.tsx` | 移除 ragflow 模块过滤项 |

**验收标准**：
- `grep -ri ragflow internal/ web/src/ config/` 无输出
- `go build ./cmd/bellkeeper` 通过
- 前端 `pnpm build` 通过
- Bellkeeper 启动日志无 "RAGFlow" 相关行

### 1.2 SilkSpool 工作流

| 工作流 | 当前状态 | 处理 |
|--------|---------|------|
| `M03-qa-handler.json` | 文件中仍调 RAGFlow API；远程实际版本可能已切到 Bellkeeper | **核对线上**：从远程 n8n 导出当前版本，覆盖本地；如果远程还是 RAGFlow，则重写为调 `/api/files/search` + `/api/files/ask` |
| `K06-parse-fallback.json` | RAGFlow 解析队列兜底，已无用 | **删除** |
| `K07-obsidian-sync.json` | `active: false`，调 `/api/ragflow/ingest/obsidian` | **重写**：写文件而非走 RAGFlow，目标是 `/api/files/ingest/file`；或保持 active: false 并标注废弃 |
| `K08-daily-digest.json` | `active: false`，查询 ragflow_upload 日志生成 AI 摘要 | **重写**：日志模块改成 `crawl` / `ingest_url`，AI 摘要从 working/ 文件提取，或直接 **删除**（功能已被 O01 吸收）|
| `O01-daily-report.json` | 活跃，引用 RagFlow 服务状态 + ragflow_upload 日志 | **修改**：移除 RagFlow 服务卡片；活动日志模块改为 `ingest` / `crawl` / `classify` |
| `O02-daily-summary.json` | 活跃，引用 RagFlow 服务状态 | **修改**：服务状态卡片只保留 Bellkeeper / n8n / Meilisearch |

**验收标准**：
- `grep -ri ragflow hosts/keeper/n8n-workflows/` 仅剩 K07（如保留为已停用适配器）或全清
- 远程 n8n 实例对应工作流导入更新版本后日报 / 问答仍正常

### 1.3 SilkSpool 配置层

- `bundles/knowledge/` — **整体目录删除**（含 `00-base.yaml`、`10-infra.yaml`、`20-ragflow.yaml`、`30-firecrawl.yaml`、`remote.sh`、`defaults.sh`）
- `bundles/keeper/defaults.sh` — 移除 `RAGFLOW_API_KEY=your-ragflow-api-key` 默认值行
- `bundles/keeper/templates/bellkeeper-init.sh` — 移除 `BELLKEEPER_RAGFLOW_BASE_URL` / `BELLKEEPER_RAGFLOW_API_KEY` 两行 export
- `hosts/keeper/.env`（gitignored）— 删除 `RAGFLOW_API_KEY` / `RAGFLOW_API_URL` / `RAGFLOW_CHAT_ASSISTANT_ID` / `RAGFLOW_DATASET_IDS` 四行（用户在本地清理）
- 远程 `/opt/silkspool/keeper/.env` 同步清理（通过 `./spool.sh sync push keeper`）

---

## 2. LLM 代理优化 (P1) — 对标 new-api 合并方案

### 2.0 背景与目标

**现状**：同时运行 `new-api` 容器（独立 Token/计费/UI）和 Bellkeeper LLM Proxy（DB 渠道、熔断、粘性、双协议）。
- new-api 的优势：Token 体系、模型定价、多协议（Gemini/Rerank/Embedding/Realtime）、完整 Dashboard
- new-api 的劣势：不可改造（Go + Vue，AGPL，业务接进去要 fork 维护成本高，且与 Bellkeeper 配置/日志/Matrix 通知体系完全脱节）
- Bellkeeper 的优势：可深度定制、与 Matrix/ActivityLog/LogCenter/熔断/粘性融为一体
- Bellkeeper 的劣势：缺 Token 管理、缺成本核算、缺协议广度、Dashboard 表层

**目标**：让 Bellkeeper LLM Proxy 在 **关键差距功能** 上达到 new-api 替代水平，1 个迭代内停掉 new-api 容器。

**不做范围（明确收敛）**：
- ❌ 多用户/OAuth（单租户场景，Authelia 已做认证层）
- ❌ Top-up / 支付（自用，不需要给自己计费）
- ❌ Midjourney / Suno / Realtime（当前业务无需求）
- ❌ 多机部署（单机够用）

**差异化战略**（new-api 不具备的）：
- ✨ 接入**真实余额**（DeepSeek/Moonshot/anyrouter/百炼 BSS）— 见 §2.3.5
- ✨ **任务感知 + 池子分层路由**（任务类型 → 候选池子 → 免费优先 → 付费降级，Coding 三策略可选 A/B/C，默认 C）— 见 §2.6.5
- ✨ **会话粘性保 Prompt Cache**（X-Conversation-ID 绑定 channel，禁止会话内切换）— 见 §2.6.7
- ✨ **自适应限流学习**（observe 429 → 学习真实上限，持久化 + 周期识别 + 自我修正）— 见 §2.6.8
- ✨ **错误码语义化熔断**（Kimi Code 订阅 403/402、anyrouter session 失效等智能识别）— 见 §2.6.4
- ✨ **告警聚合**（凭证过期、配额耗尽、熔断升级合并通知，避免轰炸）— 见 §2.6.6

**路由总原则**（按重要性排序）：
1. **任务类型决定候选**：Kimi Code 只有 `coding` 类任务才进候选；`summary`/`classify` 跳过它
2. **免费模型优先**：限流不是问题，只要 token bucket 还有余量就用；耗尽才降级
3. **会话内绝不切换**：同一 `X-Conversation-ID` 从头到尾绑定单 channel，跨切换会废掉 prompt cache（损失最多 90% 折扣）

---

### 2.1 功能差距矩阵

| 能力 | new-api | Bellkeeper | 需补建 | 优先级 |
|------|---------|------------|--------|--------|
| 渠道 CRUD | ✅ | ✅ | — | — |
| 渠道熔断 | ❌ | ✅ | — | — |
| 模型组/粘性路由 | 弱（仅 weighted random） | ✅ | — | — |
| **API Key (Token) 体系** | ✅ 多 Token、模型白名单、配额 | ❌ 仅 server-level | ✅ 必做 | P1 |
| **模型定价表** | ✅ DB 配置 input/output 单价 | ❌ | ✅ 必做 | P1 |
| **成本/消费统计** | ✅ 按 Token/渠道/模型聚合 | ❌ 仅 token 计数 | ✅ 必做 | P1 |
| **缓存命中计费** | ✅ Claude/DeepSeek/OpenAI | ❌ 不解析 cached_tokens | ✅ 必做 | P1 |
| **上游真实余额拉取**（new-api **不具备**） | ❌ 仅本地估算 | ❌ | ✅ 差异化能力 | P1 |
| **池子分层路由**（沉没成本→免费→付费） | ⚠ 仅 weighted | ❌ | ✅ 差异化能力（充分利用 Kimi Code 订阅） | P1 |
| **任务感知路由**（coding/summary/classify 各走不同候选） | ❌ | ❌ | ✅ 差异化能力（不无脑用 Kimi Code）| P1 |
| **会话粘性保 Prompt Cache**（X-Conversation-ID 绑定 channel） | ❌ | ⚠ 仅 caller 级粘性，不防跨会话切换 | ✅ 差异化能力 | P1 |
| **Model 级 RPM 桶**（SiliconFlow 每模型 500 RPM 分桶） | ❌ | ⚠ 仅 channel 级 | ✅ 必做（免费池才能跑满）| P1 |
| **自适应限流学习**（observe 429 → 学习真实上限，持久化 + 自我修正） | ❌ | ❌ | ✅ 差异化能力（免费池关键）| P1 |
| **Coding 路由可选策略**（free_first / quality_first / complexity_aware） | ❌ | ❌ | ✅ 必做 | P1 |
| **错误码语义化熔断**（403 周配额 ≠ 429 限流） | ❌ | ❌ | ✅ 差异化能力 | P1 |
| **告警聚合**（5min 合并、1h 去重） | ❌ | ❌ | ✅ 必做（避免轰炸） | P1 |
| **Kimi Code 订阅接入**（`api.kimi.com/coding/`） | ❌（无 base_url 配置） | ❌ | ✅ 必做 | P1 |
| 协议转换 OpenAI↔Anthropic | ✅ | ✅ | — | — |
| **协议转换 Gemini↔OpenAI** | ✅ | ❌ | ✅ 必做（K05 总结链路用） | P1 |
| **reasoning effort 后缀**（`-high/-medium/-low`） | ✅ | ❌ | ✅ 应做 | P1 |
| **thinking 后缀**（`-thinking-128`） | ✅ | ❌ | ✅ 应做 | P1 |
| **Rerank 端点**（Cohere/Jina 兼容） | ✅ | ❌ | ✅ 必做（合并 ROADMAP §7.1） | P1 |
| **Embedding 端点** | ✅ | ❌（外部调用裸 API） | ✅ 应做 | P2 |
| 图像/语音 | ✅ | ❌ | 暂不做 | P3 |
| **请求日志独立表 + 归档** | ✅ | 部分（`llm_proxy_logs` 存在） | ⚠ 完善归档 | P1 |
| **趋势/排行 Dashboard** | ✅ 强 | ⚠ 当前 Overview 偏弱 | ✅ 必做 | P1 |
| 配额告警 | ✅ | ❌ | ✅ 应做 | P1 |
| Prometheus 指标 | ⚠ | ⚠ `/metrics` 已暴露但无 LLM 直方图 | 合并 §8.1 | P2 |
| 测试连接 / 模型自动探测 | ✅ | ❌ | ✅ 必做（UI 体验） | P1 |
| i18n | ✅ | ❌ | 暂不做（自用） | — |

---

### 2.2 后端：API Key (Token) 体系

**目标**：用 Bellkeeper 自己的 Token 替换「server.api_key 单 key + X-Caller-ID 弱标识」，做到每个调用方一把 key、独立配额、可吊销。

**实施**：

新增表 `llm_tokens`：
```
id, name, key_hash (sha256), key_prefix (前 8 位用于展示), caller_id (= name slug),
allowed_models (JSON 数组, 空=全部), allowed_groups (JSON, 空=全部),
quota_requests_daily, quota_tokens_daily, quota_cost_monthly_cents,
expires_at (nullable), enabled, last_used_at, created_at, deleted_at
```

新增表 `llm_token_usage_daily`（按天聚合 token 维度用量）：
```
token_id, date, requests, prompt_tokens, completion_tokens, cached_tokens,
cost_cents, error_count
```

中间件 `LLMTokenAuth`：
- 优先从 `Authorization: Bearer sk-bk-xxx` 解析
- 命中后将 `caller_id` 注入 ctx（替代现有 X-Caller-ID）
- 校验 `allowed_models`：请求 model 不在白名单 → 403
- 校验日配额：超 quota_requests_daily → 429（携带 `X-Quota-Reset` 头）
- 旁路：内部调用（classify/qa）走 server.api_key，保留现有逻辑

handler 接口：
- `GET/POST/PUT/DELETE /api/llm/tokens` — CRUD
- `POST /api/llm/tokens/:id/regenerate` — 重置 key（旧 key 失效）
- `GET /api/llm/tokens/:id/usage?range=7d` — 用量明细

**迁移**：
- 启动时若 `llm_tokens` 为空，从 `server.api_key` 自动 seed 一条 `default` token（不破坏现有调用方）
- 文档更新告知用户改用 Bellkeeper Web UI 创建专用 token

---

### 2.3 后端：模型定价与成本核算（本地估算）

**目标**：每条请求 → 计算 cost（美分），按 token/渠道/模型聚合。注意这是**本地估算**，用于无真实余额接口的渠道；有真实余额接口的渠道（见 §2.3.5）以上游为准。

**实施**：

新增表 `llm_model_pricing`:
```
id, channel_name, model, input_price_per_1m_cents, output_price_per_1m_cents,
cached_input_price_per_1m_cents (nullable, 默认 input * 0.1), currency, effective_from,
notes
```

种子数据（从 ROADMAP 已知模型清单初始化）：
- `deepseek-chat`: 14 / 28 / cached 1.4 美分/1M
- `qwen3.5-plus`: 40 / 120 美分/1M
- `claude-sonnet-4-6`: 300 / 1500 / cached 30
- Qwen3-8B / Qwen2.5-7B-Instruct (SiliconFlow 免费): 0 / 0

成本计算流程（`service/llm_pricing.go`）：
1. handler 异步阶段（已有 `logRequest()`）→ 调用 `Pricer.Calc(channel, model, usage)`
2. 解析 `response.usage.prompt_tokens_details.cached_tokens`（OpenAI/Claude/DeepSeek 通用字段）
3. cost = uncached_input × input_price + cached_input × cached_price + output × output_price
4. 写入 `llm_proxy_logs.cost_cents`（新增列）+ `llm_token_usage_daily` 累加

新增接口：
- `GET /api/llm/usage?group_by=token|channel|model|date&from=&to=`
- `GET /api/llm/pricing` / `POST` / `PUT` / `DELETE`
- `POST /api/llm/pricing/reload` — 热重载

---

### 2.3.5 后端：上游真实余额同步（new-api 不具备的差异化能力）

**问题**：本地估算成本（§2.3）依赖人工配置的 `llm_model_pricing`，与上游真实计费可能漂移；中转站价格不公开时尤其失真。引入「真实余额拉取」让 Dashboard 显示**估算消费 vs 上游真实余额**两栏对比，并支持「按剩余余额路由」。

**调研结论**（截至 2026-05）：

| 渠道类型 | 真实余额接口 | 鉴权 | 是否复用 sk-key |
|----------|------------|------|---------------|
| DeepSeek 直连 | `GET api.deepseek.com/user/balance` | Bearer sk-key | ✅ |
| Kimi/Moonshot 开放平台 | `GET api.moonshot.cn/v1/users/me/balance` | Bearer sk-key | ✅ |
| **Kimi Code 订阅** (`api.kimi.com/coding/`) | **❌ 无公开接口**（用量仅网页可见） | `sk-kimi-*` | — 依赖错误码熔断（见 §2.6.4） |
| anyrouter / new-api 系中转 | `GET <site>/api/user/self` | Cookie session + `new-api-user` 头 | ❌ 另存登录态 |
| 阿里云百炼 (DashScope) | 阿里云 BSS `QueryAccountBalance` | AccessKey + AccessSecret | ❌ 需额外 AK |
| Anthropic 直连 | `/v1/organizations/usage_report/messages` | `sk-ant-admin-*` | ❌ Admin key（无直连账号，跳过） |
| SiliconFlow / 其它中转 | 同 new-api 系（多数兼容） | session | ❌ |
| Claude Pro/Max 订阅 | 无 | — | — |

**实施**：

新增表 `llm_channel_credentials`（用于存「非 API 调用用」的额外凭证）：
```
id, channel_id, provider_type (deepseek_native|moonshot_native|new_api_session|aliyun_bss|anthropic_admin),
credential_json (加密), -- 例: {"session":"xxx","new_api_user":"12345"} 或 {"ak_id":"","ak_secret":""}
last_refreshed_at, status (active|expired|error), error_message
```

新增表 `llm_channel_balance_snapshots`:
```
id, channel_id, balance_usd, balance_raw (JSON), provider_currency,
fetched_at, latency_ms
```

**BalanceProvider 抽象**（`internal/llm/balance/`）：
```go
type BalanceProvider interface {
    Name() string
    Fetch(ctx, channel, cred) (Snapshot, error)
}
```

初期实现 5 个 provider：
- `DeepSeekNative` — 直接调 `/user/balance`，复用渠道 sk-key
- `MoonshotNative` — 直接调 `/v1/users/me/balance`（**仅 Moonshot 开放平台**，不适用于 Kimi Code 订阅）
- `NewAPISession` — 通用 new-api 系（anyrouter / DoneHub / Veloera 等）
  - 配置项：`base_url`, `user_info_path`（默认 `/api/user/self`）, `api_user_key`（默认 `new-api-user`）
  - `quota` 字段除以 500000 换算为美元（new-api 标准）
- `AliyunBSS` — 阿里云 BSS OpenAPI，调用 `QueryAccountBalance`，需 AccessKey + AccessSecret（百炼必做）
  - 注意：返回的是**整个阿里云账户余额**，非百炼专项；如百炼是子账号 RAM 用户，可绑定 RAM 权限策略 `bssapi:QueryAccountBalance`
- `AnthropicAdmin` — Admin API（仅当用户有直连账号，当前**不实现**）

**调度**：
- 后台任务每 30 分钟拉一次（Bellkeeper Scheduler 注册）
- 失败重试 + 状态写入 `llm_channel_credentials.status`
- session 过期检测：连续 401 / 余额连续 N 次为 0 → 标记 `expired`，发 Matrix 告警提醒用户重登录

**路由增强**：模型组新增策略 `balance_aware`
- 选择候选时：`score = (latency_ewma × (1 + error_rate)) / max(remaining_usd, 1)`
- 余额 < `min_balance_usd` 阈值时降权（不熔断，避免完全切断）
- 余额接口 24h 未刷新（凭证可能过期）→ 退化为 `priority_health` 策略

**安全**：
- `credential_json` 用 `N8N_ENCRYPTION_KEY` 同款 AES-GCM 加密落库（key 来自 `BELLKEEPER_CREDENTIAL_KEY` 新环境变量）
- 前端展示时永远不返回明文，只返回 masked 预览

---

### 2.4 后端：协议转换扩展

#### 2.4.1 Gemini ↔ OpenAI
- 实现 `internal/llm/converter/gemini.go`
- 入参 OpenAI `chat/completions` 格式 → 转 Gemini `generateContent`
- 出参 Gemini 流式 → OpenAI SSE 块
- 触发条件：渠道 `provider_type = "gemini"`
- 模型映射：`gemini-2.5-pro` → Gemini API 实际模型名

#### 2.4.2 Reasoning Effort 后缀
- 解析 model 名：`o4-mini-high` → 上游 `o4-mini` + `reasoning.effort=high`
- 配置项：`pricing.surcharge_high = 1.2`（高 effort 价格倍率）

#### 2.4.3 Thinking 模式后缀
- `claude-sonnet-4-6-thinking-2048` → Anthropic `thinking.budget_tokens=2048`
- `gemini-2.5-pro-thinking-128` → Gemini `thinkingConfig.thinkingBudget=128`
- 输出阶段：将上游 thinking 块转为 OpenAI `reasoning_content` 字段（new-api 一致）

---

### 2.5 后端：新端点（Rerank / Embedding）

#### 2.5.1 Rerank（合并 §7.1）
- 端点：`POST /api/llm/v1/rerank`（Cohere/Jina 兼容 schema）
- 渠道 `provider_type = "rerank"`，初期接 SiliconFlow `BAAI/bge-reranker-v2-m3`
- 复用熔断/粘性/计费基建
- 同步在 ROADMAP §7.1 改写为「调用 Bellkeeper Rerank 端点」

#### 2.5.2 Embedding
- 端点：`POST /api/llm/v1/embeddings`（OpenAI 兼容）
- 用于 Meilisearch 向量字段（可选，当前 Meili 主用全文，预留）
- 优先级 P2

---

### 2.6 后端：日志归档 + 配额告警 + 路由策略 + 错误码分类 + 池子分层 + 告警聚合

#### 2.6.1 `llm_proxy_logs` 归档
- 后台任务每天清理 30 天前记录 → 归档 `/mnt/knowledge/logs-archive/llm/YYYY-MM.jsonl.gz`
- 配置项 `llm_proxy.log_retention_days = 30`

#### 2.6.2 配额告警
- `llm_token_usage_daily` 与 `llm_tokens.quota_*` 实时对比
- 每小时后台任务：超 80% / 95% / 100% 三档告警 → 走 §2.6.6 聚合器，最终发到 Matrix `ops` 频道
- 同时支持渠道级月度配额：`llm_channels.quota_monthly_cost_cents`

#### 2.6.3 路由策略增强（原 §2.5）
- 模型组新增 `strategy = "least_latency"`（EWMA 评分）
- 模型组新增 `strategy = "balance_aware"`（结合 §2.3.5 真实余额）
- 模型组新增 `strategy = "task_aware_tiered"`（结合 §2.6.5 任务感知 + 池子分层，**主力策略**）
- 配置项保存到 `llm_model_groups.strategy_params`（JSON）

#### 2.6.4 错误码语义化熔断

**问题**：当前熔断器只看「请求是否成功」一刀切，但不同上游对失败的语义差别巨大——Kimi Code 订阅 403（周配额耗尽，要等到下次刷新）和 SiliconFlow 429（限流，几秒后可重试）应该走完全不同的熔断时长。

**实施**：新增 `internal/llm/errors/classifier.go`，把响应映射为分类标签：

| 上游 | 状态码 / Body 模式 | 分类 | 熔断时长 |
|------|-------------------|------|---------|
| 全部 | 200 + `success: false` 或 body 含 "insufficient quota" | `quota_exhausted` | 长熔断（到下个刷新周期）|
| Kimi Code | 401 | `auth_failed` | 立即熔断 + 告警「Key 失效」|
| Kimi Code | 402 | `subscription_invalid` | 1h 熔断 + 告警「订阅验证失败」|
| Kimi Code | 403 + body `usage limit` | `quota_exhausted` | 熔断到 5h 窗口或 7d 周期末 |
| Kimi Code | 429 + body `engine overload` | `rate_limited_retry` | 5-30s 短熔断，自动重试 |
| Kimi Code | 429 + body `quota` | `quota_exhausted` | 同 403 |
| DeepSeek | `is_available: false` from 余额接口 | `balance_zero` | 长熔断 + 告警「请充值」|
| anyrouter | 401 + new-api 错误 | `session_expired` | 长熔断 + 告警「重新导入 Cookie」|
| 通用 | 429 RateLimit-Reset 头 | `rate_limited_retry` | 按 header 时长熔断 |
| 通用 | 5xx | `server_error` | 标准指数退避 |

数据结构：渠道熔断状态机增加 `breakdown_until_ts`（明确的恢复时间，而非固定 cooldown）+ `breakdown_reason`（分类标签，前端展示）。

**Kimi Code 订阅专项**：因为没有余额接口，配额耗尽只能靠 403/429 检测。同时引入「探测请求」策略：长熔断期间，每 5h 末尾发一个最小成本探测（say "ping"，模型回 1 token），成功 → 解除熔断。

#### 2.6.5 任务感知 × 池子分层路由（核心差异化）

**问题**：上一版方案默认「Kimi Code 沉没成本最优先」，但实际上 Kimi Code 只对 coding 任务有效，对 summary/classify 反而浪费；且当前模型组是平铺的「member 列表 + 优先级数字」，无法表达「按任务类型选不同池子，免费优先，限流时降级」的语义。

**新设计**：路由是**任务类型 × 池子分层**的二维决策。

##### 步骤 1: 任务分类

调用方通过 HTTP 头声明任务类型；未声明时按规则自动归类：

| 任务类型 | 显式声明 | 自动归类规则 |
|---------|---------|------------|
| `coding` | `X-Task-Type: coding` | model 名含 `coding`/`code`/`kimi-for-coding`，或 caller_id 来自 Claude Code/Cursor |
| `classify` | `X-Task-Type: classify` | K01 入库分类、K05 主题打标等内部 caller_id |
| `summary` | `X-Task-Type: summary` | K05 总结、O01 日报 caller_id |
| `qa` | `X-Task-Type: qa` | `/api/files/ask` 内部调用 |
| `long_context` | 自动 | 估算 prompt_tokens > 32K |
| `chat` | 默认兜底 | 其它所有 |

数据结构：渠道和模型组都可以打 `task_types: [coding, qa]` 标签。

##### 步骤 2: 每种任务类型有独立的候选池子序列

不再是「全局 5 层 tier」，而是**每种任务类型一棵候选树**：

```yaml
task_routes:
  coding:
    - tier: free-coding      # 免费模型擅长 coding 的子集
      members: [siliconflow-qwen3-8b]  # 限流低速但免费
    - tier: kimi-code-subscription     # 沉没成本，仅 coding 任务激活
      members: [kimi-code]
    - tier: paid-coding
      members: [deepseek-chat, anyrouter-claude-sonnet]

  classify:
    - tier: free-fast
      members: [siliconflow-qwen3-8b, siliconflow-qwen2.5-7b, bailian-free-qwen-turbo]
    - tier: paid-budget
      members: [deepseek-chat]
    # ⛔ classify 任务永远不会用 kimi-code（无该 tier）

  summary:
    - tier: free-summary
      members: [bailian-free-qwen-turbo, siliconflow-qwen2.5-7b]
    - tier: paid-balanced
      members: [deepseek-chat, bailian-qwen-plus]

  qa:
    - tier: free-qa
      members: [bailian-free-qwen-turbo]  # 短上下文 QA
    - tier: paid-balanced
      members: [deepseek-chat]
    - tier: high-quality
      members: [anyrouter-claude-sonnet]

  long_context:
    # 自动跳过短上下文模型，直奔大窗口
    - tier: balanced
      members: [deepseek-chat]  # 128K
    - tier: high-quality
      members: [anyrouter-claude-sonnet]  # 200K

  chat:  # 默认兜底
    - tier: free
      members: [siliconflow-qwen3-8b, bailian-free-qwen-turbo]
    - tier: paid-balanced
      members: [deepseek-chat]
    - tier: high-quality
      members: [anyrouter-claude-sonnet]
```

##### 步骤 3: 池内候选选择（Pre-flight 检查）

对每个 tier 内的候选 channel，按以下顺序过滤：

1. **健康检查**：channel 熔断中 → 跳过
2. **Pre-flight token bucket 检查**（关键，针对免费池限流）：
   - 当前 channel 上的 **目标 model** 的 RPM 桶余量 < 1 → 跳过
   - 短任务（estimated_duration < 3s，看 model 类型 + prompt 长度估算）+ 桶余量 0 → 可挂起队列等 2s 重试
   - 长任务 + 桶余量 0 → 立即降级到下一 tier
3. **Context 长度检查**：prompt_tokens > model 上下文窗口 → 跳过
4. **balance_aware 评分**（见 §2.3.5）：余额低的降权

第一个通过所有过滤的 channel 即被选中。

##### 步骤 4: Model 级 RPM 桶（细化限流）

当前 token bucket 是 **channel 级**（一个 SiliconFlow 渠道共享 500 RPM）。要细化到 **model 级**：

- 数据结构：`channel_id → model → TokenBucket`
- SiliconFlow 案例：`siliconflow:Qwen3-8B` 500 RPM，`siliconflow:Qwen2.5-7B` 另外 500 RPM
- 配置：`llm_channels.model_rpm_overrides JSON` 例如 `{"Qwen3-8B": 500, "Qwen2.5-7B": 500}`（**作为冷启动初值**，运行后由 §2.6.8 自适应学习覆盖）
- Token bucket 主动限流（避免发请求才被 429）

##### 步骤 5: Coding 任务路由子策略（可配置）

对于 `task_type=coding`，有三种候选池排序方式，通过 `llm_proxy.coding_routing_strategy` 配置切换：

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| `free_first`（方案 A） | 免费 coding 模型 → Kimi Code → 付费 | 极致省钱，接受免费模型质量波动 |
| `quality_first`（方案 B） | Kimi Code → 付费 → 免费（兜底） | 月费已付且额度充足时最大化使用 |
| `complexity_aware`（方案 C，**默认**） | 按 prompt 复杂度选起点 | 自动平衡成本与质量 |

**方案 C 复杂度判定规则**（按优先级）：

1. **显式声明**：`X-Task-Complexity: simple|complex` 头存在 → 直接采用
2. **Token 长度**：估算 `prompt_tokens + max_completion`：
   - < `simple_threshold_tokens`（默认 1000）→ simple
   - > `complex_threshold_tokens`（默认 4000）→ complex
   - 之间 → medium
3. **关键词匹配**：prompt 含「refactor / architecture / debug / implement entire / 重构 / 设计 / 调试 / 实现整个」等 → complex
4. **回退**：未命中规则 → medium

**复杂度对应候选序**：

| 复杂度 | 候选序 |
|--------|--------|
| simple | 免费 coding → 免费通用 → Kimi Code → 付费 |
| medium | 免费 coding → Kimi Code → 付费 |
| complex | Kimi Code → 付费 Claude/DeepSeek-Coder → 免费（兜底） |

**配置项**：
```yaml
llm_proxy:
  coding_routing_strategy: complexity_aware  # 默认 C
  complexity:
    simple_threshold_tokens: 1000
    complex_threshold_tokens: 4000
    complex_keywords: ["refactor", "architecture", "debug", "implement entire",
                       "重构", "架构", "设计", "调试", "实现整个"]
```

UI: `/llm/pools` 顶部加策略切换器（radio button A/B/C）+ 复杂度阈值滑块。

##### 步骤 6: 全 tier 都被降级时的处理

- 所有 tier 都不可用 → 返回 503 + Matrix 告警「所有渠道不可用」
- 路由日志写入 `llm_routing_decisions(request_id, conversation_id, task_type, tried_tiers, final_channel, fallback_reasons[])` 表，前端可视化

##### Kimi Code 接入说明

- 新建渠道 `kimi-code`：`provider_type=anthropic`，`base_url=https://api.kimi.com/coding/`，`models=[kimi-for-coding]`
- 凭证 `sk-kimi-*` 存 `LLM_KIMI_CODE_API_KEY` 环境变量
- **仅出现在 `task_routes.coding` 的候选池中**，其它任务类型不会路由到它
- 因为没有余额接口，仅靠 §2.6.4 错误码熔断 + 5h 探测自恢复

##### 配置 UI

见 §2.7.6 `/llm/pools` 重做后的「任务路由配置」视图。

#### 2.6.6 告警聚合（合并通知）

**问题**：原计划每个事件单独发 Matrix → 凭证过期、配额接近、熔断升级一起来会变成消息轰炸。

**实施**：引入 `AlertAggregator`（`internal/alert/aggregator.go`）：

- **缓冲窗口**：5 分钟（可配置 `alert.flush_interval`）
- **去重维度**：`(alert_type, channel_id, severity)` 三元组在 1h 内只发一次
- **凭证类告警**：1h 内同类只发一次（不烦人）
- **聚合渲染**：5min 内多事件 → 一条 Matrix 消息：
  ```
  ⚠️ LLM Proxy 5min 内 3 个事件:
  • [warning] siliconflow 限流 5 次（已熔断 30s）
  • [error] kimi-code 配额耗尽，预计 6h 后恢复
  • [info] deepseek 余额 < $5，建议充值
  ```
- **严重级别**：`info` / `warning` / `error` / `critical`，仅 `error+` 触发 Matrix；`info` 仅写 ActivityLog
- **告警频道路由**：所有 LLM 相关告警 → Matrix `ops` 房间（单频道，避免分散）

数据结构：新增表 `llm_alert_events(id, alert_type, severity, channel_id, message, created_at, dedup_key, flushed_at)`。

#### 2.6.7 会话粘性与 Prompt Cache 保护（核心差异化）

**问题**：每次调用独立选 channel 会发生严重问题——
- Anthropic prompt cache 基于 `cache_control` 标记，跨 provider 切换缓存全失效（最多损失 90% 成本折扣）
- 多轮会话中切换 model 导致响应风格突变、记忆错乱（用户体验灾难）
- OpenAI auto-prefix cache 同理，跨 provider 失效

**实施**：

新增表 `llm_conversation_bindings`:
```
conversation_id (string, 主键), channel_id, model, task_type,
first_seen_at, last_seen_at, expires_at (24h TTL),
request_count, total_tokens, total_cost_cents
```

路由器规则：
1. 请求带 `X-Conversation-ID` 头（推荐 UUID）→ 查绑定表
2. 已存在绑定 → **必须使用同一 channel + model**；该 channel 熔断了 → **返回 503 让客户端决定**（绝不悄悄切换破坏 cache）
3. 不存在绑定 → 按 §2.6.5 路由 → 写入绑定（24h TTL）
4. 请求未传 `X-Conversation-ID` 但 body 含 `cache_control` 标记 → 用 `sha256(messages[0:N])` 作为隐式 conversation_id

绑定 TTL 续期：每次请求 last_seen_at 滑动 24h；超期清理。

**例外**：调用方可显式带 `X-Allow-Channel-Switch: true` 头，跳过粘性（适合无状态短任务）。

**API 接口**：
- `GET /api/llm/conversations` — 列出活跃绑定
- `DELETE /api/llm/conversations/:id` — 手动解绑（用于排查）

**前端**：`/llm/conversations` 新增子页（可选 P2），列表显示活跃会话 + 当前绑定 channel + 累计成本。

#### 2.6.8 自适应限流学习（Adaptive Rate Limit Learning，核心差异化）

**问题**：免费模型的真实 RPM/RPD/并发上限**文档常不准确或动态变化**——
- SiliconFlow 文档说每模型 500 RPM，但实际可能因账号等级 / 时段 / 模型负载浮动
- 阿里云百炼免费额度模型限速规则不透明
- 中转站（anyrouter 类）限速跟随上游变动
- 即使配了 `model_rpm_overrides` 也只是冷启动猜测，long-tail 会持续偏差

**目标**：LLM Proxy 自动观察实际响应、学习真实限流参数，长期持久化并自我修正。

##### 数据结构

新增表 `llm_model_rate_limits`：
```
id, channel_id, model,
configured_rpm,         -- 用户/文档配置的初值（冷启动用）
configured_rpd,         -- 同上
learned_rpm_safe,       -- 学习到的安全瞬时 RPM
learned_rpd_safe,       -- 学习到的安全日上限
learned_concurrent_max, -- 学习到的最高并发
reset_pattern,          -- 'sliding_60s' | 'fixed_minute' | 'sliding_5h' | 'sliding_7d' | 'daily_utc8' | 'daily_utc'
confidence_score,       -- 0.0-1.0, 观察次数越多越高
last_429_at,
last_429_observed_rpm,
last_adjust_at,
locked,                 -- bool, true 时不再自动学习（管理员手动锁定）
adjustment_log JSON,    -- 最近 50 次调整记录 [{ts, from, to, reason}]
created_at, updated_at
```

##### 学习算法

**阶段 1: 冷启动**
- 用 `configured_rpm` 的 **50%** 作为初始 `learned_rpm_safe`（保守，避免一上来就触发 429）
- `confidence_score = 0.1`

**阶段 2: 渐进探测（无 429）**
- 后台任务每 5 分钟评估：当前 5min 内成功率 100% **且** 桶余量持续 < 30% → 说明上限可能更高
- 将 `learned_rpm_safe` 上调 10%（最高不超过 `configured_rpm × 1.2`，避免被文档限制坑死）
- `confidence_score += 0.05`（最高 1.0）
- 写入 `adjustment_log`

**阶段 3: 遇到 429 → 立即降级**
- 立即将 `learned_rpm_safe` 调到 **当前瞬时实际 RPM × 0.85**
- 记录 `last_429_observed_rpm`
- `confidence_score` 不变（429 是真实数据，反而提高对该值的信任）
- 触发熔断 30s（由 §2.6.4 错误码分类决定）

**阶段 4: 周期识别**
- 后台任务每天分析 `llm_proxy_logs`，统计 429 出现的时间模式：
  - 每分钟 0 秒附近集中 → `fixed_minute`
  - 每 5 小时整点 → `sliding_5h`（典型 Kimi Code）
  - 每天 0 点 UTC+8 → `daily_utc8`（阿里云典型）
  - 均匀分布 → `sliding_60s`
- 周期识别后，对应调整 RPM 桶的 reset 时机

**阶段 5: 日上限（RPD）学习**
- 首次出现 `quota_exhausted` 错误时，记录当天累计请求数为 `learned_rpd_safe × 0.95`
- 次日同样位置触发即确认值；不触发则慢慢上调
- 周期为 `daily_*` 的情况下，在 95% 阈值触发降级（保留余量）

##### 持久化与回滚

- 每小时把内存中的 `learned_*` 写回 DB（避免重启丢失）
- 启动时从 DB 加载（连续学习）
- `adjustment_log` 保留最近 50 次，便于排查异常调整

##### 异常保护

- **暴跌检测**：若 1 小时内 `learned_rpm_safe` 下降 > 50%，发 Matrix 告警（可能上游策略变了，需人工确认）
- **学习锁定**：管理员可在 UI 上 `locked=true`，禁止自动学习（用于已知精确限制的渠道，如付费 SLA）
- **冷启动期保护**：`confidence_score < 0.3` 时即使学习到高值也限制为 `configured_rpm × 0.8`

##### 与现有 Pre-flight 桶检查的关系

- §2.6.5 步骤 3 的 Pre-flight 检查使用的是 `learned_rpm_safe`（而非 `configured_rpm`）
- 桶余量计算：`learned_rpm_safe - 最近 60s 内的请求数`
- 完全自动化，无需运维干预

##### API 接口

- `GET /api/llm/rate-limits` — 列出所有 channel × model 的学习状态
- `GET /api/llm/rate-limits/:channel/:model/history` — 查看调整历史
- `POST /api/llm/rate-limits/:id/lock` — 锁定/解锁自动学习
- `POST /api/llm/rate-limits/:id/reset` — 重置学习（回到 configured_rpm × 0.5 重新开始）

##### 前端：`/llm/channels` 行展开 + 学习历史图

- 渠道行展开后显示每个 model 的学习状态：
  - 当前 `learned_rpm_safe` vs `configured_rpm`，差异条形图
  - 置信度环形图
  - 最近 429 时间 + 当时瞬时 RPM
  - 周期识别结果（`sliding_60s` / `daily_utc8` 等）
- 「学习历史」时序图：过去 7/30 天 `learned_rpm_safe` 变化曲线，叠加 429 事件点
- 「锁定」开关 + 「重置学习」按钮

---

### 2.7 前端：UI 全面重做（核心交付物）

> 设计原则：参考 new-api 视觉密度，但贴合 Bellkeeper 既有设计语言（Tailwind + shadcn-style）。

#### 2.7.1 `/llm` Dashboard 重做（替换当前 `LLMOverview`）

**布局（自上而下）**：
1. **顶部 KPI 卡片行**（5 个）：今日请求数 / 今日 Token 量 / 今日成本（$） / 活跃渠道数 / 错误率
2. **「估算 vs 真实」对比条**（核心差异化）：每渠道一行，左侧本地估算月度消费，右侧上游真实余额/已用，差异超 10% 高亮黄色
3. **趋势图区**（左 2/3，右 1/3 分栏）：
   - 左：折线图，24h/7d/30d 切换，可叠加多曲线（请求数/Token/成本）
   - 右：渠道健康饼图 + 模型组健康卡片堆叠
4. **Top N 排行**（三列）：消耗 Top10 Token、调用 Top10 模型、错误 Top10 渠道
5. **实时事件流**（底部）：最近 20 条 LLM 调用，状态/Token/成本一行展示

#### 2.7.2 `/llm/tokens` 新增页（对标 new-api Token 页）

- 表格列：Name、Key 前缀、允许模型、配额（请求/Token/成本三 bar）、最近使用、状态
- 操作：新建（**创建后弹窗一次性展示完整 key**）、重置 key、编辑配额、禁用、删除
- 行展开：当前月用量明细 + 趋势小图
- 创建表单：name、模型多选下拉（从渠道聚合）、配额三项、过期时间

#### 2.7.3 `/llm/billing` 新增页（计费视图）

- 顶部切片器：时间范围 / group_by（Token/渠道/模型/日期）
- 主表：聚合后的成本/Token/请求数，可排序
- 趋势图：堆叠面积图（按 group_by 维度堆叠）
- 配额预警卡片区：即将超额的 Token/渠道高亮

#### 2.7.4 `/llm/pricing` 新增页

- 表格：渠道 × 模型 × input/output/cached 单价
- 操作：CRUD、批量复制（同一渠道下复制定价到新模型）
- 「测试计算」工具：输入 model + token 数 → 实时显示成本

#### 2.7.5 现有页面增强

| 页 | 增强项 |
|----|--------|
| `LLMChannels` | 增加「测试连接」按钮（发探测请求）+「自动探测模型」（拉 `/v1/models`）+ 显示渠道月成本 + **真实余额徽章**（绿/黄/红，悬停显示拉取时间） |
| `LLMConfig` | API Key 改为「环境变量名 / 直接粘贴」双模 + 模型多选下拉（不再手填 JSON）+ 表单分步引导 + **「绑定余额来源」分页**（选 provider 类型 + 填凭证，session 类型给「从浏览器导入 Cookie」工具） |
| `LLMLogs` | 增加 cost 列、cached_tokens 列、trace_id 链接（跳 LogCenter）、按 Token 筛选 |
| `LLMGroups` | 路由策略可视化（`least_latency` 时展示各成员 EWMA 评分，`balance_aware` 时展示各成员剩余余额折算分数） |
| `LLMPricing` | 在每行末尾对比上游真实结算价（若可拉取），偏差 > 15% 红字提示「需校准」 |

#### 2.7.6 `/llm/pools` 新增页（任务路由配置 — 差异化核心）

承接 §2.6.5 任务感知分层路由 + §2.6.7 会话粘性，需要好用的可视化配置：

**主区域：任务路由矩阵**
- 行：任务类型（coding / classify / summary / qa / long_context / chat）
- 列：池子分层（free / balanced / high_quality / overflow）
- 单元格：该任务-该层的候选 channel 列表，可拖拽编辑
- Kimi Code 仅在 `coding × kimi-code-subscription` 这一格出现，其它任务类型该格为「不可用」（灰显）

**右侧栏：Pre-flight 与限流监控**
- 每个 channel 的 model 级 RPM 桶余量条
- 当前 1min 内被「桶不足」跳过的次数
- 配额耗尽倒计时（如 Kimi Code 5h 窗口 / 7d 周期）

**会话粘性面板**（来自 §2.6.7）：
- 列出最近 24h 活跃 `conversation_id` 绑定
- 显示每个会话当前 channel、累计 token、累计成本
- 可手动解绑（用于排查粘性卡死问题）

**模拟器**：
- 选「任务类型 + 估算 token 数 + 是否带 conversation_id」→ 可视化路由决策过程：tier 1 → 候选 [A,B] → A 桶不足跳过 → B 选中
- 用于配置后验证策略是否符合预期

**告警面板**：右上角浮动小组件，订阅 `/api/llm/alerts/recent`，5min 内事件以圆形数字标徽显示（来自 §2.6.6）。

#### 2.7.7 顶部导航重组

当前 `/llm/*` 子页扁平，新结构：
```
/llm                  概览 (Dashboard)
/llm/tokens           Token 管理
/llm/channels         渠道运行时
/llm/groups           模型组运行时
/llm/pools            池子分层配置 ⭐ 差异化
/llm/billing          计费与统计
/llm/pricing          定价配置
/llm/config           渠道/组配置 (合并到一个工作台)
/llm/logs             请求日志
/llm/alerts           告警历史（关联 §2.6.6）
```

侧栏增加分组：「运行时」「配置」「计费」「告警」四段折叠。

---

### 2.8 迁移与停服计划

1. **W1**：完成 §2.2 §2.3 §2.4（后端 Token + 计费 + Gemini）
2. **W2**：完成 §2.3.5 §2.5 §2.6.1-2.6.3（真实余额 + Rerank + 基础归档/告警/路由）
3. **W3**：完成 §2.6.4 §2.6.5（错误码分类 + Kimi Code 探测 + 任务感知池子分层 + Model RPM 桶 + Coding 三策略）
4. **W4**：完成 §2.6.6 §2.6.7 §2.6.8（告警聚合 + 会话粘性 + 自适应限流学习）
5. **W5**：完成 §2.7.1-2.7.4（Dashboard + Token + Billing + Pricing 前端）
6. **W6**：完成 §2.7.5-2.7.7（现有页增强 + Pools 矩阵 + 学习历史图 + 导航）+ 迁移：
   - 从 new-api 导出 Token 列表 → 在 Bellkeeper Web 重建（手工，<10 个）
   - 新建 Kimi Code 渠道：base_url `https://api.kimi.com/coding/`，key 存 `LLM_KIMI_CODE_API_KEY`，仅放入 `task_routes.coding` 候选池
   - 配置任务路由矩阵（coding / classify / summary / qa / chat 各自的候选序列）+ 选定 coding 子策略（默认 complexity_aware）
   - 调用方迁移：Open WebUI / 其他工具的 base_url 从 new-api 改为 `https://bellkeeper/api/llm/v1`，并加 `X-Conversation-ID` 头
   - 观察 7 天调用量稳定后，`docker stop new-api` → `docker rm`
   - 清理 `bundles/` 中 new-api 相关模板

**验收标准**：
- new-api 容器停止运行 7 天后无回滚需求
- `/llm/billing` 能看到上月按 Token/渠道/模型的成本切片
- 单个 Token 触发配额能在 Matrix `ops` 频道收到告警（且 5min 内同类告警合并为 1 条）
- Gemini 模型可通过 Bellkeeper 调用（K05 总结链路可选切换验证）
- **Kimi Code 订阅验证**：调用 `kimi-for-coding` 成功；触发 403 → 自动熔断且 5h 后探测自恢复；周配额满 → Matrix 收到一条聚合告警
- **任务感知路由验证**：发 `X-Task-Type: classify` 请求**永远不会**路由到 Kimi Code（仅 coding 才用）
- **Coding 三策略验证**：切换 `coding_routing_strategy` 配置 → 同一 coding 请求路由到的 channel 序列符合该策略；默认 C 时短 prompt 走免费、长 prompt 走 Kimi Code
- **会话粘性验证**：带 `X-Conversation-ID: xxx` 连续 10 次请求，全部命中同一 channel；Anthropic prompt cache hit rate > 80%（vs 无粘性约 0%）
- **Model 级 RPM 桶验证**：SiliconFlow Qwen3-8B 跑满 500 RPM 时，Qwen2.5-7B 仍可继续接收请求（说明分桶生效）
- **自适应限流验证**：
  - 故意配置 `configured_rpm=1000`（超过实际） → 运行 30 分钟后 `learned_rpm_safe` 应自动降至实际值 ±20% 范围
  - 故意配置 `configured_rpm=10`（远低于实际） → 运行 24 小时后 `learned_rpm_safe` 应自动上调（不超过 `configured_rpm × 1.2`，受冷启动保护）
  - 触发一次 quota_exhausted → 次日同一时间触发率应 < 10%（学习到了日上限）
  - 学习历史图能展示过去 7 天的调整轨迹

---

### 2.9 工期估算

| 阶段 | 工期 |
|------|------|
| §2.2 Token 体系（后端） | 1.5 天 |
| §2.3 定价+成本（后端） | 1 天 |
| §2.3.5 真实余额同步（后端，4 个 provider） | 2.5 天 |
| §2.4 协议扩展（后端） | 1.5 天 |
| §2.5 Rerank/Embedding（后端） | 1 天 |
| §2.6.1-2.6.3 归档+告警+路由（后端） | 1 天 |
| §2.6.4 错误码分类 + Kimi Code 探测（后端） | 1.5 天 |
| §2.6.5 任务感知 × 池子分层 + Model 级 RPM 桶 + Coding 三策略（后端） | 3 天 |
| §2.6.6 告警聚合器（后端） | 1 天 |
| §2.6.7 会话粘性 + Prompt Cache 保护（后端） | 1.5 天 |
| §2.6.8 自适应限流学习（后端，含周期识别）| 2.5 天 |
| §2.7 前端全套（含 /llm/pools 矩阵 + 模拟器 + 学习历史图） | 7 天 |
| §2.8 迁移 + 验证 | 1.5 天 |
| **合计** | **26.5 天**（含缓冲约 5.5 周） |

> 原 ROADMAP §0 中 P1 LLM Proxy 估「3 天」过于乐观，此处修正为 26.5 天 / 5.5 周（含真实余额、任务感知池子分层、错误码分类、会话粘性、告警聚合、**自适应限流学习**、Kimi Code 接入、Coding 三策略 这八项差异化能力）。

---

## 3. n8n 工作流优化 (P1)

### 3.1 调用链路压缩

**问题**：当前部分链路超过 4 层（n8n → n8n webhook → Bellkeeper → 下游）。

| 链路 | 现状 | 优化 |
|------|------|------|
| K02 → K01 webhook → Bellkeeper | n8n-to-n8n 间接调用 | K02 直接调 Bellkeeper `/api/files/ingest/url`，移除 K01 webhook 中转 |
| K02 RSS XML 解析 | 当前在 n8n JS 节点中正则解析 | 下沉到 Bellkeeper `/api/rss/parse`，K02 只做调度 |
| K08 → K05 webhook | K08 通过 K05 中转走 LLM Proxy | K08 直接调 `/api/llm/v1/chat/completions`（如保留 K08）|

### 3.2 通知链路降层

**问题**：n8n → B01 → Bellkeeper `/api/matrix/notify` → NATS → worker → Matrix（5 层）。

**评估**：当前 NATS 是必要的（重试 + 限速 + 异步），但 B01 这一层是否仍需要？
- **方案 A**：保留 B01 作为格式化与默认值兜底（推荐）
- **方案 B**：移除 B01，所有工作流直接调 `/api/matrix/notify`（更扁平但每个工作流要重复格式化逻辑）

**决策建议**：保留 B01，但在 Bellkeeper Notify 接口侧支持模板（`template_id` + `params`），让 B01 只做模板渲染。

### 3.3 工作流统一管理

**问题**：当前 20 个工作流，激活状态分散，命名虽然遵循 B/K/M/O 但运行时缺少全局视图。

**实施**：
- Bellkeeper `/workflows` 页扩展：增加批量激活/停用、批量启用/禁用、Tag 分组视图
- 新增 `/workflows/dependencies` 调用图视图（n8n → Bellkeeper 调用关系自动绘制）

### 3.4 死代码工作流回收

| 工作流 | 处理建议 |
|--------|---------|
| K06-parse-fallback | 直接删除（RAGFlow 解析兜底，已无用） |
| K08-daily-digest | 删除或合并到 O01（O01 已包含日报）|
| K07-obsidian-sync | 重写为「从 working/ 回流到 Vault」适配器；如 6 月仍未启用则删除 |
| O02.1-todo-sync | 验证后并入 O02 或 M02 |

### 3.5 工作流 SLA 指标

**实施**：
- n8n executions 通过 webhook 推送到 Bellkeeper（n8n native 不支持，需 `executions.success` webhook 或后台任务拉取）
- 新增表 `workflow_executions(workflow_id, start_time, duration_ms, status, error)`
- 看板：成功率、平均时长、最近 100 次执行趋势

---

## 4. 日志中心优化 (P1)

当前 Bellkeeper 已有 LogCenter（entries/sources/dashboard/alerts），但功能比较表层。

### 4.1 日志全文检索

**问题**：当前日志按 module/action/status 过滤，长消息体不可检索。

**实施**：
- 复用 Meilisearch（已部署），创建 `logs` 索引
- LogCenter 写入时双写：DB（结构化）+ Meili（全文）
- `/api/logs/search?q=keyword` 走 Meili，`/api/logs` 走 DB 分页
- 前端 `/logs/dashboard` 增加搜索框

### 4.2 日志保留与归档

**问题**：`activity_logs` 表无生命周期，长时间累积会变慢。

**实施**：
- 配置项 `logging.retention_days = 90`
- 后台任务每天清理过期记录（先归档到 `/mnt/knowledge/logs-archive/YYYY-MM.jsonl.gz` 再删除）
- Meili 索引同步清理

### 4.3 实时日志流

**问题**：调试时需要 tail -f 容器日志，无 Web 入口。

**实施**：
- Bellkeeper 新增 `/api/logs/stream` SSE 端点
- 前端 `/logs/dashboard` 新增 "实时" 模式
- 仅订阅最近 5 分钟事件，避免大量历史回放

### 4.4 告警规则增强

**问题**：当前告警规则简陋，仅支持单条规则匹配。

**实施**：
- 规则类型：`threshold`（计数）/ `pattern`（正则）/ `silence`（一段时间无日志即告警）
- 告警渠道：Matrix 房间 / Webhook / 邮件（暂不实施邮件）
- 告警去重：同一规则 X 分钟内只发一次
- 前端 `/logs/alerts` 增加规则编辑器

### 4.5 跨服务日志关联

**问题**：一次入库失败的根因可能跨 n8n → Bellkeeper → LLM Proxy → 外部 LLM 多个系统，日志分散。

**实施**：
- 引入 `trace_id`（从 n8n 触发起就生成，传递到 Bellkeeper Header）
- 所有日志写入时强制带 `trace_id`
- 前端 `/logs/dashboard` 增加 "按 trace 聚合" 视图，点 trace_id 看完整链路

---

## 5. Bellkeeper 前端优化 (P1-P3)

四大核心域（Knowledge / LLM / Logs / Matrix）已重构完成，现在需要补功能深度。

### 5.1 P1: 爬取队列可视化

**当前**：CrawlQueue 后端能力完整（任务、Worker、熔断），但前端没有专门页面，运维查看依赖 API 或日志。

**实施**：
- 新增页面 `/knowledge/queue`
  - 任务列表：URL、状态（pending/running/success/retrying/blocked/dead）、worker、错误信息、重试次数
  - 任务操作：手动重试、取消、查看完整日志
  - 状态分布饼图 + 最近 24 小时趋势线
- 新增页面 `/knowledge/workers`
  - Worker 实例列表：channel、状态、熔断器状态、连续失败数、最近请求时间
  - 操作：手动开/关熔断、调整并发度

### 5.2 P1: Vault 文件预览增强

**当前**：`/knowledge/files` 提供 Vault 浏览，但 Markdown 内联渲染、frontmatter 高亮、链接预览缺失。

**实施**：
- 引入轻量 Markdown 渲染器（如 `markdown-it` 或 `marked`）
- frontmatter 区折叠 + 元数据快速编辑（标签、分类、wikilinks）
- `[[wikilink]]` 解析为可点跳转的 Vault 内链接
- 附件图片内联展示（从 `notes-assets/` 解析）

### 5.3 P1: 知识问答改造

**当前**：`/knowledge/ask` 是单轮问答，引用展示弱。

**实施**：
- **多轮上下文**：会话内保留最近 N 轮，UI 支持「新建会话」/ 「分享会话链接」
- **引用展示**：每条引用展示文件路径、片段、相关度评分；点引用跳到 `/knowledge/files` 对应位置
- **流式响应**：SSE 边生成边展示
- **降级提示**：当问答失败（LLM 异常、检索为空）给出明确原因和建议
- **检索调试模式**：开关 `?debug=1` 展示中间检索结果、Rerank 评分

### 5.4 P2: Tag / Dataset 改造

**当前**：Datasets 页面仍包含 RAGFlow Dataset 概念。

**实施**：
- 重命名 Datasets → Collections（或保留 Dataset 但解耦 RAGFlow 含义）
- Collection 仅作为：标签分组 + Meilisearch 索引分区 + 默认存储路径
- 操作：新增/编辑 Collection、关联标签、查看包含的文档数、跳转到 `/knowledge/files?collection=xxx`

### 5.5 P2: Matrix Admin 完善

**当前**：Matrix 页面框架完整，但实际功能存在 TODO（如「房间删除」前端 toast「未实现」）。

**实施**：
- 完成所有标注「未实现」的功能（鼠标移到按钮上能预期到的操作都应工作）
- 命令管理：从 DB 动态加载（替代硬编码注册）
- 通知规则编辑器：可视化配置 `房间 + 关键词 → 频道` 路由

### 5.6 P2: Dashboard 重做

**当前**：Dashboard 简单展示服务状态。

**实施**：
- 上半区：核心指标卡片（今日新文档数、待办数、LLM 调用数、爬取队列长度、最近错误数）
- 中部：时间序列图（24h 入库趋势、LLM 延迟、爬取成功率）
- 下半区：最近活动流（合并 ActivityLog + 重要事件）
- 集成 `/llm/groups/status` 健康卡片

### 5.7 P3: Vault 在线编辑

**实施**（远期）：
- 编辑器：CodeMirror 6 或 Monaco
- 双向同步：写入 → Bellkeeper API → 文件落盘 → CouchDB LiveSync 通知（如 K07 启用）
- 冲突处理：基于 mtime 检测，提示「文件已被外部修改」

### 5.8 P3: 元数据批量操作

**实施**：
- `/knowledge/files` 列表支持多选
- 批量改 tag、批量移动、批量删除
- 操作前预览（不可逆操作必须二次确认）

---

## 6. Bellkeeper 后端功能优化 (P1-P3)

### 6.1 P1: 索引增量更新

**当前**：Meilisearch 索引重建是全量的（`/api/files/rebuild`），新增/编辑文件后需要等下次全量。

**实施**：
- 文件入库成功后异步触发单文件 reindex（`indexer.QueueFile(path)`）
- 文件删除事件同步删除 Meili 文档
- 后台任务每小时校对 DB 与 Meili 文档数量，发现漂移自动修复

### 6.2 P1: 文件入库幂等性

**当前**：URL 去重生效，但「同一 URL 强制重新入库」（更新已存在文件）路径不清晰。

**实施**：
- 接口扩展：`POST /api/files/ingest/url` 增加 `force_refresh: true` 参数
- 强制刷新时：保留原 frontmatter `id`，body 重写，更新 `updated_at`
- 历史版本可选保存到 `working/.history/<id>/<timestamp>.md`

### 6.3 P1: 配置热重载完善

**当前**：LLM Proxy 配置已支持 DB 热重载，但其他配置项（爬取并发数、提取器超时、Meili 索引名）仍需重启。

**实施**：
- `system_settings` 表扩展为通用动态配置
- 关键配置项注册到 `ConfigManager.Watch(key, callback)`
- Web UI `/settings` 完善配置项分类（爬取 / 提取 / 索引 / 通知）

### 6.4 P2: Webhook 接入层

**当前**：外部系统给 Bellkeeper 推送数据只能通过 API Key 直连或 n8n 中转。

**实施**：
- 新增表 `webhooks(id, name, secret, url_slug, handler, enabled)`
- 端点 `POST /webhooks/:slug` 校验 HMAC + 路由到 handler
- 用途：GitHub PR 通知 → Matrix、Webhook 触发知识入库

### 6.5 P2: 单元 / 集成测试

**当前**：测试覆盖严重不足，仅 2 个测试文件。

**实施**：
- 关键 service：`file_ingestion`、`crawl_queue`、`llm_proxy`、`classify` 各至少 5 个核心 case
- 关键 handler：表驱动测试覆盖参数校验、权限、错误码
- 集成测试：用 testcontainers 起 Postgres + Meili，跑端到端入库 → 检索流程
- 目标：核心模块覆盖率 60%

### 6.6 P2: golang-migrate 接入

**当前**：靠 GORM AutoMigrate 自动建表。生产环境无版本化、无回滚。

**实施**：
- 启用 `migrations/` 目录的 SQL 文件（已有 `001_init.sql`）
- 用 `golang-migrate/migrate` 包裹，`bellkeeper migrate up/down` 子命令
- AutoMigrate 保留为开发环境兜底

### 6.7 P3: 多用户与 ACL

**当前**：通过 Authelia 单用户访问。

**实施**（待评估必要性）：
- 文件 / 标签 / 房间 / 频道粒度的 ACL
- 角色：`owner` / `editor` / `viewer`
- API Key 绑定角色 + IP 白名单

---

## 7. 知识库与问答优化 (P2)

### 7.1 Rerank

**当前**：Meilisearch 一次召回，无 Rerank。

**实施**：
- 优先依赖 §2.5.1 新增的 Bellkeeper Rerank 端点（`/api/llm/v1/rerank`，复用熔断/粘性/计费）
- 召回 top-20 → 调用本地 Rerank → top-5
- LLM 调用接 Rerank 后的结果
- 评估：抽样 20 个真实问题，对比有无 Rerank 的命中精度

### 7.2 上下文压缩

**当前**：检索到的文档片段直接拼接进 prompt，长文档很快撑爆 token。

**实施**：
- 引入 `llm.compress` 步骤：每个片段独立摘要为 200 字，再拼接
- 提示词模板：`基于以下摘要回答问题，摘要中可能包含原文链接`
- 当总 token 超过阈值时启用，否则跳过

### 7.3 引用与跳转

**当前**：引用展示为纯文本片段。

**实施**：
- 每个引用包含 `{file_path, line_range, similarity_score, excerpt}`
- 前端引用卡片支持点击跳到 `/knowledge/files?path=<path>#L<line>`
- 高亮命中片段

### 7.4 多源检索

**当前**：仅检索 `raw|working`。

**实施**：
- 可选包含 `KNOWLEDGE/`（PKB 长青笔记）— 默认关闭，UI 开关
- 可选包含 `todos/`（Memos 同步的待办）— 用于回答「我有哪些待办」

### 7.5 历史会话

**当前**：每次问答是无状态的。

**实施**：
- 表 `qa_sessions(id, user, started_at, last_active)` + `qa_messages(session_id, role, content, citations)`
- API `/api/files/ask` 接受 `session_id` 参数
- Matrix M03 端按 thread_id 维护会话上下文

---

## 8. 运维与可观测性 (P2)

### 8.1 Prometheus + Grafana

**当前**：Bellkeeper 暴露 `/metrics`，但无 Grafana 抓取。

**实施**：
- 新增 bundle `bundles/observability/`（Prometheus + Grafana + Loki 可选）
- 抓取目标：Bellkeeper、n8n、Meilisearch、NATS、Postgres exporter
- 看板模板：
  - SilkSpool 全局概览（HTTP QPS、错误率、延迟、容器健康）
  - Bellkeeper 内部（LLM Proxy 各渠道、CrawlQueue、Meili 索引、Matrix Gateway）
  - n8n 工作流（每个工作流的执行次数 / 成功率 / 时长）

### 8.2 容器健康深化

**当前**：O04-container-health 工作流监控容器存活，但无资源压力检测。

**实施**：
- 集成 `cAdvisor`（Prometheus 抓取）获取 CPU/内存/IO
- O04 增加资源告警阈值（CPU > 80% 5 分钟、内存 > 90%、磁盘 > 85%）
- 告警发到运维频道，附带最近日志摘要

### 8.3 备份验证

**当前**：O05-auto-backup 执行备份，但无定期恢复验证。

**实施**：
- 每月一次自动恢复验证：到测试环境恢复最近一份备份，跑健康检查
- 验证失败发 Matrix 告警

---

## 9. 知识库 MVP 演进 (P3)

### 9.1 K07 端到端验证

**任务**：
- 编辑 Obsidian Vault 笔记 → LiveSync → CouchDB `_changes` → K07 触发
- K07 重写为「文件回流」适配器：从 CouchDB 拉取变更 → 写入 `working/` 或 `pkb-assets/`
- 验证：编辑 → 5 分钟内出现在 `/knowledge/files` 列表

### 9.2 智能归档建议

**实施**：
- 后台任务每周扫描 `working/` 中超过 30 天未访问的文档
- LLM 评估文档「值得沉淀到 PKB 吗？」→ 高分文档列表推送到 Matrix `digest` 频道
- 用户在 Bellkeeper Web 一键归档（移动到 `pkb-staging/`，再人工整理进 Obsidian）

### 9.3 文件级权限标签

**实施**：
- frontmatter 增加 `access: public | private | shared` 字段
- 检索/问答时根据当前用户身份过滤
- Matrix 通知避免泄漏 private 文档

### 9.4 存量知识导入

**实施**：
- OWASP / MITRE ATT&CK / 各厂商安全文档批量导入到 `KNOWLEDGE/security/`
- 导入工具：`lib/tools/bulk_import.py` 接受 URL 列表或 sitemap
- 入库后建立专门 Collection，问答时可指定范围

---

## 10. 收敛与里程碑

### 一个月内（2026-06）
- [ ] §1 RAGFlow 全部退役（代码 + 工作流 + 配置）
- [ ] §2.2–§2.7 LLM Proxy 对标 new-api（Token + 定价 + Gemini + Rerank + Dashboard）
- [ ] §2.8 停掉 new-api 容器
- [ ] §3.1 §3.4 n8n 链路压缩 + 死代码回收
- [ ] §5.1 §5.3 爬取队列前端 + 问答多轮 + 流式

### 二个月内（2026-07）
- [ ] §4 日志中心全文检索 + 告警增强 + trace_id
- [ ] §6.5 §6.6 Bellkeeper 测试覆盖到 60% + golang-migrate
- [ ] §7 Rerank + 引用跳转 + 上下文压缩
- [ ] §8.1 Prometheus + Grafana 基础

### 三个月内（2026-08）
- [ ] §5.7 §5.8 Vault 在线编辑 + 批量操作
- [ ] §9 K07 端到端验证 + 智能归档建议
- [ ] §8.2 §8.3 容器健康深化 + 备份验证

---

## 维护规则

1. 每次完成一项时：
   - 在 ROADMAP 对应任务前打勾 `[x]`
   - 在 [STATUS.md](STATUS.md) 「最近主线动作」表追加一行
   - 重要架构变化更新 [architecture/overview.md](architecture/overview.md)

2. 新增任务时：
   - 按 P0/P1/P2/P3 评估优先级（影响范围 + 紧迫度）
   - 在对应章节追加，不另开新文档

3. 任务取消时：
   - 不删除，加 `~~删除线~~` + 简短理由
   - 三个月后清理整理

4. 当 ROADMAP 一个章节全部完成：
   - 移动到 STATUS.md 「最近主线动作」+ 「已完成里程碑」
   - 从 ROADMAP 移除
