# Brief — {program} {date}

> 开局包：本文件是今日任务的唯一入口，不再自由盘点。未列出的事项不许做（探索配额除外）。

## 一、昨日状态（指针，不内联数据）

- 覆盖视图：`data/pipeline/{program}/coverage-latest.md`（卡片×状态计数以此为准）
- 昨日交接：`data/pipeline/{program}/handoff-{yesterday}.md`
- 负账本抽查配额：5%（随机复验，换出口）

## 二、今日硬指标（规定动作，必须完成）

### recon
- [ ] 子域 diff 三数（新增/漂移/移除，给分母：总数与来源文件行数）
- [ ] 变化雷达：certstream 新子域 / JS bundle hash 变化 → 全部处置（插优先队列）
- [ ] 新增存活资产 100% 形态确认 + L2 接口层收集（katana/waybackurls/gau）
- [ ] 全部动作落 `attempts-{program}.tsv` / `assets-{program}.tsv`

### vuln
- [ ] 优先级队列 Top N（= 资产价值 × 卡片命中率 × 情报热度 × 变化因子）消化
- [ ] 本日指定卡片执行清单：
  | 卡片 | 目标批次 | 预期产出 |
  |---|---|---|
  | （由调度填入） | | |
- [ ] 复验到期 finding（next_verify ≤ 今日）
- [ ] huntlist 前置条件判定 100%（满足的升级执行，不满足的标 blocker，超 TTL 的决断）
- [ ] kb_search ≥2 次（按当日目标指纹）
- [ ] IdeaCard first_testable_when 检查：条件满足的升级进队列
- [ ] nuclei 类扫描 info 级隔离（finding 候选只看 ≥low）

## 三、自选动作（探索配额：≥20% 时间 或 ≥3 条 IdeaCard）

发散角度（至少扫一遍，给角度不给结论）：
1. 组合：两个已确认事实能否组合成新链？
2. 类比：同类厂商/业务的公开 writeup 怎么打的？
3. 倒置：防守方假设反过来会怎样？
4. 协议下沉：HTTP 下面还有什么？（WS/中间件协议/走私/Host 多面性）
5. 数据追问：响应里每个字段从哪来、能被谁影响？
6. 时间维度：面随时间怎么变？（发版/CT 新证书/活动临时面）
7. 生态侧写：供应商/外包/被收购方的系统是否同主体同栈？
8. 白盒镜像：目标用的开源组件源码里这个逻辑怎么写的？

> 探索产出只进 `data/vulncards/ideas/`（IdeaCard）或 huntlist，不许直接进 findings。

## 四、禁止项

- 禁止重跑负账本条目（抽查配额除外）：
- 禁止 info 级噪音进 findings
- 结论区禁止词：可能存在/疑似/应该是/理论上/大概率
- 禁止攒批写台账（完成一个目标立即一行）
- 禁止 intrusive 动作（max_risk=active，越界即停）
- 够证即停：证明存在即停止，不拖数据、不横向
