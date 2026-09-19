// ==============================================================================
// @silksec/ui-core — host half (no-op)
//
// 看板 UI 原生面（16-dashboard）的内核包宿主半面。存在的唯一目的：让本包成为
// profile 的 Loader entry，从而 dsh-client-modules 扫描到它，并把
// exports["./client"] 作为客户端 bundle 经 /plugins/@silksec/ui-core/client.js
// 提供给浏览器。
//
// 客户端半面（client.js）提供跨 bundle require 的稳定内核：
//   token 引用表 / SilksecErrorBoundary / useRpc·usePagedQuery / secUiBus /
//   视图注册表（secDashboardViews 等价物）/ 共享组件（Toolbar·EmptyState·DocModal）。
//
// 跨 bundle require 时序：消费方在 package.json dsh.client.inject 声明
// "@silksec/ui-core"，宿主先把本包 factory 送达，消费方 require 时同步物化
// （dsh-client-modules contract：inject = 消费方物化前必须到达的包行）。
// ==============================================================================

export default {
  name: 'silksec-ui-core',
  inject: [],
  apply() {},
}
