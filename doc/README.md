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
| [DECOUPLING-PLAN.md](DECOUPLING-PLAN.md) | 解耦与集成改进方案：Resource 模型、Bundle 轻契约、P0-P3 路线图 |

## 相关项目

| 项目 | 说明 |
|------|------|
| SilkSecAgent | 漏洞发现平台，已拆分为独立项目 |
| [SilkRDP](https://github.com/singll/SilkRDP) | RDP 双路径安全接入网关，独立仓库 |
| [Bellkeeper](../../Bellkeeper/doc/) | 知识管理系统，独立仓库 |

## 架构决策记录 (ADR)

| 编号 | 标题 |
|------|------|
| [0001](../docs/adr/0001-known-hosts-verification.md) | SSH Host Key Verification via Known Hosts |

> V1→V2（Bash/Python → Go 单体二进制）重构已全部完成，迁移过程详见 git 历史。

---

## 文档维护规则

1. **SilkSpool** 只保存 IaC 工具文档、通用 bundle 开发指南和本仓库的能力说明。
2. 产品项目的代码与文档（SilkSecAgent、SilkRDP、Bellkeeper）由各自仓库维护；本仓库只保留外部链接。
