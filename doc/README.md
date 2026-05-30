# SilkSpool 文档总览

> **SilkSpool** 是一个轻量级 IaC 编排工具，用于管理多主机部署、配置同步与 Docker 编排。
> 二进制与代码分离部署：`silkspool.yaml` 配置 + SSH 连接到远程主机执行 Docker Compose 操作。

---

## 核心文档

| 文档 | 说明 |
|------|------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署指南：二进制安装、目录结构、用户配置 |
| [REFACTORING.md](REFACTORING.md) | V2 重构计划：Bash/Python → Go 单体二进制 |

---

## 文档维护规则

1. **SilkSpool** 仅包含 IaC 工具本身的文档（CLI、配置、部署）
2. **Bellkeeper** 相关文档（知识系统、n8n、Matrix、存储等）位于 [Bellkeeper/doc](../Bellkeeper/doc/)
