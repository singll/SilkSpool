// ==============================================================================
// @silksec/ui-panel — host half (no-op)
//
// 看板主面板（16-dashboard P1）的宿主半面。存在的唯一目的：让本包成为 profile 的
// Loader entry，从而 dsh-client-modules 扫描到它，并把 exports["./client"] 作为
// 客户端 bundle 经 /plugins/@silksec/ui-panel/client.js 提供给浏览器。
//
// 客户端半面（client.js）把看板挂到 DSH 官方预留的一级页面通道：
//   - main keyed 槽（root）→ DashboardPanel（通用渲染器，消费 ui-core viewRegistry）
//   - sidebar.panellist（list）→ PanelIcon（侧边栏「看板」导航行）
//   - ctx.layout.selectPanel('silksec-dashboard') / selectPanel(null) 打开 / 返回
//   - ctx.layout.beginNavigation() AbortSignal 处理快速连点竞态
//
// 跨 bundle require 时序：在 package.json dsh.client.inject 声明
// "@silksec/ui-core"（视图注册表内核）与 layout/sidebar（槽声明方）；
// 宿主先送达这些行，本包 factory 物化时 require 命中。
// ==============================================================================

export default {
  name: 'silksec-ui-panel',
  inject: [],
  apply() {},
}
