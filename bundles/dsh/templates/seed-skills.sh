#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 核心 Skill + 规则先验层 种子（幂等：补缺失 + 内容漂移即刷新）
# DSH 用户级技能目录：$DSH_HOME/skills/<name>/SKILL.md
# 规则先验层：$DSH_HOME/rules/<rel>（56 篇，人工蒸馏静态规则）
#
# v4.5 重构（2026-09-04）：正文全部外移为版本受控文件——
#   技能源  data-seed/skills/<name>/SKILL.md（7 个 sec-* 技能）
#   规则源  data-seed/rules/<rel>（src 4 + srcskill 2 + techniques 46 + web 3 + php 1）
# 本脚本只做「部署通道」：install + cmp 幂等，不再内嵌 heredoc（旧版 17442 行巨石，
#   正文与 doc/srcskill、线上 data/rules 三份并存必然漂移）。
# 改规则/技能 → 改 data-seed/ 下的源文件 → 重跑本脚本（或 spool bundle dsh upgrade）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
SKILLS_DIR="$DATA_DIR/skills"
RULES_DIR="$DATA_DIR/rules"
SEED_SRC="$BASE_DIR/data-seed"   # 部署后源目录（sec-suite-plugin-setup.sh 归位）

log() { echo "[seed-skills] $*"; }

# seed_skill <name>：data-seed/skills/<name>/SKILL.md → $SKILLS_DIR（幂等）
seed_skill() {
    local name="$1"
    local src="$SEED_SRC/skills/$1/SKILL.md"
    [ -f "$src" ] || { log "源缺失，跳过: $src"; return 0; }
    if [ -f "$SKILLS_DIR/$name/SKILL.md" ] && cmp -s "$src" "$SKILLS_DIR/$name/SKILL.md"; then
        log "$name 已是最新，跳过"; return
    fi
    mkdir -p "$SKILLS_DIR/$name"
    install -m 0644 "$src" "$SKILLS_DIR/$name/SKILL.md"
    log "skill $name 已写入/刷新"
}

# seed_rule <rel>：data-seed/rules/<rel> → $RULES_DIR/<rel>（幂等）
seed_rule() {
    local rel="$1"
    local src="$SEED_SRC/rules/$rel"
    [ -f "$src" ] || { log "源缺失，跳过: $src"; return 0; }
    if [ -f "$RULES_DIR/$rel" ] && cmp -s "$src" "$RULES_DIR/$rel"; then
        log "rules/$rel 已是最新，跳过"; return
    fi
    mkdir -p "$RULES_DIR/$(dirname "$rel")"
    install -m 0644 "$src" "$RULES_DIR/$rel"
    log "rules/$rel 已写入/刷新"
}

# -------------------- 1. 核心 sec-* 技能（7 个） --------------------
seed_skill sec-verification
seed_skill sec-blackboard
seed_skill sec-review
seed_skill sec-task
seed_skill sec-knowledge
seed_skill sec-runtime-discipline
seed_skill sec-pipeline

# -------------------- 2. 规则先验层（56 篇） --------------------
# 组件先验（命中技术栈即读入：入口点模式/特有攻击面/验证要点）
seed_rule php/thinkphp.md
seed_rule web/nextjs.md
seed_rule web/selfhosted-supabase.md
seed_rule web/spring.md

# SRC 评级/定级/判据（recon 打标、定级、报告、股权闸、技术索引入口）
seed_rule src/asset-scoring.md
seed_rule src/severity-rating.md
seed_rule src/equity-gate.md
seed_rule src/technique-index.md

# srcskill 方法论（2 篇：锁面/自由跳全流程 + 报告格式唯一源）
seed_rule srcskill/dig-scope-workflow.md
seed_rule srcskill/vuln-report-format.md

# 手法模块（46 篇，源自 doc/srcskill 知识库全量导入；technique-index 短表为其索引）
seed_rule techniques/401-403-bypass.md
seed_rule techniques/agent-tool-exec-test.md
seed_rule techniques/api-gateway-test.md
seed_rule techniques/authbypass-test.md
seed_rule techniques/cache-poisoning-test.md
seed_rule techniques/clickjacking-test.md
seed_rule techniques/cloud-ide-codex-rce-chain.md
seed_rule techniques/cors-test.md
seed_rule techniques/crlf-injection-test.md
seed_rule techniques/csp-bypass-test.md
seed_rule techniques/csrf-test.md
seed_rule techniques/csv-formula-injection-test.md
seed_rule techniques/dangling-markup-test.md
seed_rule techniques/dependency-confusion-test.md
seed_rule techniques/deserialization-test.md
seed_rule techniques/dns-rebinding-test.md
seed_rule techniques/el-injection-test.md
seed_rule techniques/email-header-injection-test.md
seed_rule techniques/file-upload-test.md
seed_rule techniques/ghost-bits-cast-test.md
seed_rule techniques/graphql-test.md
seed_rule techniques/hpp-test.md
seed_rule techniques/http-host-header-test.md
seed_rule techniques/http-smuggling-test.md
seed_rule techniques/http2-attacks-test.md
seed_rule techniques/idor-test.md
seed_rule techniques/info-leak-test.md
seed_rule techniques/injection-test.md
seed_rule techniques/insecure-scm-test.md
seed_rule techniques/jndi-injection-test.md
seed_rule techniques/js-reverse-guide.md
seed_rule techniques/llm-security-test.md
seed_rule techniques/logic-test.md
seed_rule techniques/oauth-jwt-test.md
seed_rule techniques/open-redirect-test.md
seed_rule techniques/prototype-pollution-test.md
seed_rule techniques/race-condition-test.md
seed_rule techniques/recon-methodology.md
seed_rule techniques/ssrf-test.md
seed_rule techniques/subdomain-takeover-test.md
seed_rule techniques/type-juggling-test.md
seed_rule techniques/waf-bypass.md
seed_rule techniques/websocket-test.md
seed_rule techniques/xslt-injection-test.md
seed_rule techniques/xss-test.md
seed_rule techniques/xxe-test.md

# -------------------- 3. 源目录整体校验（部署完整性闸门） --------------------
n_src_rules=$(find "$SEED_SRC/rules" -name '*.md' 2>/dev/null | wc -l || echo 0)
n_dst_rules=$(find "$RULES_DIR" -name '*.md' 2>/dev/null | wc -l || echo 0)
if [ "$n_src_rules" != "56" ] || [ "$n_dst_rules" != "56" ]; then
    log "WARN: 规则数异常（源 $n_src_rules / 已部署 $n_dst_rules，应为 56）——检查 data-seed/rules 完整性"
fi
log "seed 完成：7 skills + $n_dst_rules rules（源 $SEED_SRC）"
