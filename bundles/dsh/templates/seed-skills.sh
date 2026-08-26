#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 核心 Skill 种子（幂等：补缺失 + 内容漂移即刷新）
# DSH 用户级技能目录：$DSH_HOME/skills/<name>/SKILL.md
# ==============================================================================
set -euo pipefail

DATA_DIR="${DSH_HOME:-{{BASE_DIR}}/data}"
SKILLS_DIR="$DATA_DIR/skills"

log() { echo "[seed-skills] $*"; }

seed() {
    local name="$1"
    local tmp existed=1
    tmp="$(mktemp)"
    cat > "$tmp"
    if [ -f "$SKILLS_DIR/$name/SKILL.md" ]; then
        existed=0
        if cmp -s "$tmp" "$SKILLS_DIR/$name/SKILL.md"; then
            rm -f "$tmp"
            log "$name 已是最新，跳过"
            return
        fi
    fi
    mkdir -p "$SKILLS_DIR/$name"
    mv "$tmp" "$SKILLS_DIR/$name/SKILL.md"
    [ "$existed" -eq 0 ] && log "$name 已刷新" || log "$name 已写入"
}

seed sec-verification <<'EOF'
---
name: sec-verification
description: 验证铁律——任何漏洞结论必须有可回溯证据+对抗性自检，否则视为幻觉打回。所有漏洞判定/报告场景强制使用。
---

# 验证铁律

1. **任何漏洞结论必须附证据引用**：run_id（run_cli 产出）/ flow_id（流量归档）/ burp_item（人工验证）三选一，外加一句话证据摘要。无证据的结论不得写入 finding，不得向用户报告。
2. **判定前必看原始输出**：用 grep_result/page_result 核对 run_id 的原始响应，确认状态码、响应特征与结论一致。扫描器报"存在"不等于存在。
3. **误报典型特征**（命中即降级为"待人工"）：仅匹配到关键词但无实际行为差异；目标返回的是错误页/通用 WAF 页；POC 回显出现在报错堆栈而非业务响应。
4. **带外漏洞**（SSRF/RCE 回连类）必须有 dnslog/回连记录佐证，禁止仅凭"请求发出去了"下结论。
5. finding_add 的 evidence 字段为空 = 违反本铁律，复盘时会被打回。

# 对抗性自检（高危结论强制，中低危建议）

6. **自扮攻击者找反证**：结论写入前问"什么情况下这个结论是错的？"——列出 ≥2 个反证假设并逐一用证据排除。常见反证面：响应差异来自 WAF/CDN/负载均衡基线而非漏洞？重放 3 次是否稳定复现？对照组（未授权/无参/其他路径）请求是否有同样特征？时间类判定（时延注入）是否排除了网络抖动？反证无法排除 → 降级 tentative 或标记"待人工"。

# 多路独立复验（高危且条件允许时必做）

7. **高危 finding 派 spawn_worker 独立复验**：用全新上下文把同一假设交给另一个 worker 验证（不同上下文=天然多视角，等效多路高温投票）。两路结论一致 → confirmed；分歧 → 降级 tentative，分歧点写进 finding 的 evidence 备注。批量资产不适用（成本），只用于高危/将写报告/将提交 SRC 的结论。
EOF

seed sec-blackboard <<'EOF'
---
name: sec-blackboard
description: 黑板纪律——跨会话共享事实的读写规范。任务开局读黑板，过程中即时写凭据/存活/已试路径，避免重复劳动和状态丢失。
---

# 黑板纪律

1. **开局必读**：任务开始先 blackboard_get 读全盘 + asset_query 看目标已有资产，不重复已完成的工作。
2. **即时写**（发现即写，不等任务结束）：
   - 凭据/会话：`cred:<host>:<role>` = 凭据引用（**只写 .env 变量名或"见凭据库"，绝不写明文密码**）
   - 存活状态：`alive:<host>` = 端口/标题/时间
   - 已试路径：`tried:<host>:<path>` = 结果（避免重复 fuzz）
   - 中间结论：`note:<target>:<topic>` = 一句话结论
3. **WAF/风控发现立即写**：`waf:<host>` = 厂商/行为特征，后续任务据此调整策略。
4. 黑板是事实不是推测：只写验证过的状态，推测写进会话讨论。
EOF

seed sec-review <<'EOF'
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
EOF

seed sec-task <<'EOF'
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
   禁止 ≥1500s 的大单阻塞。跑不完的资产记黑板台账（coverage-ledger）留次日，定时任务逐日增量推进，不追求单日全覆盖。
7. 定时任务的执行由 spawn_worker 完成，执行会话自动归入对应工作区，结果写在任务 result + 执行历史里（看板可跳链查看）。
EOF

log "Skill 种子完成"

seed sec-knowledge <<'EOF'
---
name: sec-knowledge
description: 记忆治理纪律——写记忆前三问、开局检索、用完回执、用到即复验、规则先验层加载。所有执行型角色开工/收尾时使用。
---

# 记忆治理纪律（memcore）

记忆分三层，写入前必须回答"三问"并把答案写进 justification（≥10字，非占位）：

1. **它会过期吗？** → 会：黑板/事实（ephemeral ≤30天 或 durable 需复验）；不会且换目标仍有用：才配进经验卡
2. **换目标还有用吗？** → 只对特定目标有用：进 facts/finding，**禁止进经验卡**；可迁移方法论：才进 exp_store
3. **谁会读它？** → 执行任务要读：ephemeral/durable；只有复盘要看：timeline（带日期快照键）

## 类别速查

| 内容 | 去处 | mem_class |
|---|---|---|
| 环境故障/工具异常 | 黑板 `[env-issue]` 前缀 key | ephemeral（TTL 自评 1-30 天） |
| 存活清单/扫描台账/调度流水 | 黑板带日期键 | timeline（只追加，不改写） |
| 目标事实（指纹/配置/负结果） | fact_upsert | durable（30天复验）或 note 类 ephemeral |
| 可迁移方法论 | exp_store | candidate 起步，附 justification |
| 成功调用链 | pb_save | permanent，附 justification |

## 规则先验层（data/rules/）

命中技术栈（指纹/fp_add）后、上专项扫描前：查 `data/rules/<域>/<栈>.md` 是否存在（如 web/spring.md、web/nextjs.md、web/selfhosted-supabase.md、php/thinkphp.md），存在则读入作为该栈审计先验（入口点模式/特有攻击面/验证要点）。这层是**人工蒸馏的静态先验**，与 memcore 经验卡（实战后验）互补：先验给方向，后验给打法。复盘时发现某栈规则缺失或有新心得 → 在复盘报告里提议新增/修订规则文件（人工评审后落盘，agent 不自写规则层）。

## 流程纪律

- **开局**：exp_search 按目标画像检索 → 命中 high 置信卡先读后干；blackboard_get 查 `[env-issue]` 前缀键（现行有效才参考）
- **用完卡**：必须 exp_feedback 回执（useful/adopted/wrong/outdated）——不回执的卡会被判零使用而沉没
- **cooling 标记**：检索结果带 _cooling 的事实用到即复验（exp_validate 或 fact_upsert 刷新），复验通过自动复活
- **沉淀前查重**：exp_search 同场景 → 命中则补证据/改 takeaway（exp_update），不另起炉灶
- **红线**：故障/状态/日期清单禁止写进 persona/objective；timeline 键禁止改写（换新键）
EOF

# ---------- 规则先验层（data/rules/，人工蒸馏静态规则，详见 sec-knowledge 技能） ----------
seed_rule() {
    local rel="$1"
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp"
    if [ -f "$DATA_DIR/rules/$rel" ] && cmp -s "$tmp" "$DATA_DIR/rules/$rel"; then
        rm -f "$tmp"; log "rules/$rel 已是最新，跳过"; return
    fi
    mkdir -p "$DATA_DIR/rules/$(dirname "$rel")"
    mv "$tmp" "$DATA_DIR/rules/$rel"
    log "rules/$rel 已写入/刷新"
}

seed_rule php/thinkphp.md <<'EOF'
# ThinkPHP 审计先验

## 入口点模式
- 兼容模式路由：index.php?s=/module/controller/action（5.x 历史 RCE 面）
- 多应用模式（6.x）：app 目录遍历 + 路由注释

## 特有攻击面
- 5.0.x/5.1.x 远程代码执行（method/__construct 过滤器链，payload 已模板化进 nuclei/afrog）
- 6.x 反序列化链（League/Flysystem 链为主）
- debug 模式：trace 页泄露（绝对路径/SQL/配置）、app_debug=true 指纹
- 数据库日志文件直连下载（runtime/log/）

## 验证要点
- 指纹先用 nuclei shiro-detect 类模板确认框架与版本段，再选 payload 代际（5.0 与 5.1 payload 不通用）
- 报错页含 "ThinkPHP V5.x" 字样=版本指纹直接可读
EOF

seed_rule web/nextjs.md <<'EOF'
# Next.js / Node 全栈审计先验

## 入口点模式
- pages/api/* 或 app/api/*/route.ts（App Router）：默认无鉴权，鉴权全靠手工
- Server Actions（"use server"）：公开可 POST，$ACTION_ID 枚举可得——参数校验全靠自觉，是越权/注入高发面
- middleware.ts：只做"边缘"拦截，可被 x-middleware-subrequest 头绕过（CVE-2025-29927，多个版本）

## 特有攻击面
- /_next/data/<buildId>/<path>.json 直接拉 SSR props（可能含服务端数据泄露）
- next/image 的 url 参数 SSRF（未配 remotePatterns 白名单时）
- 环境变量：NEXT_PUBLIC_ 前缀进客户端 bundle（可 grep JS），但"服务端变量写进 NEXT_PUBLIC_"是常见翻车
- 静态分析 JS bundle 拿内部 API 端点/网关命名（我方卡 #3 已验证此法有效）
- JWT/session：iron-session/next-auth 默认配置弱点（弱 secret、算法混淆）

## 验证要点
- Server Action 响应 200 且含表单数据回显 ≠ 漏洞，必须验证副作用（数据变更/越权读取）
- middleware 绕过判定：对比带/不带 x-middleware-subrequest 头的响应差异
EOF

seed_rule web/selfhosted-supabase.md <<'EOF'
# 自托管 Supabase 审计先验（源自实战卡 #3，已验证有效）

## 识别与确认
- 五端点差分：/rest/v1/ /auth/v1/ /storage/v1/ /graphql/v1 /realtime/v1 全返 401/400 = 真实实例（非反代巧合）
- 前端 JS 内嵌 SUPABASE_URL + anon JWT（chatId/deployId 等参数联动可确认归属）

## 特有攻击面
- anon key 不是密码：RLS 未开启的表 anon 直读直写（PostgREST 默认允许）——逐表枚举 /rest/v1/<table>
- service_role key 泄露 = 全库上帝权限（搜 bundle 里的 service_role/sb_secret）
- JWT secret 每实例独立：别拿别处的 anon key 套（跨实例不通用）
- /auth/v1/signup 开放注册 → 拿合法用户 token 再测登录态接口
- Storage 桶匿名读写：/storage/v1/object/public/<bucket>/

## 验证要点
- 401 是"实例存活"证据不是漏洞；RLS 判定必须实际读到行数据
- 宿主平台（低代码/nocode 平台）与 Supabase 实例是两层：平台 key 映射实例需逐对确认
EOF

seed_rule web/spring.md <<'EOF'
# Spring / Spring Boot 审计先验（语言框架规则·末段漏洞判定另见具体漏洞卡）

## 入口点模式
- 控制器注解族：@RequestMapping/@GetMapping/@PostMapping + 类级路径前缀拼接；@RestControllerAdvice 不改路由
- 隐式入口：/actuator/*（env/heapdump/refresh/gateway/routes 是重灾区）、/error 页、Spring Cloud Gateway 路由表
- 路径匹配差异：antMatchers 与 mvcMatchers 对尾斜杠/分号路径/大小写处理不同——鉴权配置用 antMatchers 而控制器容忍变体 = 绕过高发点

## 特有攻击面
- SpEL 注入：@Value/@PreAuthorize 拼接用户输入、Spring4Shell（CVE-2022-22965，JDK9+ + WAR 部署 + 特定绑定）
- Jackson/Fastjson 反序列化：@RequestBody 多态类型（@type/enableDefaultTyping）
- Actuator：heapdump 直下（内存里常有密钥/会话）、env 脱敏绕过（/actuator/env 老版本）、gateway POST /actuator/gateway/routes 加恶意路由 = RCE
- JSP/Thymeleaf SSTI：模板名拼接用户输入
- 鉴权顺序：Filter 链 vs Interceptor vs @PreAuthorize 的执行顺序错位；permitAll 通配过宽

## 验证要点
- 403 是 WAF 还是 Spring Security？看响应头/错误体指纹，别误判
- actuator 存在 ≠ 可用：逐个端点试，看 management.endpoints.web.exposure.include 配置痕迹
EOF
