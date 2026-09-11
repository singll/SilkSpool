// ==============================================================================
// SilkSecAgent 代理池插件（dsh 原生插件，替代原 MCP 模式 mcp_proxy_pool.py）
//
// 架构（spool bundle csai/dsh 统一部署）：
//   csai-proxy-refresh.timer ──每30分钟──▶ proxy-scraper-checker（采集+验证）
//                                         └─▶ proxy_grade.py（分级 → pool.json / live.txt）
//   csai-proxy-rotator.service ──▶ mubeng 本地轮换网关 http://127.0.0.1:8899
//
// v5 切流（13-proxy）：proxy_* 工具由 proxy 域 ToolProjector 零改名接管 + 兼容别名
// （proxy_pool_* → proxy_*）投影；采集/分级链由 silksec-proxy-refresh.service →
// proxy_grade.py --proposal-only → sec domain proxy refresh 接管落池。
// 本插件 6 个 proxy_pool_* 旧工具注册已删旧路径（观察期满），现为无操作壳。
// ==============================================================================

export const name = 'silksec-proxy-pool'
export const inject = ['tools']

export function apply(_ctx) {
  // proxy 域（@silksec/sec-domain-proxy + sec-backend-proxy-file）已全量接管代理池
  // 数据与工具面；本插件保留仅为部署链兼容（proxy-pool-plugin-setup.sh 组装入口），无运行时注册。
}
