// ==============================================================================
// SilkSecAgent 流水线插件（sec-pipeline）— v5 收口后为无操作壳
//
// v5 领域化已完成：本插件原注册的旧原生工具
//   verify_replay / surface_scan / surface_queue
// 已由领域动词接管（零改名 + 语义动词）：
//   vuln_verify_replay（vuln 域 C9 机械复核）
//   endpoint_surface_scan（endpoint 域 Q5 敏感信息回扫，VC-027 打码）
//   endpoint_queue_surface / endpoint_consume_queue（endpoint 域参数面队列）
// 旧的 v4 直连文件/DB 实现已随「一切写入皆命令、一切读取皆查询」删除；
// 本插件保留仅为部署链兼容（sec-pipeline-plugin-setup.sh 组装入口），无运行时注册。
// ==============================================================================

export const name = 'sec-pipeline'
export const inject = []
export const apply = () => {}
