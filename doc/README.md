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

## 架构决策记录 (ADR)

| 编号 | 标题 |
|------|------|
| [0001](../docs/adr/0001-known-hosts-verification.md) | SSH Host Key Verification via Known Hosts |

> V1→V2（Bash/Python → Go 单体二进制）重构已全部完成，迁移过程详见 git 历史。

---

## 文档维护规则

1. **SilkSpool** 仅包含 IaC 工具本身的文档（CLI、配置、部署）
2. **Bellkeeper** 相关文档（知识系统、n8n、Matrix、存储等）位于 [Bellkeeper/doc](../Bellkeeper/doc/)
