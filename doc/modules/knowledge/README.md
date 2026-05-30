# 知识工作层与文件检索增强

> 本文档描述 SilkSpool 的 **文件优先工作层、检索、问答与知识增强能力**。
> **定位**：它围绕 Raw / Working / PKB 三层知识模型中的 **Layer 2（Working Layer）** 展开，但不承担知识真相源职责。
> 当前主链路：**RSSHub → n8n (K02/K01) → Bellkeeper CrawlQueue → 文件落盘 `knowledge/raw|working` → Meilisearch 索引 → `!搜`/`!问` 与 Web 检索问答**。

---

## 角色定位

在新的总架构里：

- **Layer 1 — Raw Capture**：保存原始输入、来源元数据与原始文件资产
- **Layer 2 — Working Layer**：承接摘要、标签、分类、检索索引、问答与阶段性整理结果
- **Layer 3 — PKB**：保留经过个人整理的最终知识库（Obsidian Vault）

本模块主要说明 **Layer 2 + 文件派生检索增强**：

- 如何把外部内容先落地为文件
- 如何基于 `raw + working` 建立搜索与问答能力
- 如何把自动化加工结果服务于人工整理

它**不是**：

- Markdown / Obsidian 主库的替代品
- 最终长期知识沉淀的权威位置
- MVP 成立的前提条件

---

## 当前主链路

```text
RSSHub 订阅入口
  ↓
K02-RSS定时采集（n8n）
  ↓
K01-文章智能入库（n8n）
  ↓
Bellkeeper /api/files/ingest/url
  ↓
Bellkeeper CrawlQueue（持久化任务 + Worker 池 + 熔断）
  ├─ URL 去重（DB 三级匹配）
  ├─ Trafilatura 主提取
  ├─ Firecrawl 兜底提取
  ├─ 分类（LLM 驱动）+ 标签匹配
  ├─ frontmatter / 文件命名
  └─ raw / working 落地
  ↓
TrueNAS `data/knowledge/raw|working`
  ↓
Meilisearch 文件索引
  ↓
搜索 / 问答层
  ├─ Bellkeeper Web: /knowledge/search /knowledge/ask
  └─ Matrix: !搜 / !问（M03 → Bellkeeper /api/files/ask）
```

### 三条关键原则

1. **文件优先**：第一落点是 `raw|working` 文件，不是任何向量数据库
2. **索引是派生物**：Meilisearch 索引、问答上下文都从文件派生，可随时重建
3. **问答范围先收敛**：当前阶段只覆盖 `raw + working`，不把完整 PKB 自动并入主链

---

## MVP 与增强层边界

### MVP 核心不依赖本模块

即使没有本模块，系统仍应成立：

- 手动保存原始内容
- Obsidian Vault 手动写笔记
- LiveSync 跨设备同步
- 手动把内容提升到 PKB

### 本模块提供的增强价值

在核心系统成立之后，本模块提供：

- 自动爬取与文件级去重、分类、标签、摘要
- 基于 `raw + working` 的全文检索与 RAG 问答
- Matrix / Web 双入口搜索与问答
- 工作层整理、日报与自动化消费能力

---

## 文件优先的工作层语义

### `raw`

- RSS / 网页抓取后的 Markdown 原文（带 frontmatter）
- 原始来源元数据
- OCR / 转写后的文本原料
- 需要后续筛选与整理的采集结果

### `working`

- AI 摘要
- 阶段性提炼稿
- 标签增强与结构化中间产物
- 日报素材与待沉淀内容

### `pkb`

- 用户人工整理后的最终知识沉淀
- 由 Markdown / Obsidian 单 Vault 承担
- 通过 LiveSync 跨设备同步
- 是否进入检索层属于可选增强，不是主链条件

---

## Bellkeeper 在本模块中的职责

- 文件治理 API（`/api/files/ingest/url`）
- 爬取队列（CrawlQueue）持久化任务、熔断、反爬
- URL 去重与元数据管理
- 提取器策略编排（Trafilatura 主力，Firecrawl 兜底）
- frontmatter、命名、路径与落地规则
- Meilisearch 索引任务编排（`/api/files/rebuild` `/api/files/stats`）
- 搜索 / 问答 API（`/api/files/search` `/api/files/ask`）
- Vault 浏览 API（`/api/knowledge/files/tree|list|read`）
- Web 搜索与问答入口（Knowledge 域）

n8n 继续负责：

- 定时调度（K02 RSS 6/12/18 点）
- 工作流编排（K01/K02/K05/K06/K07/K08）
- 批量投递（K03 手动批量提交）
- 失败重试（K04）
- 通知与机器人路由（B01/M01-M03）

---

## 搜索与问答的默认边界

当前阶段默认只覆盖：

- `POOL/data/knowledge/raw`
- `POOL/data/knowledge/working`

默认入口：

- **Matrix**：`!搜` / `!问`（M03 工作流 → Bellkeeper）
- **Web**：Bellkeeper 知识域（`/knowledge/search` / `/knowledge/ask`）

默认返回：

- 命中文段
- 文件路径（可点跳转 Obsidian Vault）
- 来源 URL
- 相关标签 / 分类

---

## RAGFlow 已退役

| 位置 | 当前状态 |
|------|---------|
| keeper bundle 服务 | 已移除，不再部署 |
| K01 / K02 工作流 | 已去 RAGFlow 调用，仅使用 Bellkeeper API |
| M03 问答 | 走 Bellkeeper `/api/files/ask`，与 RAGFlow 无关 |
| Bellkeeper 代码 | `handler/ragflow.go` + `service/ragflow_*.go` 仍在编译进二进制，路由仍注册，主链不调用；待整体清理 |
| 兼容性 | 不保留向后兼容；旧客户端如调用 `/api/ragflow/*` 返回历史接口，但不再增强 |

详细清理计划见 `../../ROADMAP.md` 的「代码清理」章节。

---

## 与三层知识模型的关系

### Layer 1 → Layer 2

RSS / 网页抓取 / 手工导入进入系统后，先落地文件；随后由本模块完成：

- 标签
- 摘要
- 分类
- 路由
- 检索索引
- 问答支撑
- 日报与工作层整理

### Layer 2 → Layer 3

本模块可以帮助发现值得沉淀的内容，但**不自动等价于 PKB**。

最终进入 PKB 的内容，仍应由用户人工整理、确认、提炼后写入 Markdown / Obsidian 主库。

### 关于 K07

`K07-Obsidian笔记同步` 仍是一个**可选**的知识增强适配器：

- 让部分 PKB 内容回流到检索增强层（只读消费）
- 当前 `active: false`，未端到端验证
- 不是主路径，启用前需做完整链路测试

---

## 当前阶段实施顺序

1. 持续采集落地到 `knowledge/raw|working`
2. 基于落地文件维护 Meilisearch 索引与问答上下文
3. 保持 Obsidian Vault 作为 PKB 真相源，由用户人工整理
4. 完全清理 Bellkeeper 中遗留的 RAGFlow 兼容代码

---

## 与其他模块的边界

- [../rss/README.md](../rss/README.md) — RSS 源资产与采集入口
- [../automation/README.md](../automation/README.md) — n8n 工作流与 Bellkeeper 编排关系
- [../notes/README.md](../notes/README.md) — Markdown / Obsidian 主库与 PKB 规则
- [../storage/README.md](../storage/README.md) — `data/knowledge/raw|working|pkb-assets` 的文件资产基座
