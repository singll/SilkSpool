# csp-bypass-test（几乎不交）
> **触发信号**: CSP, 绕 CSP, 单独绕过, XSS 打穿, JSONP, CDN, base-uri, 开场, 不交
> **适用**: 目标有 CSP 想知道绕过后怎么接 XSS 打穿 · **不适用**: 想只报"绕过了 CSP"（单独绕不交，打穿走 xss-test.md） · 索引: rules/src/technique-index.md

> 单独绕 CSP 不交。XSS 打穿走 `xss-test.md`（含 JSONP/CDN/base-uri 开场）。
