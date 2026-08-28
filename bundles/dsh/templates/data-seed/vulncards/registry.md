# VulnCard 注册表

> 卡片 = 单漏洞的探测/验证规程，版本化、可迭代、被强制使用。
> 设计规范见 SilkSpool 仓库 `doc/secagent/README.md` §四。

## 使用规则

1. 探测前读卡：`applicable_when` 判适用（不适用→台账 NOT_APPLICABLE+na_reason）；`prerequisites` 不满足→BLOCKED+blocker。
2. 按 `detect.steps` 探测，按 `verify.must_pass` 全过 + `falsification` 逐项排除才算 CONFIRMED。
3. 每次使用落 `card_usage-{date}.jsonl`；实战与卡片有偏差必须记 deviation/suggest。
4. 卡片修订 bump version + 写 changelog；升版触发引用旧版的覆盖记录转 STALE。

## 扩展规则（开放注册，数量不限）

- 新卡即创即用（status: draft），使用 ≥3 次规程稳定或人工评审后转 active。
- 序号向注册表申请（本文件追加一行），不回收废止号。
- ideas/ 子目录放 IdeaCard（未验证思路种子），schema 见 IC-000-template。
- 禁止用 other/misc 兜底分类。

## 卡片索引

| ID | 名称 | 状态 | 版本 | 备注 |
|---|---|---|---|---|
| VC-001 | CORS 任意起源反射 | active | 3 | 美团 #287/#46 实战验证 |
| VC-002 | 子域接管（CNAME/NS/云桶） | active | 1 | |
| VC-003 | 敏感路径暴露 | active | 2 | 含 catch-all 基线差分 |
| VC-004 | XSS（反射/存储） | active | 1 | dalfox 主力 |
| VC-005 | SQL 注入 | active | 1 | sqlmap 低险模式 |
| VC-007 | 未授权访问 | active | 1 | |
| VC-008 | 越权 IDOR（水平/垂直） | active | 1 | 需双账号 |
| VC-009 | SSRF | active | 1 | 盲测需 OOB |
| VC-014 | 信息泄露（JS密钥/sourcemap/备份/云桶） | active | 1 | |
| VC-015 | 登录接口安全 | active | 1 | 无需账号 |
| VC-016 | N-day 组件漏洞 | active | 2 | 含前提前置校验 |
| VC-019 | HTTP 请求走私 Desync | draft | 1 | 多层网关链 |
| VC-020 | WebSocket 安全 | draft | 1 | |
| VC-021 | 配置中心未授权（Nacos/Apollo等） | draft | 1 | |
| VC-024 | Web 缓存投毒/欺骗 | draft | 1 | |
| VC-027 | 数据脱敏检查 | draft | 1 | 配 flows 回扫 |
| VC-029 | 网关路由绕过/URL 解析差异 | draft | 1 | 打 401 网关 |
| VC-034 | 自托管 Supabase/PostgREST 开放数据面 | active | 1 | 08-20 美团战役 retro，6H/4M 实战背书 |

## 已规划未建卡（注册即建）

VC-006 CRLF / VC-010 GraphQL / VC-011 JWT / VC-012 OAuth-SSO / VC-013 文件上传 / VC-017 业务逻辑 / VC-018 中间件暴露 / VC-022 AI 应用攻击面 / VC-023 Cookie 作用域 / VC-025 Host 头攻击 / VC-026 签名与重放 / VC-028 日志监控面 / VC-030 SSTI / VC-031 XXE / VC-032 反序列化 / VC-033 会话管理
