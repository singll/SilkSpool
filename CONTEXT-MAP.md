# Context Map

SilkSpool 仓库只包含一个领域上下文：远程主机运维编排。

## Contexts

- [SilkSpool（运维编排）](./CONTEXT.md) — 远程主机编排工具：Host / Bundle / Stack / Service / Sync 等。

## 外部项目

以下项目已从 SilkSpool 仓库拆出，拥有独立的代码、文档和版本节奏，不在本仓库维护：

- **SilkSecAgent**：授权范围内的漏洞发现平台（独立仓库）。
- **SilkRDP**：RDP 双路径安全接入网关（独立仓库 `singll/SilkRDP`）。
- **Bellkeeper**：知识管理系统（独立仓库 `singll/Bellkeeper`）；以 product bundle 发布，由 `knowledge-stack` composition 引用，`silkdata` 为只读数据依赖。

SilkSpool 只保留通用的 SSH、同步、备份、服务控制、DNS/站点和 bundle 引擎能力；产品代码和产品文档不进入本仓库。
