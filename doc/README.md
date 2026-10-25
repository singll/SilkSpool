# SilkSpool 文档总览

> **SilkSpool** 是 agentless 的资源编排内核：单 Go 二进制 + SSH + Docker Compose/systemd。
> 现行版本：`spool` 1.2+（P3 按需能力已完成，未启动项见历史方案 §14）。

---

## 现行文档

| 文档 | 说明 |
|------|------|
| [architecture.md](architecture.md) | **现行架构**：Resource 模型、Bundle 轻契约、执行模型、OCI/adopt/API、非目标 |
| [configuration.md](configuration.md) | **配置示例**：`silkspool.yaml`、hosts/bundle_sources、secrets、knowledge-stack/silkdata/Bellkeeper、OCI+cosign、adopt |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署与运维：构建、PATH 软链、升级、plan/apply/rollback、serve、常用命令 |
| [bundle-development.md](bundle-development.md) | Bundle 开发：manifest、composition、product、OCI artifact、adopt、测试 |
| [api.md](api.md) | 本地 HTTP/JSON API、OpenAPI/生成客户端、Go package 参考 |
| [troubleshooting.md](troubleshooting.md) | 常见错误与排查（SSH、sync、plan/apply、OCI/cosign、adopt） |

## 历史文档

已完成的一次性方案移入 [archive/](archive/)，不作为当前操作依据：

| 文档 | 说明 |
|------|------|
| [archive/DECOUPLING-PLAN.md](archive/DECOUPLING-PLAN.md) | 2026-10 解耦与集成方案（P0–P3 已完成；含未启动项判断依据） |

## 相关项目

| 项目 | 说明 |
|------|------|
| [SilkRDP](https://github.com/singll/SilkRDP) | RDP 双路径安全接入网关，独立仓库 |
| [Bellkeeper](../../Bellkeeper/doc/) | 知识治理中台；产品 bundle 在 `Bellkeeper/deploy/`，部署配置见 [Bellkeeper/doc/DEPLOYMENT.md](../../Bellkeeper/doc/DEPLOYMENT.md) |
| SilkSecAgent | 漏洞发现平台，独立仓库 |

## 架构决策记录

| 编号 | 标题 |
|------|------|
| [0001](../docs/adr/0001-known-hosts-verification.md) | SSH Host Key Verification via Known Hosts |

---

## 文档维护规则

1. 现行文档只保留上述六类；一次性 plan/review 完成后移入 `doc/archive/` 或删除（git 保留历史）。
2. 产品项目（Bellkeeper/SilkRDP/SilkSecAgent）的代码与文档由各自仓库维护；本仓库只保留跨项目部署契约与外部链接。
3. 配置示例中的 secret 一律写占位符；真实值只存在于 `hosts/<host>/.env`，不提交。
4. 改 CLI/配置字段时同步更新 `architecture.md`、`configuration.md`、`api.md` 与 `doc/archive/DECOUPLING-PLAN.md` 之外的现行文档。
