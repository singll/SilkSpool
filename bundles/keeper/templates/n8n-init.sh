#!/bin/sh
# ==============================================================================
#  n8n 入口脚本 - 环境变量热加载 + Owner 登录自愈
#
#  核心功能:
#    1. 从挂载的 .env 文件动态加载环境变量
#       → docker compose restart 即可加载新配置, 无需 up -d 重建容器
#       → 不重建容器 = 数据卷天然持久, 账号/工作流/凭证不会丢失
#    2. Owner 登录自愈 (启动前直接修库)
#       → 重建/备份恢复后 WebUI 登录凭证始终 = N8N_OWNER_EMAIL + N8N_PASSWORD
# ==============================================================================

ENV_FILE="/home/node/config/.env"
DB_FILE="/home/node/.n8n/database.sqlite"

log() { echo "[n8n-init] $*"; }

# --- 从挂载的 .env 加载环境变量 ---
if [ -f "$ENV_FILE" ]; then
    log "Loading environment from mounted .env"
    set -a
    . "$ENV_FILE"
    set +a
else
    log "WARNING: No .env file at $ENV_FILE, using Docker env vars only"
fi

# --- Owner 登录自愈 (启动前直接修库) ---------------------------------------
# 背景: n8n 判定 "owner 已设置" = lastActiveAt 非空 OR password 非空 (二者任一)。
#       备份恢复/重置后若 password 为 NULL, 而 lastActiveAt 已被 API Key 调用刷新,
#       实例会陷入死锁: 登录必败 (wrong credentials) 且 /setup 被拒 (already setup)。
# 策略: 每次启动前检查 owner 的 password, 为空则写入 N8N_PASSWORD 的 bcrypt 哈希,
#       email 为空则补 N8N_OWNER_EMAIL, 并把 isInstanceOwnerSetUp 置 true。
#       → 无论怎么重建, WebUI 登录凭证恒为 .env 中的 N8N_OWNER_EMAIL + N8N_PASSWORD
# 手动恢复 (密码非空但忘了): 把 .env 的 N8N_PASSWORD 改成想要的密码, 然后
#       docker exec sp-n8n n8n user-management:reset && docker restart sp-n8n
if [ -n "$N8N_PASSWORD" ] && [ -f "$DB_FILE" ]; then
    BCRYPTJS_DIR=$(find /usr/local/lib/node_modules/n8n/node_modules -type d -name bcryptjs 2>/dev/null | head -1)
    if [ -n "$BCRYPTJS_DIR" ]; then
        BCRYPTJS_DIR="$BCRYPTJS_DIR" DB_FILE="$DB_FILE" node --no-warnings -e '
const {DatabaseSync}=require("node:sqlite");
const bcrypt=require(process.env.BCRYPTJS_DIR);
const db=new DatabaseSync(process.env.DB_FILE);
try{
  const tbl=db.prepare("SELECT name FROM sqlite_master WHERE type=$t AND name=$n").get({t:"table",n:"user"});
  if(!tbl){console.log("[n8n-init] owner-heal: fresh database, skip");process.exit(0);}
  const cols=db.prepare("PRAGMA table_info(user)").all().map(c=>c.name);
  const roleCol=cols.includes("roleSlug")?"roleSlug":"role";
  const owner=db.prepare(`SELECT id,email,password FROM user WHERE ${roleCol}=$r`).get({r:"global:owner"});
  if(!owner){console.log("[n8n-init] owner-heal: no owner row, skip");process.exit(0);}
  if(owner.password){console.log("[n8n-init] owner-heal: owner password present, OK");process.exit(0);}
  const email=process.env.N8N_OWNER_EMAIL||owner.email;
  if(!email){console.log("[n8n-init] owner-heal: no email available (set N8N_OWNER_EMAIL), skip");process.exit(0);}
  db.prepare("UPDATE user SET password=$p, email=$e, firstName=COALESCE(firstName,$f) WHERE id=$id")
    .run({p:bcrypt.hashSync(process.env.N8N_PASSWORD,10),e:email,f:process.env.N8N_OWNER_FIRSTNAME||"Owner",id:owner.id});
  db.prepare("UPDATE settings SET value=$v WHERE key=$k")
    .run({v:"true",k:"userManagement.isInstanceOwnerSetUp"});
  console.log("[n8n-init] owner-heal: password restored for "+email);
}finally{db.close();}
' || log "owner-heal: FAILED (non-fatal, n8n will still start)"
    else
        log "owner-heal: bcryptjs not found in n8n modules, skip"
    fi
fi

# --- Owner 自动初始化 (全新数据卷: 等 n8n 建好库后走官方 setup 接口) ---------
if [ -n "$N8N_PASSWORD" ] && [ -n "$N8N_OWNER_EMAIL" ] && [ ! -f "$DB_FILE" ]; then
    (
        i=0
        while [ "$i" -lt 60 ]; do
            i=$((i+1)); sleep 5
            STATE=$(node --no-warnings -e '
fetch("http://127.0.0.1:5678/rest/settings").then(r=>r.json())
.then(s=>console.log(s?.data?.userManagement?.showSetupOnFirstLoad===true?"NEED_SETUP":"OK"))
.catch(()=>console.log("WAIT"));' 2>/dev/null)
            [ "$STATE" = "WAIT" ] && continue
            if [ "$STATE" = "NEED_SETUP" ]; then
                node --no-warnings -e '
const body=JSON.stringify({email:process.env.N8N_OWNER_EMAIL,
  firstName:process.env.N8N_OWNER_FIRSTNAME||"Owner",
  lastName:process.env.N8N_OWNER_LASTNAME||"Admin",
  password:process.env.N8N_PASSWORD});
fetch("http://127.0.0.1:5678/rest/owner/setup",{method:"POST",headers:{"Content-Type":"application/json"},body})
.then(r=>console.log("[n8n-init] owner-setup: HTTP "+r.status))
.catch(e=>console.log("[n8n-init] owner-setup: "+e.message));'
            else
                echo "[n8n-init] owner-setup: instance already set up"
            fi
            break
        done
    ) &
fi

# --- 变量映射 (适配 n8n 工作流中 $env.XXX 的引用名) ---
export BELLKEEPER_URL="${BELLKEEPER_INTERNAL_URL:-http://bellkeeper:8080}"
export HOST_DOCKER_INTERNAL="host.docker.internal"

# --- n8n 运行参数默认值 ---
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
export EXECUTIONS_DATA_PRUNE="${EXECUTIONS_DATA_PRUNE:-true}"
export EXECUTIONS_DATA_MAX_AGE="${EXECUTIONS_DATA_MAX_AGE:-168}"
export EXECUTIONS_DATA_PRUNE_MAX_COUNT="${EXECUTIONS_DATA_PRUNE_MAX_COUNT:-5000}"
export N8N_BLOCK_ENV_ACCESS_IN_NODE="${N8N_BLOCK_ENV_ACCESS_IN_NODE:-false}"

# --- 清理: 移除 n8n 不需要的敏感变量 ---
unset REDIS_PASSWORD BELLKEEPER_DB_PASSWORD COUCHDB_SECRET

# --- 启动 n8n (exec 替换当前进程, n8n 作为 PID 1) ---
log "Starting n8n..."
exec n8n start
