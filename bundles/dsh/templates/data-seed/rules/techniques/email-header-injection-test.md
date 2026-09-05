# email-header-injection-test（几乎不交）
> **触发信号**: 邮件头注入, 进号, 改密, 重置链, Host, 默认不写
> **适用**: 发信/重置接口参数能进邮件头时判断算不算洞 · **不适用**: 想拿没进号/没改密的邮件头注入交报告（重置链走 authbypass + http-host-header） · 索引: rules/src/technique-index.md

> 邮件头注入没进号/没改密默认不写。重置链走 `authbypass-test.md` + `http-host-header-test.md`。
