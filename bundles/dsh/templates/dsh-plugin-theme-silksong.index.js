// ==============================================================================
// @silksec/theme-silksong — host half (no-op)
//
// 丝之歌主题（见 bundles/dsh/doc/silksong-theme-design.md）。UI 由 dsh.client
// 客户端半面提供（见 client.js）。宿主半面存在的唯一目的：让本包成为 profile 的
// Loader entry，从而 dsh-client-modules 会扫描到它，并把 exports["./client"]
// 作为客户端 bundle 提供给浏览器（与 @silksec/sec-dashboard 同一模式）。
// ==============================================================================

export default {
  name: 'theme-silksong',
  inject: [],
  apply() {},
}
