#!/usr/bin/env python3
# ==============================================================================
# SilkSecAgent 数据导入器：CyberStrikeAI conversations.db → asset-graph.db
# 用法: python3 import-cyberstrikeai.py <项目名>（如 美团SRC）
# 映射: assets → assets / vulnerabilities → findings / project_facts → blackboard
# 幂等：我们的表均有唯一约束 + upsert/指纹去重，重复跑不产生重复
# ==============================================================================
import json
import sqlite3
import sys
import time
import hashlib
from urllib.parse import urlparse

STAGING = "/opt/silkspool/dsh/data/import-staging/cyberstrikeai/data/conversations.db"
TARGET_DB = "/opt/silkspool/dsh/data/asset-graph.db"

SEV_MAP = {"critical": "critical", "high": "high", "medium": "medium", "low": "low", "info": "info"}


def host_of(url: str) -> str:
    if not url:
        return ""
    u = urlparse(url if "://" in url else f"http://{url}")
    return (u.hostname or "").lower()


def main(project_name: str):
    src = sqlite3.connect(f"file:{STAGING}?mode=ro", uri=True)
    dst = sqlite3.connect(TARGET_DB)
    dst.execute("PRAGMA journal_mode=WAL")
    now = int(time.time() * 1000)

    proj = src.execute("SELECT id FROM projects WHERE name = ?", (project_name,)).fetchone()
    if not proj:
        print(f"项目不存在: {project_name}")
        sys.exit(1)
    pid = proj[0]
    src_tag = f"cyberstrikeai:{project_name}"

    # ---- assets ----
    n_asset = 0
    for row in src.execute(
        "SELECT host, ip, port, domain, protocol, title, server FROM assets WHERE project_id = ?", (pid,)
    ):
        host, ip, port, domain, protocol, title, server = row
        h = (host or domain or ip or "").strip().lower()
        if not h:
            continue
        typ = "web" if protocol else ("domain" if domain else "ip")
        attrs = json.dumps({"port": port, "protocol": protocol, "title": title, "server": server}, ensure_ascii=False)
        dst.execute(
            """INSERT INTO assets (host, type, source, attrs, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (host, type) DO UPDATE SET last_seen=excluded.last_seen, attrs=excluded.attrs""",
            (h, typ, src_tag, attrs, now, now),
        )
        n_asset += 1

    # ---- vulnerabilities ----
    n_vuln = 0
    n_dup = 0
    for row in src.execute(
        "SELECT title, severity, target, evidence, status FROM vulnerabilities WHERE project_id = ?", (pid,)
    ):
        title, severity, target, evidence, status = row
        host = host_of(target or "")
        fp = hashlib.sha1(f"{host}|{title}|{target or ''}".encode()).hexdigest()
        exists = dst.execute("SELECT id FROM findings WHERE fingerprint = ?", (fp,)).fetchone()
        if exists:
            n_dup += 1
            continue
        ev = (evidence or "")[:500] or "历史发现（CyberStrikeAI 导入）"
        dst.execute(
            """INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)""",
            (fp, title, SEV_MAP.get(severity, "info"), host, target or "", ev, src_tag, now),
        )
        n_vuln += 1

    # ---- project_facts → blackboard ----
    n_fact = 0
    for row in src.execute(
        "SELECT fact_key, category, summary FROM project_facts WHERE project_id = ?", (pid,)
    ):
        key, category, summary = row
        if not key:
            continue
        dst.execute(
            """INSERT INTO blackboard (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
            (f"import:{project_name}:{key}", f"[{category}] {summary or ''}", now),
        )
        n_fact += 1

    dst.commit()
    print(json.dumps({
        "project": project_name, "assets": n_asset,
        "findings_imported": n_vuln, "findings_dup_skipped": n_dup, "blackboard_facts": n_fact,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "美团SRC")
