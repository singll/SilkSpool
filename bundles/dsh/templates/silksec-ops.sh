#!/usr/bin/env bash
# Common operational entrypoint; production writes still use explicit release/freeze state.
set -euo pipefail
BASE_DIR="${DSH_BASE_DIR:-{{BASE_DIR}}}"
action="${1:-status}"
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in
  status|init|backup|check|prune|drill|cleanup|archive-release|restore-copy)
    exec python3 "$BASE_DIR/dsh-maintenance.py" "$action" "$@" ;;
  preflight)
    exec python3 "$BASE_DIR/dsh-release-preflight.py" "$@" ;;
  freeze)
    exec python3 "$BASE_DIR/dsh-upgrade-freeze.py" capture "$@" ;;
  resume)
    exec python3 "$BASE_DIR/dsh-upgrade-freeze.py" resume "$@" ;;
  restore-frozen)
    exec python3 "$BASE_DIR/dsh-upgrade-snapshot.py" restore-copy "$@" ;;
  rehearse)
    exec python3 "$BASE_DIR/dsh-upgrade-sandbox.py" "$@" ;;
  release)
    exec python3 "$BASE_DIR/dsh-upgrade-release.py" "$@" ;;
  *) echo 'actions: status backup check prune drill cleanup archive-release restore-copy preflight freeze resume restore-frozen rehearse release' >&2; exit 2 ;;
esac
