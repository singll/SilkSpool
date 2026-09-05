# hpp-test（几乎不交）
> **触发信号**: HPP, HTTP 参数污染, 同名参数, 污染, 越权, 注入, 本身不交
> **适用**: 同名参数提交后行为变化想判断写哪个洞 · **不适用**: 想拿参数污染本身交报告（按污染导致的越权/注入那个洞写） · 索引: rules/src/technique-index.md

> HTTP 参数污染本身不交。污染导致越权/注入按那个洞写，走 `idor-test.md` / `injection-test.md`。
