---
name: sec-review
description: 复盘沉淀——任务结束时把 trajectory 蒸馏为经验卡的结构与质量要求。review 角色/任务收尾时使用。
---

# 复盘沉淀

任务结束（或阶段性收尾）时，输出经验卡草稿，结构：

```json
{
  "scenario": "目标画像一句话（CMS/框架/防护）",
  "attempts": [{"tool": "工具+关键参数", "result": "ok|fail", "why": "成败原因", "run_id": "..."}],
  "chain": ["实际打通的调用链"],
  "takeaway": "下次同类目标最值得先做的事（一句话）",
  "evidence": ["run_id/flow_id 列表"]
}
```

质量要求：
1. takeaway 必须可操作（"先做什么/不做什么"），禁止"加强测试"式空话；
2. 失败尝试和成功同等重要——WAF 拦截、误报原因必须记录 why；
3. 无证据的经验卡不入库；
4. 同一 scenario 已有经验卡时，做补充修正而非另起炉灶；
5. 经验卡文本不得含授权目标真实域名/私网 IP（泛化为 target.com，目标事实走 facts——memcore R8 标识符闸会拦）。

# 复盘附加产出（v4.7）

6. **未复核 finding 的严重度校准**：对候选严重度做对抗性复核（独立上下文），覆盖轨迹 `sev: <自报>→<校准值>（依据：…）` 写进 finding reason——口径见 `rules/src/severity-rating.md` 对抗性校准节。
7. **阴性账本覆盖汇总**：fact_search `neg:` 前缀聚合本轮及存量阴性记录，找出"某 host 测过的类很密、没测过的手法族整片空白"的目标，产出补测清单入队或写进复盘报告。
8. **知识覆盖缺口提案**：对照 knowledge-coverage 报告（看板覆盖缺口卡），本轮踩到"想查没查到"的手法面 → 在复盘报告提议新增 rules/cases/ 案例或 techniques/ 模块（走 knowledge-adopt 审批，人工策展后入库）。
