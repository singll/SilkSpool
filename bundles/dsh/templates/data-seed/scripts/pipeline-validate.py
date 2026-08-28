#!/usr/bin/env python3
# ==============================================================================
# pipeline-validate.py — 标准产物格式校验（防幻觉标准 5：格式机器校验）
# 用法: pipeline-validate.py <file> [file...]；全部通过 exit 0，任一失败 exit 1
# 规则: 只校验核心列结构（格式刚性），不校验取值集合（内容开放，公理 P4）
# ==============================================================================
import csv, json, sys, re, os

SCHEMAS = {
    "attempts": {
        "match": lambda p: os.path.basename(p).startswith("attempts-"),
        "header": ["ts", "asset", "card_id", "card_ver", "tool", "result", "reason", "evidence_path", "run_id"],
        "result_enum": {"TESTED_CLEAN", "CONFIRMED", "FALSE_POSITIVE", "NOT_APPLICABLE", "BLOCKED", "STALE"},
    },
    "assets": {
        "match": lambda p: os.path.basename(p).startswith("assets-"),
        "header": ["domain", "status", "first_seen", "last_seen", "source", "probe_date"],
    },
    "endpoints": {
        "match": lambda p: os.path.basename(p).startswith("endpoints-"),
        "header": ["url", "method", "params", "auth_required", "source", "collected_at"],
    },
    "egress-health": {
        "match": lambda p: os.path.basename(p).startswith("egress-health"),
        "header": ["egress", "target_domain", "ts", "signature", "verdict"],
    },
    "card_usage": {
        "match": lambda p: os.path.basename(p).startswith("card_usage-"),
        "jsonl_required": ["card_id", "card_version", "asset", "result"],
    },
}

TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
BANNED_REASON = {"other", "misc", ""}

def find_schema(path):
    for s in SCHEMAS.values():
        if s["match"](path):
            return s
    return None

def validate_tsv(path, schema):
    errors = []
    with open(path, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.reader(f, delimiter="\t") if r]
    if not rows:
        return [f"{path}: 空文件"]
    header = rows[0]
    core = schema["header"]
    if header[:len(core)] != core:
        errors.append(f"{path}: 核心列不符 期望前缀 {core} 实际 {header[:len(core)]}")
        return errors
    for i, row in enumerate(rows[1:], start=2):
        if len(row) < len(core):
            errors.append(f"{path}:{i}: 列数不足（{len(row)}<{len(core)}）")
            continue
        rec = dict(zip(core, row))
        if "ts" in rec and rec["ts"] and not TS_RE.match(rec["ts"]):
            errors.append(f"{path}:{i}: ts 格式异常: {rec['ts']!r}")
        if "result" in rec:
            if rec["result"] not in schema["result_enum"]:
                errors.append(f"{path}:{i}: result 非法: {rec['result']!r}")
            elif rec["result"] in ("NOT_APPLICABLE", "BLOCKED") and rec.get("reason", "").lower() in BANNED_REASON:
                errors.append(f"{path}:{i}: {rec['result']} 缺 reason（禁止 other/misc/空）")
            elif rec["result"] in ("TESTED_CLEAN", "CONFIRMED") and not rec.get("evidence_path"):
                errors.append(f"{path}:{i}: {rec['result']} 缺 evidence_path（无证据不结论）")
    return errors

def validate_jsonl(path, schema):
    errors = []
    req = schema["jsonl_required"]
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append(f"{path}:{i}: JSON 解析失败 {e}")
                continue
            for k in req:
                if k not in rec:
                    errors.append(f"{path}:{i}: 缺必填字段 {k}")
    return errors

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    all_errors = []
    for path in sys.argv[1:]:
        schema = find_schema(path)
        if not schema:
            all_errors.append(f"{path}: 无匹配 schema（文件名需以 attempts-/assets-/endpoints-/egress-health-/card_usage- 开头）")
            continue
        if "header" in schema:
            all_errors.extend(validate_tsv(path, schema))
        else:
            all_errors.extend(validate_jsonl(path, schema))
    if all_errors:
        print("校验失败：")
        for e in all_errors:
            print(f"  ✗ {e}")
        return 1
    print(f"校验通过：{len(sys.argv)-1} 个文件")
    return 0

if __name__ == "__main__":
    sys.exit(main())
