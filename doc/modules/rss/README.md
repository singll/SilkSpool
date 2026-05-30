# RSS 来源与采集资产

> 本模块只负责 RSS 源种子文件、订阅入口与采集边界。
> 在新的知识模型下，RSS 的职责首先是把外部内容送入 **Layer 1（Raw Capture）**，随后由 Bellkeeper 和工作流把内容落地到文件，再进入 **Layer 2（Working Layer）**。

---

## 当前资产

| 路径 | 作用 |
|------|------|
| [../../rss-sources.json](../../rss-sources.json) | RSS 源种子文件 |
| `scripts/import-rss-sources.sh` | 将种子文件批量导入 Bellkeeper `/api/rss` |

---

## 当前来源类别

`rss-sources.json` 目前主要覆盖：

- 网络安全
- 人工智能
- `.NET`

这些类别只定义“来源资产”的初始分组；真正的提取、分类、标签、摘要、检索与问答由后续 Layer 2 链路负责。

---

## RSS 在新主链中的职责

RSS 模块只负责三件事：

1. **定义来源**：维护 RSS 源种子与分类入口
2. **提供 feed**：由 RSSHub 输出统一订阅流
3. **触发采集**：把候选文章 URL 交给后续文件入库链路

它**不负责**：

- 正文提取质量本身
- 最终知识沉淀
- 直接把内容灌入 RAGFlow 之类的搜索后端

---

## 当前推荐链路

```text
rss-sources.json
  ↓ 导入脚本
Bellkeeper RSS 配置
  ↓
K02-RSS定时采集
  ↓
文章 URL / 标题 / 来源元数据
  ↓
K01-文章智能入库
  ↓
Bellkeeper 文件治理
  ├─ URL 去重
  ├─ Trafilatura 主提取
  ├─ Firecrawl 兜底提取
  ├─ 分类 / 标签 / frontmatter
  └─ raw / working 文件落地
  ↓
TrueNAS `POOL/data/knowledge/raw|working`
  ↓
文件索引 / 搜索 / 问答
```

关键口径：

- RSS 不是直接“进入最终知识库”
- RSS 也不应再写成“直接进入 RAGFlow 数据集后就完成知识沉淀”
- 它首先是外部信息进入系统的**原始采集入口**

---

## 提取器策略

### RSSHub

职责：

- 聚合和规范化订阅源
- 提供统一 feed 入口
- 不承担正文抽取职责

### Trafilatura

默认主力提取器，用于：

- 绝大多数普通文章页
- 成本更低、依赖更轻的正文抽取
- Markdown / 正文清洗优先路径

### Firecrawl

默认兜底提取器，用于：

- JS 重页面
- Trafilatura 提取失败或质量过差
- 结构复杂或需要浏览器渲染的站点

因此当前推荐策略不是“Firecrawl 全量主跑”，而是：

- **RSSHub 负责 feed**
- **Trafilatura 负责主提取**
- **Firecrawl 负责兜底**

---

## 维护边界

| 主题 | 权威位置 |
|------|----------|
| 源列表与导入入口 | 本文档 + `doc/rss-sources.json` |
| 工作流调度与执行 | [../automation/README.md](../automation/README.md) |
| 文件工作层、检索与问答 | [../knowledge/README.md](../knowledge/README.md) |
| Matrix 推送与交互出口 | [../matrix/README.md](../matrix/README.md) |
| 最终知识沉淀与 PKB | [../notes/README.md](../notes/README.md) |

---

## 维护规则

1. `rss-sources.json` 是**种子资产**，用于初始化或重建订阅配置。
2. 运行中的订阅状态、启停和分类映射以 Bellkeeper 侧为准。
3. 这里不重复维护工作流节点细节、摘要逻辑或问答后端实现。
4. 文档口径上，RSS 默认只定义 **Layer 1 入口**。
5. 正文提取策略统一按 **Trafilatura 主力 + Firecrawl 兜底** 描述。
