# miniapp-capture-sop（App/小程序抓包 SOP——第二发现面端点来源）
> **触发信号**: 小程序, miniprogram, wechat, 微信开发者工具, 模拟器, 安卓模拟器, 抓包, mitm, 证书, mubeng, xray, 被动扫描, App 端点, servicewechat, wx.request, tt.request
> **适用**: Web 主动爬虫覆盖不到的 App/小程序端点面（katana/gau 对小程序基本无效）——经被动流量把端点/参数喂回系统 · **不适用**: 纯 Web 站点（先跑端点三件套）；未授权目标 · 索引: rules/src/technique-index.md

目标：把 App/小程序的真实业务流量导入 xray/mubeng 代理链，flows 落盘后经 `exec_flow_triage` 信号路由挑出「有趣流量」送研判，端点经 proposal 事件回流 endpoint 域。**端点入库后自动走 H2 污点路由派生假设任务**——抓包不是目的，假设才是。

## 前置（合规红线）

- 目标必须在 program scope 内（scope-guard fail-closed，无旁路）；主动探测受 `rules.max_risk`/QPS 约束。
- 系统**永不自行注册/爆破账号**；需要登录态的小程序功能，先经 cred_add 人工登记凭据引用（明文零入库）。
- 抓包只走系统登记的代理链（mubeng 池 → xray），不引入新工具 manifest。

## 微信小程序路径（推荐）

1. **微信开发者工具**：导入目标小程序包（或体验版扫码），设置 → 代理 → 手动代理 `127.0.0.1:<mubeng_port>`。
2. **证书**：开发者工具信任 xray/mitm CA（设置 → 安全 → 信任证书）；不校验域名合法性开关打开。
3. **过一遍业务面**：登录（用 cred_add 登记的凭据）→ 按业务语义标注（endpoint_annotate_semantics 的 should_auth 清单）优先点高价值功能（支付/订单/用户中心/导出）。
4. **流量落盘**：xray webhook → `exec_flow_append`（机器通道）→ flows/xray-*.jsonl。

## 安卓 App / 模拟器路径

1. 模拟器（或真机同网段）Wi-Fi 代理指向 mubeng 池入口；安装并信任 CA（Android 7+ 需用户证书或目标 App 未做 pinning）。
2. pinning 目标：先只做被动观察（域名/路径收录），不尝试绕过注入（越出授权黑盒边界）。
3. 同样过一遍业务面，重点点是 Web 端没有的功能（App 专属接口/旧版 API）。

## 分流与入库（闭环）

```
exec_flow_append（webhook 落盘）
  → exec_flow_triage（确定性打分：5xx/JSON/敏感参数形态/凭据字样/报错泄露/小程序特征）
  → interesting 流量送 LLM 研判（内容必须 fenceUntrusted 围栏）
  → 端点 proposal → endpoint 入库 → H2 污点路由派生假设任务（预算闸）
```

- `exec_flow_triage` 是零 token 初筛，阈值默认 3；只归档不研判的流量不进队列（防流量淹没）。
- 截图判读：`exec_vision_triage` 传特征（登录表单/管理界面/调试面板/导航高价值项）产隐藏功能点线索，interesting 自动派 H1 假设任务。
- 小程序端点 host 常见 `*.servicewechat.com` 前缀转发形态——路由函数已内置特征识别。

## 产出验收

- flows 文件非空且 `exec_flow_triage` 有 interesting 行；
- 小程序端点经 proposal 入库的证据（endpoint 域 host 含小程序特征）；
- ≥1 条由 flows 线索派生的假设任务（task.intent.derived 事件）。
