# SRC 资产可挖掘性评级（SABC 打分表）——源自 CyberStrikeAI 实战规则（资产测绘Agent）

> 用途：recon 测绘后给资产打"可挖掘性"分，vuln 任务按 level S→A→B、score 降序取队列。
> 原则：评分只排优先级，不构成授权——授权边界永远是 scope.yml；accept 政策名单只管"SRC 收不收"。

## 打分表（满分 100）

| 维度 | 权重 | 子项 |
|---|---|---|
| A 漏洞价值 | 40 | 数据敏感度 0-15 / 业务核心度 0-15 / 影响可放大性 0-10 |
| B 出洞概率 | 45 | 可交互 0-12 / 功能攻击面 0-12 / 组件脆弱性 0-12 / 历史冷门度 0-9 |
| C 时效加成 | 15 | 新鲜度 0-8 / 活动加成 0-7 |

## 分层

- **S ≥ 75**：优先挖穿（核心业务 + 高可交互 + 有攻击面）
- **A 60-74**：深挖队列主力
- **B 40-59**：常规覆盖
- **C < 40**：仅登记，不主动深挖

## 配套打标（与评分独立但联动）

- **owner 归属**：confirmed（ICP 备案/证书 Organization/whois 强证据）/ suspect（仅 favicon/同 C 段弱证据→挂起不交下游）/ 第三方 SaaS/CDN → 排除。投资公司/已剥离业务/合作方存疑一律 suspect
- **accept 收录政策**（查 facts category=policy 的 accept-list）：full（默认）/ intrusion-only（只报入侵类：通生产 SSRF/可逃逸 RCE/主站后台 getshell/进内网入口/可证核心 SQLi）/ none（暂停收录，可算分但不驱动挖掘）；拿不准从严 none 并注明待确认
- **biz 业务分级**：核心（交易/资金/核心 PII）/ 一般 / 未知
- **state 增量**：new / changed / stable / dead（与上轮对比）

## 深挖队列规则

`owner=confirmed 且 level∈{S,A,B} 且 accept≠none`，按 score 降序逐资产挖穿再走下一个；
accept:intrusion-only 照常挖但仅入侵类才 finding_add，非入侵类留 intel 不提交。
