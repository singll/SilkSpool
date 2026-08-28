# Handoff — {program} {date}

> 交接包：下一会话的唯一入口（与次日 brief 配合）。汇总数由 coverage-report.py 生成，禁手填。

## 1. 状态快照（全指针，不内联数据）

- 覆盖视图：`data/pipeline/{program}/coverage-{date}.md`
- 资产台账：`assets-{program}.tsv`（{n_assets} 行）
- 尝试台账：`attempts-{program}.tsv`（{n_attempts} 行，今日 +{n_today}）
- 未闭环：PENDING {n} / BLOCKED {n} / STALE {n}（见覆盖视图）

## 2. 今日动作摘要（≤10 行，每条带证据指针）

-
-

## 3. 明日队列（huntlist，每条带前置条件）

| # | 事项 | precondition | ttl | next_action |
|---|---|---|---|---|
| 1 | | | | |

## 4. 阻塞与求助（按解锁收益排序）

| # | 阻塞项 | 解锁条件 | 可解锁 BLOCKED 数 | 需要谁做什么 |
|---|---|---|---|---|
| 1 | | | | |

## 5. 数据指针（绝对路径清单）

- attempts: `/opt/silkspool/dsh/data/pipeline/{program}/attempts-{program}.tsv`
- 覆盖视图: `/opt/silkspool/dsh/data/pipeline/{program}/coverage-{date}.md`
- 证据包: `/opt/silkspool/dsh/data/evidence/`
- 新 IdeaCard: `/opt/silkspool/dsh/data/vulncards/ideas/`
- 其他:
