# cors（仅技术资料 · SRC 禁用）
> **触发信号**: CORS, ACAO, ACAC, Access-Control, 跨域, Origin, 黑盒, 反射, 不挖, 转向, 注入, SSRF, XSS, RCE, 越权, 未授权业务读, 报告优先级
> **适用**: 看到 CORS 响应头（ACAO/ACAC）想判断是否值得挖 · **不适用**: 想按本篇测 CORS 漏洞本身（SRC 黑盒永久禁用，立刻转注入/SSRF/越权） · 索引: rules/src/technique-index.md

> **永久强制：** SRC 黑盒 CORS **不挖、不测、勿开本篇**（`cors-vuln-report-priority.md`）。看到 ACAO/ACAC → 立刻转注入 / SSRF / XSS / RCE / 越权 / 未授权业务读。写不写只认 `vuln-report-format.md`。
