---
name: sec-task
description: 任务与调度纪律——用户提到「定时/每隔/每天/每小时/定期/复扫节奏」时必须创建带 schedule 的 Task，不得只在会话里口头答应；任务一律绑定当前工作区对应的 Program。
---

# 任务与调度纪律

1. **「定时跑」= task_create 带 interval schedule**：用户意图含「定时/每隔 N/每天/每小时/定期复扫」时，必须调用
   `task_create(objective=..., schedule={kind:"interval",every_seconds:N})`（每天=86400；一次性才用 `{kind:"once",at:<未来毫秒时间戳>}`）。
   创建后任务出现在看板「任务 → 定时任务」卡片区，由调度循环自动执行。**禁止只在会话里口头答应而不建任务**。
2. **周期任务是一行固定实体，严禁每天重建**：interval 任务跑完自动续期（latest-only），系统对同 program+同 objective 的周期任务幂等去重。
   **禁止**用「跑完再建明天的 once 任务」模拟每日周期——这会让任务表堆积垃圾行。每次运行历史自动落入执行历史（看板可见）。
3. **归属自动带出**：不传 program_id 时系统按当前会话所在工作区自动绑定；工作区未绑定 Program 时先 program_list 确认再显式传。
4. **intrusive 级目标禁止 interval**：需要人工确认的操作只做一次性任务或当场执行，不挂周期。
5. **改调度用 task_schedule，补跑用 task_run_now**，取消用 task_update(status=cancelled)。
6. **定时任务里 spawn_worker 派单纪律**：父 worker 的执行预算是硬上限（默认 3600s 到点 SIGKILL），
   阻塞等子 worker = 烧自己的预算。批量扫描必须「小批量短超时」：单批 ≤3 个目标、timeout ≤600s；
   禁止 ≥1500s 的大单阻塞。跑不完的资产在 handoff「明日队列」登记 + attempts 台账落 BLOCKED/STALE 终态行，留次日增量推进，不追求单日全覆盖。
7. 定时任务的执行由 spawn_worker 完成，执行会话自动归入对应工作区，结果写在任务 result + 执行历史里（看板可跳链查看）。
