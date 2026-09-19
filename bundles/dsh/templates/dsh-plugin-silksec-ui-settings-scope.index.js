// ==============================================================================
// @silksec/ui-settings-scope — host half (no-op)
//
// 授权范围设置节（16-dashboard P4）的宿主半面。存在的唯一目的：让本包成为 profile
// 的 Loader entry，从而 dsh-client-modules 扫描到它，并把 exports["./client"] 作为
// 客户端 bundle 经 /plugins/@silksec/ui-settings-scope/client.js 提供给浏览器。
//
// 客户端半面（client.js）挂 DSH 官方设置页承载面：
//   - settings.section（list/root）注册「授权范围」整节（id=silksec-scope）
//     → program 列表 / scope.yml 条目管理 / 排除清单 / 凭据引用状态
//   - 降级：settings.section 缺席 → ui-core 注册表（主面板「授权 ·降级」临时 tab）
//     主面板/layout 也缺席 → primitives Modal
//
// 跨 bundle require 时序：package.json dsh.client.inject 声明
// "@deepseek-ai/dsh-client-ui-settings"（settings 域基座 / 槽类型与 scope 服务所在）
// 与 "@silksec/ui-core"（令牌/hooks/注册表/微事件）；宿主先送达这些行，本包 factory
// 物化时命中。写操作走 /silksec-dashboard（与主面板同端点同 actor）。
// ==============================================================================

export default {
  name: 'silksec-ui-settings-scope',
  inject: [],
  apply() {},
}
