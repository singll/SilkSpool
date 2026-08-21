// ==============================================================================
// @silksec/sec-dashboard — host half (no-op)
//
// 看板 UI 由 dsh.client 客户端半面提供（见 client.js）。宿主半面存在的唯一目的：
// 让本包成为 profile 的 Loader entry，从而 dsh-client-modules 会扫描到它，
// 并把 exports["./client"] 作为客户端 bundle 经 /plugins/@silksec/sec-dashboard/client.js
// 提供给浏览器。宿主侧真正的数据通道（/silksec-dashboard RPC）在 @silksec/sec-suite。
// ==============================================================================

export default {
  name: 'sec-dashboard',
  inject: [],
  apply() {},
}
