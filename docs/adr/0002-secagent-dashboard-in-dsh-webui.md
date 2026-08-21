# 看板做进 DSH Web UI（slot + remotes），而非自建独立前端

SilkSecAgent 需要一个「看漏洞 / 资产 / 黑板」的看板。我们决定把它实现为 **DSH 客户端 slot 插件**（`@silksec/sec-dashboard`）+ 服务端 sec-suite 注册的**只读查询 / 受控写 Remote**（走 `dsh-api-remotes` / `dsh-api-gateway`），而不是自建独立 React 前端。

理由：DSH Web UI 本身就是 React 应用，且自带 slot 注册表（`dsh-client-ui-slots`）与 Host↔Client 数据通道（`dsh-api-remotes`）；融入后可复用同一 auth-gate 鉴权与单一入口，避免重造鉴权 / Origin 改写 / 额外端口部署面（这些坑我们在 edge 反代上已经踩过两次）。代价是依赖 rc.7 开发者预览版的内部 API，会随版本漂移——由已有的 pin + shim 纪律兜底，最坏重写 client 薄层、数据层（assetDb）不动。

> **落地说明（2026-08-21）**：`dsh-api-remotes` 的 `ctx.remote` 命名空间需整条 TypeScript 双面构建边界（host/client 两套 tsconfig + 生成的 `/remote` 工件），本部署无此构建面。落地改用其**底层同源通道 `connection.rpc`**（host `ctx.connection.rpc.handle(channel, handler, { authority })` + client `ctx.get('connection').rpc.call(channel, endpoint, payload)`）——这正是 `dsh-api-remotes`/`dsh-api-gateway` 的传输底座，也是生产在用的 `dsh-bill` 的同款实现，零新增依赖、零构建边界。看板写路径直接复用 `assetDb.updateFinding` / `factUpsert`，保证「一份校验、一条 audit.jsonl、一个真相源」。

## 备选方案（被否决）

- **自建独立前端**：需重造鉴权 + 通信层 + 部署面，违背「简洁、实用」，且与 DSH 会话 UI 割裂；
- **裸 HTTP GET API + edge 反代**：看似"简单 fetch"，但重踩鉴权 / Origin 改写 / 额外端口的坑。
