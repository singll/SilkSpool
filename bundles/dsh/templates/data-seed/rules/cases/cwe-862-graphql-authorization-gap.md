# 案例：GraphQL 新接口照抄了对象、没有照抄权限矩阵（高危）

> 来源: https://nvd.nist.gov/vuln/detail/CVE-2022-23739 · CWE: 862 · 首发年份: 2023
> 关联: rules/techniques/graphql-test.md · VC 卡: 无

## 模式（什么形状的目标会有这洞）
同一后端同时暴露 REST 与 GraphQL（或 GraphQL 是后加的新门），权限校验写在 REST 层，GraphQL 的 resolver 漏了同一道闸。判例形态：集成应用经 GraphQL 能碰组织级资源（用户、组织级项目），权限却只按仓库粒度授权——"给了 A 的钥匙，B 的门也开了"。

## 打法（案例里实际打通的路径）
先开 introspection 拿全 schema；被关就用字段建议报错或字典爆破（手法见 graphql-test 模块）。把 REST 里"我知道要权限"的接口在 GraphQL 里找对应 query/mutation。用低权限身份逐个打，重点挑名字像 admin/org/tenant/全局列表的。命中后扩面：同一对象还有哪些字段、哪些关联查询能一起带出来。

## 出什么算成
低权限或未授权身份经 GraphQL 读到/改到了 REST 层明明有权限控制的对象（他人或他组织数据、全局配置）。

## 假点（什么样不算）
GraphQL 与 REST 共用同一套权限层且校验一致；introspection 关闭且 schema 爆破不出（如实写"面打不开"，别编字段）；字段能访问但数据本来就是本人的。

## 为什么值钱（severity 依据）
新门旧锁是结构性缺陷：一个 resolver 漏检就是一类资源泄露。判例 CVSS 9.8，赏金按账号/组织边界被击穿计。
