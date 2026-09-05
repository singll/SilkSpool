# 案例：注册/资料接口多吃一个字段、直接把自己写成管理员（高危）

> 来源: https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html · CWE: 915 · 首发年份: 2012
> 关联: rules/techniques/idor-test.md · VC 卡: 无

## 模式（什么形状的目标会有这洞）
框架自动把请求数据绑定到对象（Rails/Node 的 mass assignment、Spring 的 @ModelAttribute、PHP 对象注入），开发者只想表单那几个字段，绑定器却来者不拒。判例是 2012 年代码托管平台被打穿：往 SSH 公钥管理接口多塞一个组织字段，把自己的公钥挂到了别人的组织上。

## 打法（案例里实际打通的路径）
先摸对象的全部字段：管理端建用户接口、API 文档、旧版本客户端抓包、报错信息。在注册/改资料/创建类接口的 JSON 里逐个补候选字段：role / isAdmin / admin / verified / tenantId / balance / organization_id。每次只加一个，提交后重查自己的资料或调高权接口看权限是否真变。测完把自己的改回——最小伤害原则见模块。

## 出什么算成
自己账号的高权字段真被写入（角色/认证状态/余额变化，且能改回可证明）。

## 假点（什么样不算）
字段被 schema 白名单静默丢弃、权限不变；只是展示名/头像变了；字段名对了但值被服务端强制覆写。

## 为什么值钱（severity 依据）
一步从普通用户变管理员（或给自己加余额）；判例当年直接击穿开发平台的组织控制，主流框架同型缺陷，高危起步。
