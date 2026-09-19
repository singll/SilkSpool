// ==============================================================================
// @silksec/ui-approval — host half (no-op)
//
// 审批套件（16-dashboard P2）的宿主半面。存在的唯一目的：让本包成为 profile 的
// Loader entry，从而 dsh-client-modules 扫描到它，并把 exports["./client"] 作为
// 客户端 bundle 经 /plugins/@silksec/ui-approval/client.js 提供给浏览器。
//
// 客户端半面（client.js）挂 DSH 官方承载面：
//   - shell.overlay（list/root）→ 「待审批 · N」通知胶囊 + 快捷处理浮卡
//   - ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })（阶段一）
//   - sidebar.right.pane.tab / .title（keyed，key=类型 id）（阶段二）→ 完整审批中心
//   - 降级：sidebarRightTabs 缺席 → 主面板临时 tab；shell.overlay 缺席 → secUiBus 徽章
//
// 跨 bundle require 时序：package.json dsh.client.inject 声明
// "@silksec/ui-core"（令牌/hooks/注册表/微事件）与 layout / sidebar-right
// （槽声明方与 sidebarRight*/服务方）；宿主先送达这些行，本包 factory 物化时命中。
// ==============================================================================

export default {
  name: 'silksec-ui-approval',
  inject: [],
  apply() {},
}
