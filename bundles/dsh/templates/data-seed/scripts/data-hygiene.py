#!/usr/bin/env python3
# ==============================================================================
# 数据卫生修复（data-hygiene.py）—— 幂等，只做确定性可推导的回填与清理。
#
# 动作集：
#   1. findings/assets/endpoints 的 program_id 空值 → 按 scope.yml 命中回填（唯一命中才写）
#   2. findings.source 空值 → 'unknown'（统一枚举，禁止空串）
#   3. fgs_nodes 孤儿行（task_id 不在 tasks）→ 删除
#   4. 重复发现（同 host+title）→ 仅报告，不自动合并（需人工判 dup_of）
#
# 默认 dry-run；--apply 才落库。用法：
#   python3 data-hygiene.py [--db ...] [--scope ...] [--apply] [--json]
# ==============================================================================
import argparse
import json
import os
import re
import sqlite3
import sys

DB_DEFAULT = "/opt/silkspool/dsh/data/asset-graph.db"
SCOPE_DEFAULT = "/opt/silkspool/dsh/data/scope.yml"

# 与 JS hostOf 对齐：剥离协议/路径/端口/大小写
def host_of(raw: str) -> str:
    h = (raw or "").strip().lower()
    h = re.sub(r"^[a-z][a-z0-9+.-]*://", "", h)
    h = h.split("/")[0].split("?")[0]
    h = h.split("@")[-1]
    if h.startswith("["):
        h = h.split("]")[0].lstrip("[")
    else:
        h = h.split(":")[0]
    return h.rstrip(".")


def parse_scope(path: str):
    """极简解析 scope.yml：programs[].name/scope/exclude（与 JS parseScopePrograms 同构）。"""
    programs = []
    cur = None
    key = ""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return programs
    for raw in lines:
        t = raw.strip()
        if not t or t.startswith("#"):
            continue
        m = re.match(r"^-\s+name:\s*[\"']?([^\"']+?)[\"']?\s*$", t)
        if m:
            cur = {"name": m.group(1).strip(), "scope": [], "exclude": []}
            programs.append(cur)
            key = ""
            continue
        if cur is None:
            continue
        if re.match(r"^(scope|exclude):\s*$", t):
            key = t[:-1]
            continue
        m = re.match(r"^-\s*[\"']?([^\"']+?)[\"']?\s*$", t)
        if m and key in ("scope", "exclude"):
            cur[key].append(m.group(1).strip())
            continue
        if re.match(r"^[a-z_]+:", t):
            key = ""
    return programs


def host_in_patterns(host: str, patterns):
    for p in patterns or []:
        bare = re.sub(r"^\*\.", "", str(p)).strip().lower()
        if not bare:
            continue
        if bare == host or host.endswith("." + bare):
            return True
    return False


def match_program(host: str, programs):
    """返回唯一命中的 program 名；被任一 exclude 命中或命中 0/多 个 program → None。"""
    for p in programs:
        if host_in_patterns(host, p.get("exclude")):
            return None
    hits = [p["name"] for p in programs if host_in_patterns(host, p.get("scope"))]
    return hits[0] if len(hits) == 1 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--scope", default=SCOPE_DEFAULT)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    cur = con.cursor()
    programs = parse_scope(args.scope)
    report = {"dry_run": not args.apply, "programs": len(programs)}

    # ---- 1. program_id 回填（唯一命中才写）----
    backfill = {}
    for table in ("findings", "assets", "endpoints"):
        try:
            rows = cur.execute(
                f"SELECT id, host FROM {table} WHERE (program_id IS NULL OR program_id='') AND host IS NOT NULL AND host!=''"
            ).fetchall()
        except sqlite3.OperationalError:
            backfill[table] = 0
            continue
        n = 0
        for rid, host in rows:
            prog = match_program(host_of(host), programs)
            if prog:
                if args.apply:
                    cur.execute(f"UPDATE {table} SET program_id=? WHERE id=?", (prog, rid))
                n += 1
        backfill[table] = n
    report["program_backfill"] = backfill

    # ---- 2. source 空值归一 ----
    cur.execute("SELECT COUNT(*) FROM findings WHERE source IS NULL OR source=''")
    empty_src = cur.fetchone()[0]
    if args.apply and empty_src:
        cur.execute("UPDATE findings SET source='unknown' WHERE source IS NULL OR source=''")
    report["source_normalized"] = empty_src

    # ---- 3. fgs_nodes 孤儿清理 ----
    try:
        cur.execute("SELECT COUNT(*) FROM fgs_nodes WHERE task_id NOT IN (SELECT id FROM tasks)")
        orphan = cur.fetchone()[0]
        if args.apply and orphan:
            cur.execute("DELETE FROM fgs_nodes WHERE task_id NOT IN (SELECT id FROM tasks)")
    except sqlite3.OperationalError:
        orphan = 0
    report["fgs_orphans_removed"] = orphan

    # ---- 4. 重复发现报告（不自动合并）----
    dup = cur.execute(
        "SELECT host, title, COUNT(*) c FROM findings GROUP BY host, title HAVING c>1 ORDER BY c DESC"
    ).fetchall()
    report["duplicate_groups"] = [{"host": h, "title": t, "n": c} for h, t, c in dup]

    if args.apply:
        con.commit()
    con.close()

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        mode = "APPLY" if args.apply else "DRY-RUN"
        print(f"[{mode}] 数据卫生")
        print(f"  program 回填: findings={backfill.get('findings',0)} assets={backfill.get('assets',0)} endpoints={backfill.get('endpoints',0)}")
        print(f"  source 归一: {empty_src} 条 → unknown")
        print(f"  fgs 孤儿清理: {orphan} 条")
        print(f"  重复发现组（需人工判 dup_of）: {len(dup)}")
        for h, t, c in dup[:20]:
            print(f"    x{c}  {h}  {t[:60]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
