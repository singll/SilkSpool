# dns-rebinding-test（几乎不交）
> **触发信号**: DNS rebinding, DNS 重绑定, 不交, SSRF, 过滤绕过
> **适用**: 过滤只校验解析后 IP 想用重绑定绕过时判断去向 · **不适用**: 想拿单独 DNS 重绑定交报告（不交，SSRF 过滤绕过走 ssrf-test.md） · 索引: rules/src/technique-index.md

> 单独 DNS 重绑定不交。SSRF 过滤绕过走 `ssrf-test.md`。
