#!/usr/bin/env python3
"""在隔离恢复副本中执行全部领域契约和 owns×sandbox 检查。"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

base = Path(os.environ["SEC_BASE_DIR"])
out = Path("/tmp/dsh-rehearsal")
if not (out / "isolation.json").is_file():
    raise RuntimeError("只能在 dsh-upgrade-sandbox 中运行")
tests = sorted((base / "plugins").glob("sec-domain-*/test/contract-*.test.js"))
domains = {test.parent.parent.name for test in tests}
if len(domains) != 15 or len(tests) < 16:
    raise RuntimeError("未找到 bus + 14 域的完整契约测试")
fixture_home = Path(tempfile.mkdtemp(prefix="contract-home-"))
environment = {**os.environ, "SEC_DATA_DIR": str(fixture_home), "DSH_HOME": str(fixture_home)}
result = subprocess.run(["/usr/local/node/bin/node", "--test", *map(str, tests)],
                        env=environment, capture_output=True, text=True, timeout=180)
(out / "domain-contracts.tap").write_text(result.stdout + result.stderr)
counts = {key: int(value) for key, value in re.findall(r"^# (tests|pass|fail|skipped|cancelled) (\d+)$", result.stdout, re.M)}
report = {"domains": len(domains), "test_files": len(tests), **counts,
          "contracts_ok": result.returncode == 0 and counts.get("tests", 0) > 0 and counts.get("fail") == 0}
check = subprocess.run(["/usr/local/node/bin/node", str(base / "scripts/pipeline/sec-owns-sandbox-check.mjs"), "--json"],
                       env=os.environ, capture_output=True, text=True, timeout=60)
(out / "owns-sandbox.json").write_text(check.stdout)
(out / "owns-sandbox.stderr").write_text(check.stderr)
try:
    owned = json.loads(check.stdout)
    report["owns_sandbox"] = {"ok": check.returncode == 0 and owned.get("ok") and owned.get("domains_loaded") == 14,
                              "domains_loaded": owned.get("domains_loaded"), "checks": len(owned.get("checks", [])),
                              "violations": owned.get("violations")}
except ValueError:
    report["owns_sandbox"] = {"ok": False}
report["ok"] = report["contracts_ok"] and report["owns_sandbox"]["ok"]
(out / "contracts-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(report))
raise SystemExit(0 if report["ok"] else 1)
