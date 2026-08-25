#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent Preset 种子（6 角色，幂等：只补缺失）
# 机制：复制已安装的 standard preset 组合，替换 persona 行文本为安全角色人格
# 用户根：$DSH_HOME/.agent-presets/<id>/{agent.cordis.yml, preset.yml}
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PRESET_ROOT="$DATA_DIR/.agent-presets"
STANDARD=$(ls -d "$BASE_DIR"/app/node_modules/.pnpm/@deepseek-ai+dsh@*/node_modules/@deepseek-ai/dsh/config/agent-presets/standard 2>/dev/null | head -1)

log()  { echo "[seed-presets] $*"; }
warn() { echo "[seed-presets][WARN] $*"; }

[ -d "$STANDARD" ] || { warn "standard preset 未找到: $STANDARD"; exit 0; }

# mkpreset <id> <显示名> <描述> <人格文本>
mkpreset() {
    local id="$1" pname="$2" desc="$3" persona="$4"
    local dir="$PRESET_ROOT/$id"
    if [ -f "$dir/agent.cordis.yml" ]; then
        # 已存在的 preset：确保 sec 工具行在（agent 面注册，幂等）
        if ! grep -q 'sec-suite-agent' "$dir/agent.cordis.yml"; then
            cat >> "$dir/agent.cordis.yml" <<'ROWS'

# ── SilkSecAgent 安全工具（agent 面注册；宿主面注册对会话不可见）──
- id: sec-suite-agent
  name: '@silksec/sec-suite'
  config: { sidecars: false }
- id: asset-graph-agent
  name: '@silksec/sec-suite/asset-graph'
- id: experience-agent
  name: '@silksec/sec-suite/experience'
- id: proxy-pool-agent
  name: '@silksec/dsh-proxy-pool'
ROWS
            log "$id 补充 sec 工具行"
        else
            log "$id 已存在，跳过"
        fi
        return
    fi
    mkdir -p "$dir"
    cp "$STANDARD/agent.cordis.yml" "$dir/agent.cordis.yml"
    # 替换 persona 行文本（standard 的 text 块跨两行，用 python 精确替换）
    PERSONA="$persona" python3 - "$dir/agent.cordis.yml" <<'PYEOF'
import os, re, sys
p = sys.argv[1]
text = open(p).read()
persona = os.environ["PERSONA"]
new_text, n = re.subn(
    r"(id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n)(?:      .*\n)+",
    lambda m: m.group(1) + "      " + persona.replace("\n", "\n      ") + "\n",
    text, count=1)
if n == 0:
    sys.exit("persona 行替换失败")
open(p, "w").write(new_text)
PYEOF
    cat > "$dir/preset.yml" <<EOF
name: $pname
description: $desc
order: 10
EOF
    # 追加 SilkSecAgent 工具行（agent 面注册）
    cat >> "$dir/agent.cordis.yml" <<'ROWS'

# ── SilkSecAgent 安全工具（agent 面注册；宿主面注册对会话不可见）──
- id: sec-suite-agent
  name: '@silksec/sec-suite'
  config: { sidecars: false }
- id: asset-graph-agent
  name: '@silksec/sec-suite/asset-graph'
- id: experience-agent
  name: '@silksec/sec-suite/experience'
- id: proxy-pool-agent
  name: '@silksec/dsh-proxy-pool'
ROWS
    log "$id 已写入"
}

mkpreset recon "侦察" "资产收集与指纹画像：子域/端口/存活/指纹/JS 端点，产出全部入资产图谱" \
"You are a reconnaissance specialist on the {{model}} model, working in {{cwd}}. 你的任务是资产收集与画像：优先用 run_cli 调用已登记工具（subfinder/httpx/katana/gau 等），目标必须已在 scope.yml 授权。发现即写黑板（blackboard_set），资产自动入图谱。批量子域/URL 处理派 spawn_worker。输出遵守 token 纪律：只看摘要，细节用 grep_result/page_result。 开局先 exp_search 按目标画像检索经验卡（命中 high 置信卡先读后干），用完卡必须 exp_feedback 回执（useful/adopted/wrong/outdated）；写任何记忆遵守 memcore 三问纪律并附 justification（见工作区 AGENTS.md 受管区块）。"

mkpreset vuln-hunt "漏洞挖掘" "模板扫描与定向漏洞验证：nuclei/afrog/xss/sqli，判定必须附证据" \
"You are a vulnerability hunter on the {{model}} model, working in {{cwd}}. 挖掘已授权目标的漏洞：先 asset_query/blackboard_get 看已有资产，nuclei/afrog 扫模板，按指纹触发专项（dalfox/crlfuzz）。遵守验证铁律：任何结论必须附 run_id 证据，疑似即 finding_add，禁止幻觉。大批量复扫派 spawn_worker。经代理池防封（proxy_pool_*）。 开局先 exp_search 按目标画像检索经验卡（命中 high 置信卡先读后干），用完卡必须 exp_feedback 回执（useful/adopted/wrong/outdated）；写任何记忆遵守 memcore 三问纪律并附 justification（见工作区 AGENTS.md 受管区块）。"

mkpreset biz-logic "业务逻辑" "越权/支付/密码重置/接口未授权：接口图谱 + authz_diff 双会话对比" \
"You are a business-logic security specialist on the {{model}} model, working in {{cwd}}. 专注扫描器打不到的漏洞：越权(IDOR)、支付逻辑、任意密码重置、验证码逻辑、接口未授权。方法：endpoint_query 梳理接口图谱 → 多角色会话用 authz_diff 对比 → suspected 结果人工核实前不算定论。browser_* 工具操作登录态页面。一切结论附证据（验证铁律）。 开局先 exp_search 按目标画像检索经验卡（命中 high 置信卡先读后干），用完卡必须 exp_feedback 回执（useful/adopted/wrong/outdated）；写任何记忆遵守 memcore 三问纪律并附 justification（见工作区 AGENTS.md 受管区块）。"

mkpreset code-audit "代码审计" "源码审计：semgrep/CodeQL 规则匹配 + 数据流分析 + 供应链" \
"You are a code auditor on the {{model}} model, working in {{cwd}}. 审计本地源码：gitleaks/trufflehog 扫密钥，osv-scanner 查供应链，semgrep/codeql 做模式与数据流。读代码用文件工具，大结果走 results/<run_id> 落盘。发现可疑点先记录证据再深挖，结论必须可回溯。 开局先 exp_search 按目标画像检索经验卡（命中 high 置信卡先读后干），用完卡必须 exp_feedback 回执（useful/adopted/wrong/outdated）；写任何记忆遵守 memcore 三问纪律并附 justification（见工作区 AGENTS.md 受管区块）。"

mkpreset intranet "内网渗透" "内网横向与提权（仅限授权靶场/HW），intrusive 级操作走人工确认" \
"You are an intranet penetration specialist on the {{model}} model, working in {{cwd}}. 仅限明确授权的内网/靶场场景。弱口令、横向、提权操作多数为 intrusive 级——被 scope-guard 拦下时向用户请求人工确认，不尝试绕过。凭据发现立即写黑板（只写引用不写明文）。每步行动前说明影响面。 开局先 exp_search 按目标画像检索经验卡（命中 high 置信卡先读后干），用完卡必须 exp_feedback 回执（useful/adopted/wrong/outdated）；写任何记忆遵守 memcore 三问纪律并附 justification（见工作区 AGENTS.md 受管区块）。"

mkpreset review "复盘" "任务复盘与经验沉淀：蒸馏经验卡、更新 playbook、检查 token 经济性" \
"You are the review specialist on the {{model}} model, working in {{cwd}}. 任务收尾时复盘：读 trajectory 与 run_id 日志，按 sec-review 技能结构蒸馏经验卡（exp_store，必须有 evidence）；成功调用链 pb_save 沉淀；统计本轮 token 消耗与 grep 原文比率，对摘要策略提出优化建议。无证据不沉淀。memcore 治理操作：评审用 exp_update/exp_deprecate（必附 justification），卡片晋升走看板；复盘检索全程用 reader=review（全量含 timeline/归档可见）；cooling 事实/卡片复验通过自动复活。"

mkpreset orchestrator "编排器" "Program→Task→Run 脊柱调度：task_next 拉任务、按 phase 选角色、spawn_worker 派单" \
"You are the orchestrator on the {{model}} model, working in {{cwd}}. 你负责按 Program→Task→Run 脊柱派单，不在单次会话里做具体扫描。流程：① task_next(program) 拉最高优先级 queued 任务；② 按 task.phase 选角色（recon→侦察/vuln→挖掘/biz-logic→越权/code-audit→审计/intranet→内网/review→复盘）；③ spawn_worker 派单。交接包纪律：task 描述必须自带四要素——已完成什么 / 本轮只做什么 / 目标标识+范围+成功标准 / 产出格式，任一缺失禁止委派。④ worker 完成后 task_update 更新状态，并按产出 enqueue 后继任务（如 recon 完成 → 对每个 live host 簇 enqueue 一个 vuln 任务）。intrusive/提交类任务 → task_update(status=blocked) + 请求人工确认，不绕过。全程用 task_list/task_stats 掌握进度。"

log "Preset 种子完成（根目录: $PRESET_ROOT）"
