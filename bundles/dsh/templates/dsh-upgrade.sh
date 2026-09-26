#!/usr/bin/env bash
# 生产入口只交换已经验收封存的完整产物；不查询 latest、不在线安装、不只回滚 npm。
# 经 spool exec 分阶段使用，不能以 spool bundle upgrade 的模板覆盖代替冻结恢复点。
set -euo pipefail
BASE_DIR="${SEC_BASE_DIR:-{{BASE_DIR}}}"
version="${DSH_TARGET_VERSION:-0.1.5-rc.2}"
source_version="${DSH_SOURCE_VERSION:-0.1.2-rc.1}"
release_dir='' freeze_state='' action=switch
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) version="${2:?缺少版本}"; shift 2 ;;
        --source-version) source_version="${2:?缺少源版本}"; shift 2 ;;
        --release-dir) release_dir="${2:?缺少发布目录}"; shift 2 ;;
        --freeze-state) freeze_state="${2:?缺少冻结状态}"; shift 2 ;;
        --rollback) action=rollback; shift ;;
        -h|--help)
            echo 'usage: dsh-upgrade.sh --version 0.1.7-rc.2 --source-version 0.1.5-rc.2 --release-dir DIR --freeze-state DIR [--rollback]'
            echo '       受控组合：0.1.2-rc.1 → 0.1.5-rc.2（历史默认）、0.1.5-rc.2 → 0.1.7-rc.2'
            exit 0 ;;
        *) echo "[upgrade][ERROR] 不支持参数 $1；不允许跳过验收。" >&2; exit 1 ;;
    esac
done
case "$source_version→$version" in
    '0.1.2-rc.1→0.1.5-rc.2'|'0.1.5-rc.2→0.1.7-rc.2') ;;
    *) echo "[upgrade][ERROR] 不支持的升级组合 $source_version → $version；只允许受控组合。" >&2; exit 1 ;;
esac
if [ -z "$release_dir" ] || [ -z "$freeze_state" ]; then
    echo '[upgrade][ERROR] 必须明确目标版本、已准备发布目录和持有中的完整冻结点；先完成 U-A～I。' >&2
    exit 1
fi
# release.py 以环境变量读取本次「源 → 目标」对；不接受默认组合覆盖。
export DSH_TARGET_VERSION="$version" DSH_OLD_VERSION="$source_version"
exec python3 "$BASE_DIR/dsh-upgrade-release.py" "$action" --release-dir "$release_dir" --freeze-state "$freeze_state"
