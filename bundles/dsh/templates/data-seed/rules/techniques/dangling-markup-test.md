# dangling-markup-test（几乎不交）
> **触发信号**: dangling markup, 悬空标记, CSRF, token, 半条链, 抽取, XSS 回显, 默认不写
> **适用**: 回显被截断想用悬空标记抽 CSRF/token 时判断要不要写 · **不适用**: 想拿悬空标记半条链交报告（默认不写，现场 XSS 回显走 xss-test.md） · 索引: rules/src/technique-index.md

> 悬空标记抽 CSRF/token 半条链默认不写。现场 XSS 回显仍走 `xss-test.md`。
