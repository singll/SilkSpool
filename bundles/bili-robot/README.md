# Bili Robot 人格版

镜像从 `singll/BilibiliDanmuRobot` 的固定提交构建；主程序通过 Go replace 固定 `singll/BilibiliDanmuRobot-Core` 提交。无需在容器内临时打补丁。

既有配置不会自动开启付费调用。需要参考 fork 的 [配置说明](https://github.com/singll/BilibiliDanmuRobot/blob/feat/persona-events/docs/companion.md) 和 [人格示例](https://github.com/singll/BilibiliDanmuRobot/blob/feat/persona-events/docs/persona-yuqinghuan.md) 在运行时配置中启用 Companion。密钥仅存放在运行时配置，不能提交仓库。

本次 prod 配置使用 Bellkeeper 专用组 `pool-bili-deepseek-paid`，组内仅 `deepseek-direct`（`https://api.deepseek.com`）；专用 token 限定该组。聊天、欢迎、礼物、报时和冷场均使用同一人格。冷场默认 5～6 分钟、最小间隔 15 分钟、每小时最多两次。

调整人格：编辑运行时 `etc/bilidanmaku-api.yaml` 的 `ChatGPT.Prompt`，同步后重启 bili-robot。`-check-config` 校验配置，`-preview-scene` 调用模型生成预览但不发送 B 站弹幕。详见 fork 文档。

升级前备份机器人配置、token 和数据库，保留旧镜像。通过 `spool plan/apply bili-robot prod` 仅部署此 bundle。若回滚到上游版，应同时恢复旧 YAML 和旧镜像，避免旧版忽略长度保护及 Companion 开关。

本次部署验证：Core 全量单元测试及 `go test -race ./...` 通过；CLI 构建、五场景真实模型预览、长昵称/组合 emoji 长度、过期取消、礼物合并和 token 范围检查通过。部署为 generation 7，容器健康且已收到自然触发的回复回显。备份保留在 prod 的 `/opt/silkspool/bili-robot/backups/persona-20261029T141706Z`。

注意：当前 spool 的 plan 会把 apply 自动注入的 `io.silkspool.generation` 和 `io.silkspool.lock-hash` 标签计入 actual 摘要，因此更新后可能仍有 compose_sha256 差异。本次已逐项比较，基础 compose 一致，override 仅这两个标签不同；不应因此重复部署。

2026-10-29 提示词更新（1.2.1-persona）：日常聊天通常不主动提主播，多数回复不用 emoji；爱心、口头禅和句式不按固定格式重复。同步调整共享人格、示例、冷场/报时提示和失败兜底。相关既有测试、CLI/镜像构建和六条连续模型预览通过，预览未发送到直播间。旧配置及数据保存在 `backups/natural-tone-20261029T143249Z`。

2026-10-30 盲盒查询增强（1.2.3-persona）：支持 `10月盲盒` / `十月盲盒`、`本月盲盒`、`今日盲盒` / `今天盲盒`、`本周盲盒`，以及昨天、前天、上周、上月；`盲盒统计` 汇总全部已保存历史。按北京时间的自然日、周一开始的自然周和自然月计算，观众查自己、主播查全直播间，无须迁移数据库。结果改用 `今日数量282个，盈亏+1036.00元`；没有数据时显示 `今日暂无相关记录`。详见 [完整指令说明](https://github.com/singll/BilibiliDanmuRobot/blob/feat/persona-events/docs/blind-box-statistics.md)。

版本固定主程序 `d99011ed656ac5c0f45174e3e1768a2bd2e07199`、Core `e8002bd2ecc0`。Core 全量测试、日期/权限/盈亏回归、Go 1.24 容器内全量 race、CLI 构建及配置校验通过；生产数据库只读副本核对了日/周/月/累计统计。上线前配置、token、SQLite 在线备份和旧镜像标识位于 prod 的 `/opt/silkspool/bili-robot/backups/blindbox-20261030T141010Z`。升级后应同时检查容器健康、WebSocket 鉴权和自然触发的弹幕回显；B 站 `msg=f` 只说明拒绝发送，不提供具体命中原因。
