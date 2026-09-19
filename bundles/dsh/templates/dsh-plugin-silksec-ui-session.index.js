// ==============================================================================
// @silksec/ui-session — host half (no-op)
//
// 会话内绑定套件（16-dashboard P5）的宿主半面。存在的唯一目的：让本包成为 profile
// 的 Loader entry，从而 dsh-client-modules 扫描到它，并把 exports["./client"] 作为
// 客户端 bundle 经 /plugins/@silksec/ui-session/client.js 提供给浏览器。
//
// 客户端半面（client.js）挂 DSH 官方会话承载面，全部 additive：
//   - conversation.view（list/session）→ ViewTab「安全产出」+ 会话内整页视图
//   - conversation.session.header.utilities（list/session）→ 本会话安全产出计数钮
//   - conversation.chat.assistant-actions（list/session，owner { messageId }）
//     → 「登记候选漏洞」「沉淀事实」
//   - 降级：任一会话槽缺席 → 不注册该面（会话面无全局影响，不改变主面板 11 视图）
//
// 跨 bundle require 时序：package.json dsh.client.inject 声明
// "@deepseek-ai/dsh-client-ui-conversation"（view/header 槽声明方）与
// "@deepseek-ai/dsh-client-ui-chat"（assistant-actions 槽声明方）与
// "@silksec/ui-core"（令牌/hooks/注册表/微事件）；宿主先送达这些行，本包 factory
// 物化时命中。写操作走 /silksec-domain（vuln.register_candidate / fact.upsert，actor=dashboard）。
// ==============================================================================

export default {
  name: 'silksec-ui-session',
  inject: [],
  apply() {},
}
