// ==============================================================================
// @silksec/ui-task — host half (no-op)
//
// 任务套件（19-ui-surface P3）的宿主半面。存在的唯一目的：让本包成为 profile 的
// Loader entry，从而 dsh-client-modules 扫描到它，并把 exports["./client"] 作为
// 客户端 bundle 经 /plugins/@silksec/ui-task/client.js 提供给浏览器。
//
// 客户端半面（client.js）挂 DSH 官方承载面：
//   - ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })（阶段一）
//   - sidebar.right.pane.tab / .title（keyed，key=类型 id）（阶段二）→ 任务中心
//   - conversation.session.header.utilities（list/session）→「本会话任务」计数
//   - 降级：sidebarRightTabs 缺席 → 主面板临时 tab；会话槽缺席 → 不注册
//
// 跨 bundle require 时序：package.json dsh.client.inject 声明
// "@silksec/ui-core"（令牌/hooks/注册表/微事件）与 layout / sidebar-right /
// conversation（槽声明方与服务方）；宿主先送达这些行，本包 factory 物化时命中。
// ==============================================================================

export default {
  name: 'silksec-ui-task',
  inject: [],
  apply() {},
}
