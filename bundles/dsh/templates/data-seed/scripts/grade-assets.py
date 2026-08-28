#!/usr/bin/env python3
# ==============================================================================
# P15 资产准入：批量分级（grade-assets.py）
# 只对 scope.yml 授权域内的未分级资产做启发式分级；授权域外/第三方参考站保持 NULL
# ——未分级即不进主动扫描队列（level_in=S,A,B），这正是准入门的语义。
# 分级依据：主机名语义关键词 + 既有数据密度（指纹/发现/存活状态）。
#
# 用法：python3 grade-assets.py [--db ...] [--scope /opt/silkspool/dsh/data/scope.yml] [--dry-run]
# 评分体系对齐 rules/src/asset-scoring.md：S≥75 A60-74 B40-59 C<40
# ==============================================================================
import argparse
import re
import sqlite3
import sys

DB_DEFAULT = "/opt/silkspool/dsh/data/asset-graph.db"
SCOPE_DEFAULT = "/opt/silkspool/dsh/data/scope.yml"

# 高价值语义（登录态/管理面/认证/核心 API）
KW_A = [
    r"admin", r"manage", r"console", r"dashboard", r"backend", r"ops",
    r"sso", r"login", r"auth", r"oauth", r"passport", r"token", r"session",
    r"\bapi\b", r"gateway", r"openapi", r"erp", r"crm", r"oa\b",
    r"pay", r"wallet", r"order", r"user", r"account",
    r"internal", r"intranet", r"vpn", r"\bci\b", r"\bcd\b", r"jenkins", r"git", r"jira", r"confluence",
]
# 中价值语义（测试/预发/业务子域）
KW_B = [
    r"test", r"dev", r"uat", r"staging", r"stage", r"pre(?:prod|view)?\b", r"gray", r"beta",
    r"\bm\b", r"h5", r"wap", r"app", r"mobile", r"www", r"mall", r"shop", r"activity",
    r"\bact\b", r"event", r"static", r"img", r"\bcdn\b", r"file", r"download", r"docs", r"help",
]
# 低价值语义（静态/边缘/追踪）
KW_C = [r"static", r"\bcdn\b", r"img", r"pic", r"track", r"\blog\b", r"metric", r"monitor", r"push", r"report"]


def parse_scope_domains(scope_file: str):
    """极简 scope.yml 解析：抓 scope: 块下的域模式（*.suffix / 精确域 / 裸 IP/CIDR 忽略）。"""
    pats = []
    in_scope = False
    try:
        with open(scope_file, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.rstrip()
                if re.match(r"^\s*scope:\s*$", line):
                    in_scope = True
                    continue
                if in_scope and re.match(r"^\s*[A-Za-z_]+:", line) and not line.strip().startswith("-"):
                    in_scope = False
                m = re.match(r"^\s*-\s+[\"']?([^\"'\n]+)[\"']?", line) if in_scope else None
                if m:
                    pat = m.group(1).strip()
                    if "*" in pat or re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", pat, re.I):
                        pats.append(pat.lower())
    except OSError:
        pass
    return pats


def host_in_scope(host: str, pats) -> bool:
    h = host.lower().split("/")[0].split(":")[0].rstrip(".")
    for p in pats:
        p = p.lstrip("*.").strip()
        if not p or "/" in p:  # CIDR 等非域名模式跳过（IP 资产单独放行）
            continue
        if h == p or h.endswith("." + p):
            return True
    return False


def score_host(host: str) -> int:
    h = host.lower()
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", h):
        return 45  # 裸 IP 中性偏 B
    base = 40  # 未知业务子域起步 B 下沿
    hits_a = sum(1 for p in KW_A if re.search(p, h))
    hits_b = sum(1 for p in KW_B if re.search(p, h))
    hits_c = sum(1 for p in KW_C if re.search(p, h))
    score = base + hits_a * 18 - hits_c * 8
    if hits_a and hits_b:
        score += 6  # 测试环境的 admin/api 比生产同类更值得看
    if hits_c and not hits_a and not hits_b:
        score -= 20
    depth = h.count(".")
    if depth >= 4:
        score -= (depth - 3) * 4  # 深层子域枚举噪声概率高
    return max(0, min(100, score))


def level_of(score: int) -> str:
    return "S" if score >= 75 else "A" if score >= 60 else "B" if score >= 40 else "C"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--scope", default=SCOPE_DEFAULT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pats = parse_scope_domains(args.scope)
    if not pats:
        print(f"警告：未能从 {args.scope} 解析出域模式，回退为全量分级（不推荐）", file=sys.stderr)

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    rows = cur.execute(
        """
        SELECT a.host, a.type, a.state,
          (SELECT COUNT(*) FROM fingerprints f WHERE f.host = a.host) AS fp_n,
          (SELECT COUNT(*) FROM findings f2 WHERE f2.host = a.host AND f2.noise = 0
             AND f2.severity IN ('high','medium','critical')) AS hi_n,
          (SELECT COUNT(*) FROM endpoints e WHERE e.host = a.host) AS ep_n
        FROM assets a WHERE a.level IS NULL
        """
    ).fetchall()

    updates = []
    skipped_oos = 0
    for r in rows:
        host = r["host"]
        is_ip = re.match(r"^\d+\.\d+\.\d+\.\d+$", host.split(":")[0])
        if pats and not is_ip and not host_in_scope(host, pats):
            skipped_oos += 1
            continue  # 授权域外/参考站：保持 NULL，永不进主动队列
        s = score_host(host)
        if r["fp_n"]:
            s = min(100, s + 8)
        if r["ep_n"]:
            s = min(100, s + 5)
        if r["hi_n"]:
            s = min(100, s + 25)  # 有真实中高危历史 = 已验证可挖面（保底 A）
        if r["state"] == "dead":
            s = max(0, s - 25)
        updates.append((s, level_of(s), host, r["type"]))

    dist = {"S": 0, "A": 0, "B": 0, "C": 0}
    for _, lv, *_ in updates:
        dist[lv] += 1
    print(f"待分级资产: {len(updates)}（授权域外跳过 {skipped_oos}，保持 NULL 不进队列）")
    print(f"分级分布: S={dist['S']} A={dist['A']} B={dist['B']} C={dist['C']}")

    if args.dry_run:
        for s, lv, host, _ in updates[:15]:
            print(f"  {host} -> {lv} ({s})")
        print("(dry-run，未写库)")
        return 0

    cur.executemany(
        "UPDATE assets SET score = ?, level = ? WHERE host = ? AND type = ? AND level IS NULL",
        updates,
    )
    con.commit()
    total, graded = cur.execute("SELECT COUNT(*), COUNT(level) FROM assets").fetchone()
    print(f"已写库。全库资产 {total}，已分级 {graded}，未分级 {total - graded}（域外/参考站）")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
