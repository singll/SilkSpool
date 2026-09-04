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
4. 同一 scenario 已有经验卡时，做补充修正而非另起炉灶。
