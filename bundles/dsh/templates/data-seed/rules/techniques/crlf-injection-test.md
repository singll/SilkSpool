# crlf-injection-test（几乎不交）
> **触发信号**: CRLF, 头注入, 换行, Host 毒重置, ghost bits, chr((k<<8)|T), 邮件, 走私, 默认不写
> **适用**: 在 URL/参数里试 CRLF 头注入前先看交不交 · **不适用**: 想拿纯 CRLF 头注入交报告（默认不写，转 Host 毒重置/Ghost Bits 邮件走私） · 索引: rules/src/technique-index.md

> 纯 CRLF 头注入默认不写。Host 毒重置走 `http-host-header-test.md`。Ghost Bits 邮件/走私用公式 `chr((k<<8)|T)`，见 `ghost-bits-cast-test.md`。
