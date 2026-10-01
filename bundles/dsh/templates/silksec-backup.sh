#!/usr/bin/env bash
# Compatibility entrypoint: the versioned NAS repository owns backup and retention.
set -euo pipefail
exec python3 "{{BASE_DIR}}/dsh-maintenance.py" backup "$@"
