# Context Map

SilkSpool 仓库包含两个不同的领域上下文：

## Contexts

- [SilkSpool（运维编排）](./CONTEXT.md) — 远程主机编排工具：Host / Bundle / Stack / Service / Sync 等。
- [SilkSecAgent（网络安全平台）](./bundles/dsh/CONTEXT.md) — 授权范围内漏洞发现平台，以 DSH（DeepSeek Harness）为底座，通过 `bundles/dsh/` bundle 部署。

## Relationships

- **SilkSpool → SilkSecAgent**：SilkSpool 作为运维层，通过 `bundles/dsh/` bundle 安装、升级、纳管 SilkSecAgent 的运行态（systemd 服务、数据目录、插件装载）。
- 两个上下文共享 `docs/adr/`（系统级架构决策）；SilkSecAgent 的领域语言与设计记录在 `bundles/dsh/CONTEXT.md` 与 `doc/dsh-secagent-plan-v6.md`。
