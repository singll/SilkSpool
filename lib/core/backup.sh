#!/bin/bash
# ==============================================================================
#  备份模块
#  功能: 将远程的数据卷或数据库备份到本地
# ==============================================================================

LIB_DIR=$(cd "$(dirname "$0")" && pwd); source "$LIB_DIR/../../config.ini"; source "$LIB_DIR/utils.sh"
ACTION=$1; HOST=$2; SSH_OPT="-i $SSH_KEY_PATH"

[ -z "$HOST" ] && exit 1
LOGIN=${HOST_INFO[$HOST]}
DATE_STR=$(date +%Y%m%d_%H%M%S)
LOCAL_STORE="$BACKUP_DIR/$HOST/$DATE_STR"
RULES_STR=$(get_host_backups "$HOST"); read -r -a RULES <<< "$RULES_STR"

if [ "$ACTION" == "backup" ]; then
    log_step "Starting backup $HOST -> $LOCAL_STORE"
    mkdir -p "$LOCAL_STORE"

    for rule in "${RULES[@]}"; do
        IFS=':' read -r type src name <<< "$rule"
        log_info "Backing up: $name ($type)..."
        REMOTE_TMP="/tmp/bk_${name}.tar.gz"
        CMD=""

        # 根据类型生成不同的备份命令
        case "$type" in
            "volume")
                # 挂载卷到 alpine 容器中打包
                CMD="docker run --rm -v $src:/data -v /tmp:/backup alpine tar czf /backup/$(basename $REMOTE_TMP) -C /data ."
                ;;
            "dir")
                CMD="tar czf $REMOTE_TMP -C $(dirname $src) $(basename $src)"
                ;;
            "db-mysql")
                # 导出 MySQL
                CMD="docker exec $src mysqldump -u root -p\${MYSQL_ROOT_PASSWORD} --all-databases | gzip > $REMOTE_TMP"
                ;;
            "db-pg")
                # 导出 PostgreSQL
                CMD="docker exec $src pg_dumpall -U postgres | gzip > $REMOTE_TMP"
                ;;
        esac

        # 执行远程命令 -> 下载文件 -> 删除远程临时文件
        if ssh $SSH_OPT "$LOGIN" "$CMD"; then
            scp -q $SSH_OPT "$LOGIN:$REMOTE_TMP" "$LOCAL_STORE/$name.tar.gz"
            ssh $SSH_OPT "$LOGIN" "rm -f $REMOTE_TMP"
            echo "[OK] Backup completed: $name"
        else
            log_err "Backup failed: $name"
        fi
    done
fi
