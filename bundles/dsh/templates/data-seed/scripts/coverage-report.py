#!/usr/bin/env python3
# ==============================================================================
# coverage-report.py — 覆盖矩阵聚合（防幻觉标准 8：报告数字脚本生成，禁手填）
# 用法: coverage-report.py <attempts.tsv> [--assets assets.tsv] [--out coverage.md]
# 从 append-only 台账聚合：每卡片 × 状态计数、BLOCKED 解锁收益、近期活动
# ==============================================================================
import csv, sys, os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

STATES = ["TESTED_CLEAN", "CONFIRMED", "FALSE_POSITIVE", "NOT_APPLICABLE", "BLOCKED", "STALE"]

def load_attempts(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.reader(f, delimiter="\t") if r]
    if not rows:
        return [], []
    return rows[0], rows[1:]

def latest_state(rows):
    """每个 (asset, card_id) 取时间最新一行的状态（append-only，后行覆盖前行）"""
    latest = {}
    for r in rows:
        if len(r) < 6:
            continue
        ts, asset, card_id, card_ver, tool, result = r[:6]
        reason = r[6] if len(r) > 6 else ""
        key = (asset, card_id)
        if key not in latest or ts >= latest[key][0]:
            latest[key] = (ts, result, reason, card_ver)
    return latest

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    out = None
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]

    header, rows = load_attempts(path)
    latest = latest_state(rows)

    # 卡片 × 状态计数（取每个组合的最新状态）
    card_state = defaultdict(lambda: defaultdict(int))
    card_ver = {}
    for (asset, card_id), (ts, result, reason, ver) in latest.items():
        card_state[card_id][result] += 1
        card_ver[card_id] = ver

    # BLOCKED 解锁收益聚合
    blocker_gain = defaultdict(int)
    for (asset, card_id), (ts, result, reason, ver) in latest.items():
        if result == "BLOCKED" and reason:
            blocker_gain[reason] += 1

    # 近 24h 活动
    now = datetime.now(timezone(timedelta(hours=8)))
    recent = [r for r in rows if r and r[0] >= (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M")]

    program = os.path.basename(path).replace("attempts-", "").replace(".tsv", "")
    lines = []
    lines.append(f"# 覆盖矩阵视图 — {program}")
    lines.append(f"")
    lines.append(f"- 生成时间: {now.strftime('%Y-%m-%d %H:%M %z')}（脚本生成，禁止手填修改）")
    lines.append(f"- 台账: `{os.path.abspath(path)}`（{len(rows)} 行）")
    lines.append(f"- 覆盖组合数: {len(latest)}（资产×卡片 最新状态去重）")
    lines.append(f"")
    lines.append(f"## 卡片 × 最新状态计数")
    lines.append(f"")
    lines.append("| 卡片 | 版本 | CLEAN | CONFIRMED | FP | N/A | BLOCKED | STALE |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for card_id in sorted(card_state):
        st = card_state[card_id]
        lines.append(
            f"| {card_id} | {card_ver.get(card_id,'')} | {st.get('TESTED_CLEAN',0)} | {st.get('CONFIRMED',0)} "
            f"| {st.get('FALSE_POSITIVE',0)} | {st.get('NOT_APPLICABLE',0)} | {st.get('BLOCKED',0)} | {st.get('STALE',0)} |"
        )
    lines.append("")
    lines.append("## BLOCKED 解锁收益（补什么条件解锁多少测试面）")
    lines.append("")
    if blocker_gain:
        lines.append("| blocker | 解锁单元格数 |")
        lines.append("|---|---|")
        for b, n in sorted(blocker_gain.items(), key=lambda x: -x[1]):
            lines.append(f"| {b} | {n} |")
    else:
        lines.append("（当前无 BLOCKED 项）")
    lines.append("")
    lines.append(f"## 近 24h 活动：{len(recent)} 条台账记录")
    lines.append("")
    text = "\n".join(lines)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"已写入 {out}")
    else:
        print(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())
