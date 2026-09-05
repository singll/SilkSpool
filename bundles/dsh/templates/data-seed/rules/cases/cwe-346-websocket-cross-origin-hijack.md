# 案例：实时通道 WebSocket 握手不校验 Origin、跨站劫持他人长连接（高危）

> 来源: https://www.christian-schneider.net/CrossSiteWebSocketHijacking.html · CWE: 346 · 首发年份: 2013
> 关联: rules/techniques/websocket-test.md · VC 卡: 无

## 模式（什么形状的目标会有这洞）
聊天/通知/协作/实时行情走 WebSocket，握手鉴权只靠 Cookie——浏览器对 WS 握手自动带 Cookie，而 WebSocket 不受同源策略约束，服务端又没校验 Origin。开发者以为"浏览器里打开的连接"天然可信，恰好漏了这一环。

## 打法（案例里实际打通的路径）
先确认目标 wss:// 端点握手是否依赖 Cookie。写一个挂在自己域上的页面，用 JavaScript 向该端点发起连接：握手返回 101 即说明受害者浏览器会带着**他的** Cookie 替你完成鉴权。把页面发给在线的受害者，连上后你这条连接就是"他的连接"：收他该收的全部消息、以他的身份上行发消息/执行通道内指令。

## 出什么算成
从自己域的页面连上目标 WS，收到**他人**会话的消息，或能以其身份上行发送。

## 假点（什么样不算）
握手用 URL 签名或 token 且不落在 Cookie（浏览器带不出来）；服务端校验 Origin 拒了跨域；连上后只有公开广播——那是产品设计，不算劫持。

## 为什么值钱（severity 依据）
等于把 CSRF 升级成全双工持续会话劫持，客服/交易通知/协作类通道可长期收发受害者数据，普遍收高危。
