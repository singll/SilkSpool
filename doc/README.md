# SilkSpool 文档总览

> **SilkSpool** 是一个轻量级 IaC 编排工具，用于管理多主机部署、配置同步与 Docker 编排。
> 二进制与代码分离部署：`silkspool.yaml` 配置 + SSH 连接到远程主机执行 Docker Compose 操作。

---

## 核心文档

| 文档 | 说明 |
|------|------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署指南：二进制安装、PATH 软链、目录结构、升级、配置 |
| [troubleshooting.md](troubleshooting.md) | 故障排除：常见错误及解决方案 |
| [api.md](api.md) | API 参考：Go 包文档 |
| [bundle-development.md](bundle-development.md) | Bundle 开发：创建、测试、部署新 Bundle |

## SilkSecAgent（csai）

| 入口 | 内容 |
|---|---|
| [文档导航](secagent/README.md) | 入口与结构（模块契约 / 进度 / 归档） |
| [模块契约 00–19](secagent/README.md) · [进度与更新](secagent/PROGRESS.md) | 当前领域契约；唯一滚动进度与更新日志 |
| [历史归档](secagent/archive/) | 旧架构、历次升级方案与完整记录、会话模板 |

## 架构决策记录 (ADR)

| 编号 | 标题 |
|------|------|
| [0001](../docs/adr/0001-known-hosts-verification.md) | SSH Host Key Verification via Known Hosts |

> V1→V2（Bash/Python → Go 单体二进制）重构已全部完成，迁移过程详见 git 历史。

---

## 文档维护规则

1. **SilkSpool** 保存 IaC 工具文档及本仓库 bundle 的配套设计；SilkSecAgent 以 [模块契约 00–19](secagent/) 为架构真相源，进度与更新统一在 [PROGRESS](secagent/PROGRESS.md) 滚动维护，历史归档在 [archive/](secagent/archive/)
2. **Bellkeeper** 相关文档（知识系统、n8n、Matrix、存储等）位于同级仓库的 [Bellkeeper/doc](../../Bellkeeper/doc/)
