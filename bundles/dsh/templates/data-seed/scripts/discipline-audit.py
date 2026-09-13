#!/usr/bin/env python3
# ==============================================================================
# P15 文档-现实校验（discipline-audit.py）—— 评估报告 §14.9 的常态化机制。
# 每次迭代末必跑：纪律机制「上线」≠「生效」，本脚本用数据说话。
# 五指标 + 纪律脱节告警。退出码非 0 = 有纪律脱节。
# 用法：python3 discipline-audit.py [--data-dir /opt/silkspool/dsh/data] [--json]
#
# v5 Phase 5.5 增「悬空工具引用」断言（17-llm-surface §3.3 / 宪法 §十五.4 执行点）：
# 扫描 persona/skills/rules/tasks objective 全部 prompt 资产中的工具引用 token，
# 对照当前挂载矩阵（域 manifest 动词 + bus.aliases.yaml 别名 + 独立工具），
# 引用不存在的工具（含已删除旧别名）→ 悬空引用，告警 + 退出码非 0，进周复盘 #24。
# ==============================================================================
import argparse
import glob
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

DATA_DEFAULT = "/opt/silkspool/dsh/data"

# --- 悬空工具引用断言：命名空间与豁免 ---
# 工具命名空间前缀：token 首段命中即视为「动词命名空间」候选引用（区分工具名与普通字段/文件名）
TOOL_PREFIXES = {
    "vuln", "asset", "endpoint", "fact", "know", "ledger", "task", "exec", "fgs",
    "scope", "approval", "report", "proxy", "eval", "bus",   # 域前缀
    "exp", "kb", "pb", "vc", "rule", "harvest",              # know 域子仓前缀（工具名无 know_ 前缀）
    "fp", "neg", "queue", "audit", "events",                 # 非标准域工具名前缀（零改名接管）
    "browser", "authz", "finding",                           # 独立工具及历史别名前缀
}

# 非工具 token（共享工具前缀但语义是字段/指令/存储名，非动词）——显式豁免，避免误报
NON_TOOL_TOKENS = {
    "proxy_pass", "proxy_cache", "proxy_host",  # Nginx 反向代理指令（rules/techniques 内）
    "exp_cards",                                # know 域存储子仓表名（「沉淀为 exp_cards」）
    "approval_hint",                            # 失败信封字段（needs_approval/approval_hint）
}

# 常见字段后缀（`{域前缀}_{字段}` 形，非动词）：run_id / task_id / evidence_path / vuln_type 等
FIELD_SUFFIXES = {
    "id", "at", "type", "count", "level", "score", "reason", "note", "class",
    "code", "version", "index", "path", "url", "dir", "file", "name", "key",
    "value", "data", "limit", "offset", "size", "row", "time", "ms",
}

# 独立工具（非域动词、非别名，仍在工具面挂载）
STANDALONE_TOOLS = {
    "authz_diff", "asset_graph",
    "browser_open", "browser_navigate", "browser_click", "browser_type",
    "browser_select", "browser_screenshot", "browser_eval", "browser_get_text",
    "browser_get_html", "browser_wait", "browser_close", "browser_install",
}

TOKEN_RE = re.compile(r"(?<![a-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![a-z0-9_])")


def _manifest_keys(src, section):
    """从域 manifest JS 源码提取 commands/queries 的顶层键名（权威工具名）。"""
    for m in re.finditer(r"(?m)^  %s:\s*\{" % re.escape(section), src):
        brace = src.index("{", m.start())
        depth, i = 0, brace
        while i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        return re.findall(r"(?m)^    (\w+)\s*:\s*\{", src[brace + 1:i])
    return []


def build_valid_tools(base_dir, data_dir):
    """当前挂载矩阵 = 域 manifest 全动词 + 别名 + 独立工具。返回 (valid_set, n_verbs, n_aliases)。"""
    valid = set(STANDALONE_TOOLS)
    n_verbs = 0
    for f in glob.glob(os.path.join(base_dir, "dsh-plugin-sec-domain-*.js")):
        if ".test.js" in f:
            continue
        try:
            src = open(f, encoding="utf-8").read()
        except OSError:
            continue
        for k in _manifest_keys(src, "commands") + _manifest_keys(src, "queries"):
            valid.add(k)
            n_verbs += 1
    n_aliases = 0
    af = os.path.join(data_dir, "bus.aliases.yaml")
    if os.path.isfile(af):
        try:
            y = open(af, encoding="utf-8").read()
            for m in re.finditer(r"(?m)^  ([a-z][a-z0-9_]*):", y):
                valid.add(m.group(1))
                n_aliases += 1
        except OSError:
            pass
    return valid, n_verbs, n_aliases


def scan_tool_refs(text, valid):
    """扫描一段文本中的悬空工具引用 token。返回 set。"""
    dangling = set()
    for tok in TOKEN_RE.findall(text or ""):
        if tok in valid:
            continue
        if tok.split("_", 1)[0] not in TOOL_PREFIXES:
            continue
        if tok in NON_TOOL_TOKENS:
            continue
        if tok.rsplit("_", 1)[-1] in FIELD_SUFFIXES:
            continue
        dangling.add(tok)
    return dangling


def persona_module(base_dir):
    candidates = [Path(base_dir) / "plugins/sec-suite/persona.py",
                  Path(base_dir) / "dsh-plugin-sec-suite.persona.py",
                  Path(__file__).resolve().parents[2] / "dsh-plugin-sec-suite.persona.py"]
    filename = next((p for p in candidates if p.is_file()), None)
    if filename is None:
        raise ValueError("缺少受管 persona 解析器")
    spec = importlib.util.spec_from_file_location("silksec_persona_audit", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def collect_prompt_texts(data_dir, base_dir=None, errors=None, prompt_files=()):
    """收集 persona/skills/rules/调度模板/已捕获的最终 prompt；失败不能等价为空文本。"""
    base_dir = base_dir or os.path.dirname(os.path.abspath(data_dir))
    errors = errors if errors is not None else []
    items = []
    persona = persona_module(base_dir)
    persona_files = sorted(glob.glob(os.path.join(data_dir, ".agent-presets", "*", "agent.cordis.yml")))
    present = {Path(f).parent.name for f in persona_files}
    for missing in sorted(persona.MANAGED_IDS - present):
        errors.append({"file": f".agent-presets/{missing}/agent.cordis.yml", "error": "MissingManagedPersona"})
    for f in persona_files:
        try:
            parts = persona.persona_parts(persona.read_yaml(f))
            items.append((os.path.relpath(f, data_dir), parts["prefix"] + "\n" + parts["suffix"]))
        except (OSError, ValueError, persona.yaml.YAMLError) as error:
            errors.append({"file": os.path.relpath(f, data_dir), "error": type(error).__name__})
            continue
    for f in sorted(glob.glob(os.path.join(data_dir, "skills", "*", "SKILL.md"))):
        try:
            items.append((os.path.relpath(f, data_dir), open(f, encoding="utf-8").read()))
        except OSError:
            continue
    for f in sorted(glob.glob(os.path.join(data_dir, "rules", "**", "*.md"), recursive=True)):
        try:
            items.append((os.path.relpath(f, data_dir), open(f, encoding="utf-8").read()))
        except OSError:
            continue
    runtime = Path(base_dir) / "plugins/sec-suite/host-compat.js"
    if not runtime.is_file():
        runtime = Path(base_dir) / "dsh-plugin-sec-suite.host-compat.js"
    try:
        src = runtime.read_text(encoding="utf-8")
        template = src.split("// PROMPT_AUDIT_BEGIN", 1)[1].split("// PROMPT_AUDIT_END", 1)[0]
        if "// PROMPT_AUDIT_END" not in src or not template.strip():
            raise ValueError("缺少调度 prompt 扫描边界")
        items.append(("runtime/scheduled-prompt", template))
    except (OSError, ValueError, IndexError) as error:
        errors.append({"file": "runtime/scheduled-prompt", "error": type(error).__name__})
    for filename in prompt_files:
        try:
            items.append(("rendered/" + Path(filename).name, Path(filename).read_text(encoding="utf-8")))
        except OSError as error:
            errors.append({"file": "rendered/" + Path(filename).name, "error": type(error).__name__})
    return items


def beijing_date(ts=None):
    return time.strftime("%Y-%m-%d", time.gmtime((ts or time.time()) + 8 * 3600))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=DATA_DEFAULT)
    ap.add_argument("--base-dir", help="部署根目录（默认 data-dir 的父目录）")
    ap.add_argument("--prompt-file", action="append", default=[], help="附加实际拼装后的 prompt 文件，可重复；输出仅报告工具 token")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    ddir = args.data_dir
    pdir = os.path.join(ddir, "pipeline")
    db_file = os.path.join(ddir, "asset-graph.db")

    today = beijing_date()
    days7 = [beijing_date(time.time() - i * 86400) for i in range(7)]
    metrics = {}

    # 1) 台账日增量（按项目）
    ledger = {}
    if os.path.isdir(pdir):
        for p in sorted(os.listdir(pdir)):
            f = os.path.join(pdir, p, f"attempts-{p}.tsv")
            if not os.path.isfile(f):
                continue
            with open(f, encoding="utf-8") as fh:
                lines = [l for l in fh if l.strip()]
            rows = lines[1:] if lines else []
            ledger[p] = {
                "total": len(rows),
                "today": sum(1 for l in rows if l.split("\t")[0][:10] == today),
            }
    metrics["ledger_today"] = ledger

    # 2) 卡片使用 7 天增量
    cu7 = 0
    if os.path.isdir(pdir):
        for p in os.listdir(pdir):
            pd = os.path.join(pdir, p)
            if not os.path.isdir(pd):
                continue
            for f in os.listdir(pd):
                if f.startswith("card_usage-") and f[11:21] in days7:
                    with open(os.path.join(pd, f), encoding="utf-8") as fh:
                        cu7 += sum(1 for l in fh if l.strip())
    metrics["card_usage_7d"] = cu7

    # 3) 交接包 7 天生成率
    ho7 = 0
    if os.path.isdir(pdir):
        progs = [p for p in os.listdir(pdir) if os.path.isdir(os.path.join(pdir, p))]
        for p in progs:
            for day in days7:
                if os.path.isfile(os.path.join(pdir, p, f"handoff-{day}.md")):
                    ho7 += 1
    metrics["handoff_7d"] = ho7

    # 4) IdeaCard 月增量
    ideas = 0
    ideas_dir = os.path.join(ddir, "vulncards", "ideas")
    if os.path.isdir(ideas_dir):
        ideas = len([f for f in os.listdir(ideas_dir) if f.endswith(".yaml") and not f.startswith("IC-000")])
    metrics["idea_cards"] = ideas

    # 5) 调度漂移 + task_runs 新鲜度
    con = sqlite3.connect(Path(db_file).resolve().as_uri() + "?mode=ro", uri=True)
    cur = con.cursor()
    drift = cur.execute(
        "SELECT id, program_id, CAST(next_run_at AS REAL)/NULLIF(CAST(last_run_at + every_seconds*1000 AS REAL),0)"
        " FROM tasks WHERE schedule_kind='interval' AND status NOT IN ('done','failed','cancelled')"
    ).fetchall()
    metrics["schedule_drift"] = [{"task": int(i), "program": p, "ratio": round(r, 2)} for i, p, r in drift if r and r > 1.5]
    last_run = cur.execute("SELECT COALESCE(MAX(finished_at),0) FROM task_runs").fetchone()[0]
    metrics["task_runs_last_age_hours"] = round((time.time() * 1000 - last_run) / 360000) / 10 if last_run else None
    con.close()

    # 6) 悬空工具引用（v5 Phase 5.5：persona/skills/rules/tasks objective 对照挂载矩阵）
    base_dir = args.base_dir or os.path.dirname(os.path.abspath(ddir))
    valid, n_verbs, n_aliases = build_valid_tools(base_dir, ddir)
    dangling = []
    prompt_errors = []
    alias_file = os.path.join(ddir, "bus.aliases.yaml")
    aliases = set(re.findall(r"(?m)^  ([a-z][a-z0-9_]*):", Path(alias_file).read_text(encoding="utf-8"))) if os.path.isfile(alias_file) else set()
    deprecated = []
    for label, text in collect_prompt_texts(ddir, base_dir, prompt_errors, args.prompt_file):
        for tok in sorted(scan_tool_refs(text, valid)):
            dangling.append({"file": label, "token": tok})
        for tok in sorted(set(TOKEN_RE.findall(text)) & aliases):
            deprecated.append({"file": label, "token": tok})
    try:
        con = sqlite3.connect(Path(db_file).resolve().as_uri() + "?mode=ro", uri=True)
        cur = con.cursor()
        for tid, obj in cur.execute("SELECT id, objective FROM tasks WHERE objective IS NOT NULL AND objective != ''"):
            for tok in sorted(scan_tool_refs(obj, valid)):
                dangling.append({"file": f"tasks/#{tid}", "token": tok})
            for tok in sorted(set(TOKEN_RE.findall(obj)) & aliases):
                deprecated.append({"file": f"tasks/#{tid}", "token": tok})
        con.close()
    except sqlite3.Error as error:
        prompt_errors.append({"file": "tasks/objective", "error": type(error).__name__})
    metrics["dangling_tool_refs"] = dangling
    metrics["deprecated_tool_refs"] = deprecated  # 仍存在的别名不是悬空工具，但会阻止别名清理。
    metrics["prompt_read_errors"] = prompt_errors
    metrics["tool_surface"] = {"verbs": n_verbs, "aliases": n_aliases, "valid_total": len(valid)}

    alerts = []
    for p, v in metrics["ledger_today"].items():
        if v["total"] == 0:
            alerts.append(f"台账空转: {p}")
    if metrics["card_usage_7d"] == 0:
        alerts.append("card_usage 7 天 0 条")
    if metrics["handoff_7d"] == 0:
        alerts.append("handoff 7 天 0 份")
    if metrics["schedule_drift"]:
        alerts.append(f"调度漂移 {len(metrics['schedule_drift'])} 项")
    lr = metrics["task_runs_last_age_hours"]
    if lr is not None and lr > 26:
        alerts.append(f"task_runs 断链 {lr}h")
    if dangling:
        brief = "；".join(f"{d['file']}:{d['token']}" for d in dangling[:10])
        alerts.append(f"悬空工具引用 {len(dangling)} 处: {brief}")
    if n_verbs == 0:
        alerts.append("挂载矩阵不可解析（域 manifest 0 动词，悬空断言失效）")
    if prompt_errors:
        alerts.append(f"prompt 资产读取失败 {len(prompt_errors)} 项")

    result = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime(time.time() + 8 * 3600)), **metrics, "alerts": alerts, "healthy": not alerts}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(f"== 文档-现实校验 {result['generated_at']} ==")
        print(f"台账: {json.dumps(metrics['ledger_today'], ensure_ascii=False)}")
        print(f"card_usage(7d)={cu7}  handoff(7d)={ho7}  IdeaCard={ideas}")
        print(f"调度漂移: {metrics['schedule_drift'] or '无'}  task_runs 新鲜度: {lr}h")
        print(f"挂载矩阵: 动词={n_verbs} 别名={n_aliases} 有效工具={len(valid)}")
        print(f"旧别名引用: {len(deprecated)}（仍有效；清理前需改写并重新观察）")
        if dangling:
            print(f"悬空工具引用 {len(dangling)} 处:")
            for d in dangling:
                print(f"  ✘ {d['file']}: {d['token']}")
        else:
            print("悬空工具引用: 0")
        print(f"结论: {'纪律在执行 ✔' if not alerts else '纪律脱节 ✘ — ' + '；'.join(alerts)}")
    return 1 if alerts else 0


if __name__ == "__main__":
    sys.exit(main())
