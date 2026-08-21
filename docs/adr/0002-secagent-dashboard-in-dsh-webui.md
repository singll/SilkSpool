# 看板做进 DSH Web UI（slot + remotes），而非自建独立前端

SilkSecAgent 需要一个「看漏洞 / 资产 / 黑板」的看板。我们决定把它实现为 **DSH 客户端 slot 插件**（`@silksec/sec-dashboard`）+ 服务端 sec-suite 注册的**只读查询 / 受控写 Remote**（走 `dsh-api-remotes` / `dsh-api-gateway`），而不是自建独立 React 前端。

理由：DSH Web UI 本身就是 React 应用，且自带 slot 注册表（`dsh-client-ui-slots`）与 Host↔Client 数据通道（`dsh-api-remotes`）；融入后可复用同一 auth-gate 鉴权与单一入口，避免重造鉴权 / Origin 改写 / 额外端口部署面（这些坑我们在 edge 反代上已经踩过两次）。代价是依赖 rc.7 开发者预览版的内部 API，会随版本漂移——由已有的 pin + shim 纪律兜底，最坏重写 client 薄层、数据层（assetDb）不动。

## 备选方案（被否决）

- **自建独立前端**：需重造鉴权 + 通信层 + 部署面，违背「简洁、实用」，且与 DSH 会话 UI 割裂；
- **裸 HTTP GET API + edge 反代**：看似"简单 fetch"，但重踩鉴权 / Origin 改写 / 额外端口的坑。
