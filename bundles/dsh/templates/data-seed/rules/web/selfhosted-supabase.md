# 自托管 Supabase 审计先验（源自实战卡 #3，已验证有效）

## 识别与确认
- 五端点差分：/rest/v1/ /auth/v1/ /storage/v1/ /graphql/v1 /realtime/v1 全返 401/400 = 真实实例（非反代巧合）
- 前端 JS 内嵌 SUPABASE_URL + anon JWT（chatId/deployId 等参数联动可确认归属）

## 特有攻击面
- anon key 不是密码：RLS 未开启的表 anon 直读直写（PostgREST 默认允许）——逐表枚举 /rest/v1/<table>
- service_role key 泄露 = 全库上帝权限（搜 bundle 里的 service_role/sb_secret）
- JWT secret 每实例独立：别拿别处的 anon key 套（跨实例不通用）
- /auth/v1/signup 开放注册 → 拿合法用户 token 再测登录态接口
- Storage 桶匿名读写：/storage/v1/object/public/<bucket>/

## 验证要点
- 401 是"实例存活"证据不是漏洞；RLS 判定必须实际读到行数据
- 宿主平台（低代码/nocode 平台）与 Supabase 实例是两层：平台 key 映射实例需逐对确认
