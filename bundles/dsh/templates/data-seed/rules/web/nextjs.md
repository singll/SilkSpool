# Next.js / Node 全栈审计先验
> **触发信号**: Next.js, Node 全栈, pages/api, app/api, route.ts, Server Actions, use server, $ACTION_ID, middleware.ts, x-middleware-subrequest, CVE-2025-29927, /_next/data, buildId, next/image, remotePatterns, NEXT_PUBLIC_, iron-session, next-auth, 环境变量, JS bundle
> **适用**: 目标是 Next.js/Node 全栈：找无鉴权 API 路由、Server Action 枚举、middleware 绕过、_next/data 泄露 · **不适用**: 非 Node 栈（Java/PHP 走 spring/thinkphp 等框架篇） · 索引: rules/src/technique-index.md

## 入口点模式
- pages/api/* 或 app/api/*/route.ts（App Router）：默认无鉴权，鉴权全靠手工
- Server Actions（"use server"）：公开可 POST，$ACTION_ID 枚举可得——参数校验全靠自觉，是越权/注入高发面
- middleware.ts：只做"边缘"拦截，可被 x-middleware-subrequest 头绕过（CVE-2025-29927，多个版本）

## 特有攻击面
- /_next/data/<buildId>/<path>.json 直接拉 SSR props（可能含服务端数据泄露）
- next/image 的 url 参数 SSRF（未配 remotePatterns 白名单时）
- 环境变量：NEXT_PUBLIC_ 前缀进客户端 bundle（可 grep JS），但"服务端变量写进 NEXT_PUBLIC_"是常见翻车
- 静态分析 JS bundle 拿内部 API 端点/网关命名（我方卡 #3 已验证此法有效）
- JWT/session：iron-session/next-auth 默认配置弱点（弱 secret、算法混淆）

## 验证要点
- Server Action 响应 200 且含表单数据回显 ≠ 漏洞，必须验证副作用（数据变更/越权读取）
- middleware 绕过判定：对比带/不带 x-middleware-subrequest 头的响应差异
