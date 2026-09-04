---
name: sec-runtime-discipline
description: 运行环境公共纪律——代理出口/授权边界/派单/interval 任务/失败留痕/大输出摘要/日期标签。所有定时任务与执行会话默认遵守（单一事实源，任务 objective 不再内联重复）。
---

# 运行环境公共纪律

1. **出口**：一切出网走代理池网关 http://127.0.0.1:8899（scope.yml defaults.egress_proxy）。run_cli 已模板化代理；手工 curl 必须显式 http_proxy=https_proxy=http://127.0.0.1:8899；开局 proxy_pool_stats 确认 active，失效代理用 proxy_pool_report_bad 上报；禁止任何直连出网。
2. **授权**：scope.yml 是唯一权威（开工必读当前清单，严禁依赖提示词内联的历史清单/数量）；scope-guard fail-closed，边界外工具层直接拒绝，严禁绕过；max_risk=active，intrusive 一律一次性人工确认，禁挂周期。资产收集发现疑似 scope 外但归属证据明确的新资产（CNAME 指向授权资产/品牌印证/收购关系）→ 必须 `approval_request kind=scope-domain` 提请人工审批（subject=域名、program_name=归属项目、evidence≥10 字证据、equity_basis/independent_src/corroboration 按表单填写——判据口径见 rules/src/equity-gate.md 股权闸：默认不入池=参股/战略/财务投资/合资非100%/联营，independent_src=有→不并入本项目）；批准前目标依旧全拒绝，不要尝试打点；禁止只写事实不提请求，也禁止把归属不确定的资产凑数提请。scope-domain 批准后系统自动入队首轮资产收集种子任务（objective 带 `[审批入队]` 前缀，只做资产收集禁漏洞探测），无需手工派单。项目排除清单内的域名若掌握新归属证据 → `approval_request kind=exclude-exception` 提请排除例外评估（批准=移出排除+并入 scope+留 durable fact 记录判据）。
3. **派单**：spawn_worker 批量必须小批量短超时——单批 ≤3 目标、timeout ≤600s；禁止 ≥1500s 大单阻塞（父 worker 预算 3600s 硬上限，阻塞等子=烧自己预算）；跑不完记台账留次日，逐日增量推进。
4. **interval 任务**：一行固定实体，跑完自动续排（latest-only）；严禁 task_create 次日 once 模拟周期。
5. **失败留痕**：失败/被杀 run 先读 results/<run_id>/meta.json（exit_code/duration）再处置——数据多已落盘，可幂等重跑；onnxruntime 的 pthread_setaffinity 报错为良性噪声，不是失败信号。
6. **大输出**：一律 grep_result/page_result 摘要取，禁止在会话铺全文；nuclei 等大输出默认取命中行。
7. **日期标签**：日报/黑板键/台账文件名统一 YYYY-MM-DD；定时任务收尾 task_update 的 **note 必须以【{项目}·{角色}·MMdd】开头**（如【美团·vuln·0828】），保证看板执行历史左侧标题一眼可分辨哪天哪个任务。
8. **黑板**：环境故障查 [env-issue] 前缀键（现行有效才参考）；存活清单/台账不内联进 objective，以黑板/facts 实时记录为准。
9. **事实生命周期**：note 类=agent 工作速记（ephemeral，14 天滚动消亡）——失败记录/当日结论/临时观察写 note；**长期知识必须写 target/asset/finding 等分类**（durable，30 天复验，被引用即续期）；带明确时效的事实用 intent.ttl_days 显式声明。禁止把需要长期保留的知识写进 note（14 天后会被 sweeper 归档）。
