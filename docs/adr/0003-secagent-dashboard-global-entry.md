# 看板是全局入口（侧边栏 + 模态），不挂会话页

SilkSecAgent 的看板数据（资产/漏洞/事实/任务）是跨会话持久的平台状态，因此看板做成**全局入口**——`sidebar.footer.action`（`scope:root`，任何会话、甚至无会话时都可见）→ primitives `Modal`（headless，~1120px），内部四视图 tab，而不是挂在 `conversation.view`（`scope:session`）标签页下。会话页保持只放会话级内容（消息 / Trajectory）。

## Considered Options

- **`conversation.view`（session 标签页）**：最初实现选了这个，但全局数据被塞进每个对话的标签页里，且必须有会话才看得到——语义错位，故弃用。
- **`settings.section`（全局设置面板）**：shell 免费提供面板+导航，但语义上「看板不是设置」，且面板 content column ~720px 偏窄，弃用。
- **自建全屏 overlay**：空间更大但需自建，且偏离 DSH「面板式全局」风格，弃用。

## Consequences

- 数据通道 `/silksec-dashboard` RPC（`connection.rpc`，ADR-0002 所述）不变；写操作（打标 / 事实纠正）随看板进全局面。
- 挂起项（后续做，见 plan-v5 §6 落地说明）：会话范围指示、跨面跳转（global finding → 会话）、盲区仪表盘、指纹/凭据 tab、打标→eval-cases 自动成评测用例。
