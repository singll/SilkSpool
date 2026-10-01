#!/usr/bin/env bash
# Compatibility entrypoint. Never expire business evidence solely by directory age.
set -euo pipefail
exec python3 "{{BASE_DIR}}/dsh-maintenance.py" cleanup --apply "$@"
