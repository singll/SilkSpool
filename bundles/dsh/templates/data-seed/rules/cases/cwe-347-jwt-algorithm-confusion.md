# 案例：JWT 库信任 header 里的 alg 字段导致签名验证绕过（严重）

> 来源: https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/ · CWE: 347 · 首发年份: 2016
> 关联: rules/techniques/oauth-jwt-test.md · VC 卡: 无

## 模式（什么形状的目标会有这洞）
服务端验 JWT 时把"用什么算法"的决定权交给 token 自己的 header（alg 字段），且 RSA 公钥与 HMAC 密钥在同一段代码里混用。典型于自研登录、API 网关的校验中间件。原研究横扫多门语言的主流库——这是库级通病，不止某一家实现。

## 打法（案例里实际打通的路径）
拿一个正常 JWT，解码 header 看 alg 与服务端密钥形态。两条路：一是"无算法"变体——alg 填 none 及其大小写/空白变体，去掉签名后只改 payload 里的角色/用户 ID 再提交；二是算法混淆——服务端用 RSA 公钥验签时，把公钥当 HMAC 密钥用，自己拿同一把公钥签一个 HS256 token 提交。改 payload 只动最小字段（sub 或角色），其余保持原样好对照。探测与判读细节见 oauth-jwt-test 模块。

## 出什么算成
伪造的 token 通过服务端校验，并以篡改后的身份（他人 ID 或高权角色）通过业务接口。

## 假点（什么样不算）
服务端固定算法白名单、不理 header；none 变体被拒且公钥不参与 HMAC 验证；签名绕过成立但业务层还有二次会话校验拦住——如实写"签名绕过成立、业务影响有限"。

## 为什么值钱（severity 依据）
签名是信任根，绕过即任意身份签发；多语言主流库同时中招属供应链级影响，按严重收。
