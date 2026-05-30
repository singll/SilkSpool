# SilkSpool 文档总览

> 当前有效文档的统一入口。
> 当前口径：Matrix = 控制平面，TrueNAS = 存储平面，Markdown / Obsidian = 知识真相源，自动化 / AI / 检索 = 可选增强层。
> 知识系统优先采用**三层模型（Raw / Working / PKB）+ MVP-first**：先保证核心知识库独立可运转，再逐步叠加采集、AI、检索与控制能力。
> 推荐默认链路：**TrueNAS 承接 raw / working / pkb-assets 文件资产，Windows 本地导入缓冲区承接受控同步，Obsidian 单 Vault 通过 LiveSync 同步；外部工具不直接写 LiveSync CouchDB。**

## 推荐阅读顺序

1. [项目进度](STATUS.md) — 全局状态总览与待办追踪
2. [架构总览](architecture/overview.md)
3. [基础设施](architecture/infrastructure.md)
3. [Matrix 控制平面](modules/matrix/README.md)
4. [存储与同步](modules/storage/README.md)
5. [知识主库：Obsidian / Markdown](modules/notes/README.md)
6. [知识工作层与检索增强](modules/knowledge/README.md)
7. [自动化与编排](modules/automation/README.md)
8. [RSS 来源与采集资产](modules/rss/README.md)

---

## 项目进度

| 文档 | 说明 |
|------|------|
| [STATUS.md](STATUS.md) | 跨仓库全局进度、待办追踪、Bellkeeper 模块详情、文档与实现差异 |

## 架构层文档

| 文档 | 说明 |
|------|------|
| [architecture/overview.md](architecture/overview.md) | 当前整体架构、模块关系与职责边界 |
| [architecture/infrastructure.md](architecture/infrastructure.md) | 主机、网络、IaC、运维红线 |
| [architecture/offline-fallback.md](architecture/offline-fallback.md) | VPN 不可用时的应急访问策略 |
| [architecture/istoreos-headscale-subnet-route-baseline.md](architecture/istoreos-headscale-subnet-route-baseline.md) | iStoreOS + Headscale 子网路由稳定配置基线 |

## 模块层文档

| 文档 | 说明 |
|------|------|
| [modules/matrix/README.md](modules/matrix/README.md) | Matrix 控制平面定位与到 Bellkeeper Matrix 基础设施文档的跳转入口 |
| [modules/storage/README.md](modules/storage/README.md) | TrueNAS 存储分层、同步边界、`data/` 落地结构、应用联动 |
| [modules/notes/README.md](modules/notes/README.md) | Obsidian Vault、LiveSync、笔记规范与模板 |
| [modules/knowledge/README.md](modules/knowledge/README.md) | AI 工作层、检索增强、数据集、模型与问答支撑 |
| [modules/automation/README.md](modules/automation/README.md) | n8n 工作流体系、Bellkeeper 衔接、跨服务编排 |
| [modules/rss/README.md](modules/rss/README.md) | RSS 源配置资产与导入方式 |

---

## 运行依赖资产

- [rss-sources.json](rss-sources.json) — RSS 源种子文件
- `scripts/import-rss-sources.sh` — 将 `rss-sources.json` 导入 Bellkeeper 的脚本

---

## 演进规划

- [ROADMAP.md](ROADMAP.md) — 当前优化方向（LLM Proxy / n8n / 日志 / Bellkeeper 界面与功能）
- [STATUS.md](STATUS.md) — 当前实施状态总览（最新动作、待办、模块成熟度）

---

## 文档维护规则

1. 当前有效文档只放在 `architecture/` 和 `modules/`。
2. 同一主题只保留一份权威文档；其他文档只做摘要并链接过去。
3. `ROADMAP.md` 维护尚未完成的演进方向；完成项写入 `STATUS.md`。
4. TrueNAS / 同步 / 知识架构相关文档以重构后的长期布局为目标，不以旧目录现状作为兼容性约束。
