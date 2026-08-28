---
name: sec-pipeline
description: 挖掘流水线纪律——覆盖矩阵六态台账、漏洞卡驱动探测、防幻觉输出契约、探索配额、交接包规范。recon/vuln 等执行型任务全程强制使用（与 sec-verification 互补：那边管判定，这边管覆盖与留痕）。
---

# 挖掘流水线纪律（v2.1）

> 设计文档：`doc/secagent-src-mining-optimization.md`（SilkSpool 仓库）。本技能是其执行层摘要。

## 1. 覆盖六态（每个 资产×卡片 组合有且仅有一个终态）

`PENDING` 未测 / `TESTED_CLEAN` 已测无命中 / `CONFIRMED` 已确认 / `FALSE_POSITIVE` 证伪 / `NOT_APPLICABLE` 无攻击面 / `BLOCKED` 条件不足 / `STALE` 结论过期。

- 每次探测动作落一行台账 `data/pipeline/{program}/attempts.tsv`：
  `ts  asset  card_id  card_ver  tool  result  na_reason/blocker  evidence_path  run_id`
- **NOT_APPLICABLE 必须填 na_reason**（no-param-surface/no-auth-feature/static-site/tech-mismatch/…），**BLOCKED 必须填 blocker**（no-credential/egress-unreachable/risk-exceeded/needs-reverse/…）。词表外新值允许，当日报告登记定义；禁止 other/misc。
- 完成一个目标立即写一行，禁止攒批。

## 2. 漏洞卡驱动（data/vulncards/）

- 探测前读对应卡片：按 `applicable_when` 判适用、按 `detect.steps` 探测、按 `verify.must_pass + falsification` 确认。
- 每用一张卡落一条 `card_usage-{date}.jsonl`：`{card_id,card_version,asset,result,deviation,suggest}`。**实战与卡片有偏差必须记 deviation**——那是卡片升版的原料。
- 现有卡不覆盖的漏洞类：注册新卡（draft，骨架见 registry.md），即创即用，当日报告登记。

## 3. 防幻觉输出契约（硬标准）

1. **分母明确**：覆盖率数字必须给分母（文件+行数）；无分母的百分比视为幻觉。
2. **TESTED_CLEAN 也要证据**：命令/时间/响应特征摘要落盘，与 CONFIRMED 同级举证。
3. detect/verify 分离；CONFIRMED 必须过 verify 规程 + ≥2 次复现（换出口）。
4. 结论区禁止词：可能存在/疑似/应该是/理论上/大概率——推测只能进 IdeaCard（data/vulncards/ideas/）或 huntlist，且必须写 verification_requires。
5. **负例即价值**：0 产出日的报告同等重要；禁止为凑产出报噪音。
6. 报告统计数字以台账实际为准（coverage-report.py 生成），禁手填。
7. CONFIRMED 建证据包 `data/evidence/{finding_id}/`：request.txt/response.txt（含时间戳+出口IP）/reproduce.md（含影响场景具体化）/falsification.md/verify-log.md。

## 4. 每日任务结构 = 规定动作 + 自选动作

- **规定动作（必须完成）**：按 brief 执行——覆盖台账 PENDING/STALE 消化、复验到期项、huntlist 前置条件判定、全部留痕。
- **自选动作（必须产出，方向自由）**：≥20% 时间或 ≥3 条 IdeaCard。发散角度：组合/类比/倒置/协议下沉/数据追问/时间维度/生态侧写/白盒镜像。探索产出只进 IdeaCard/huntlist，**不许直接进 findings**（灵感与漏洞之间隔着验证规程）。
- IdeaCard 放 `data/vulncards/ideas/IC-xxx.yaml`，必须写 `verification_requires` 和 `first_testable_when`；开局检查条件是否已满足。

## 5. 工具矩阵（按指纹/形态分派，禁止只跑 nuclei）

- 有参数 → dalfox(XSS)/sqlmap --level 1 --risk 1(SQLi)/arjun(隐藏参数)
- CNAME 外部指向 → takeover 检测；指纹命中组件 → 对应 CVE 模板 + afrog
- 有 GraphQL → graphql-cop；登录框 → VC-015 登录接口安全（无需账号）
- nuclei 产出 info 级默认隔离：finding 候选只看 severity≥low；info 命中记台账不落 finding。

## 6. 合规止损（机器强制，不靠自觉）

够证即停：证明存在即停止，不拖数据、不横向、不扩大；证据中真实用户数据脱敏落盘；绝不用拖库凭据、绝不登真实用户账号、只用自建测试数据；intrusive 一律人工；命中蜜罐特征即退。

## 7. 收尾强制清单（未完成 = 任务失败）

1. 本批所有目标 attempts.tsv 有终态行；2. CONFIRMED 有证据包；3. N/A、BLOCKED 有理由值；4. 当日 idea 已入库；5. handoff 生成且汇总数与台账一致。

## 8. 交接包（每日收尾，`data/pipeline/{program}/handoff-{date}.md`，模板见 data/templates/）

五段固定：状态快照 / 今日动作摘要 / 明日队列（huntlist 带 precondition+ttl）/ 阻塞与求助（按解锁收益排序）/ 数据指针（全部绝对路径）。
