#!/usr/bin/env bash
# Restore to a NEW directory only. Never stop production or replace a live WAL database.
set -euo pipefail
exec python3 "{{BASE_DIR}}/dsh-maintenance.py" restore-copy "$@"
