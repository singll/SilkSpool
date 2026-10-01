# 18 · 备份、恢复与变更前维护

> 版本：1.0（2026-10-01）｜常驻正式契约，后续备份/更新流程在本页维护。
> 原18号迁移路线图已改名为 [archive/migration-v4-to-v5.md](archive/migration-v4-to-v5.md)，仍保留在归档目录；历史迁移编号不代表本页章节。
> 工程源：`bundles/dsh/templates/`；生产：csai `/opt/silkspool/dsh/`。远程操作一律使用 PATH 中的 `spool`。时间表同时列北京时间（Asia/Shanghai）与宿主UTC。

## 1. 三类恢复保障

| 类型 | 用途与覆盖 | 边界 |
|---|---|---|
| 常规NAS快照 | 在线备份DSH、配置的外置工作区、证据/密钥/配置及SQLite副本；restic加密、块级去重，每个快照逻辑完整、可独立恢复 | 各SQLite分别一致，非跨库/文件同一时点；不暂停业务 |
| 变更前准备 `prepare-change` | 本次生产写入之前，新备份＋**同一snapshot ID**的SQLite恢复校验＋带change ID的成功回执 | 不执行更新、不启动恢复副本、不代替发布冻结；每次新变更重跑 |
| 冻结恢复点 `freeze` | 排空并冻结完整写者清单，保留应用、工作区、运行时和宿主状态；沿用freeze/release状态机 | 版本切换、数据演进及跨库/证据一致性恢复仍需新冻结点、隔离应用预演与小批验收 |

## 2. 每次变更前的固定流程

适用：生产代码/插件/配置/依赖更新、数据库修复迁移、服务重建、手工非例行清理。**先备份，再进行首次远端写入**。`spool bundle dsh setup`会先上传模板，所以不能等setup开始或结束才备份。

1. 在本地完成修改与相关验证；明确本批change ID、目标版本、写入目录、数据库和恢复方案。检查§3覆盖及排除范围；新增工作区、宿主文件或浏览器登录态不能假定已覆盖。
2. 执行以下命令，必须退出0。NAS不可达、空间不足、备份/恢复失败、锁冲突75均停止正常变更，排除原因后重跑；不把定时服务的 `Result=success` 当作本次备份凭证。

   ```bash
   spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh prepare-change --change 20261001-maintenance-update'
   ```

3. 核对返回的 `change`、新 `snapshot_id`、`backup`、`drill`（ID相同）、时间、`roots`/`exclude_paths`。回执在 `/var/lib/silksec-maintenance/last-prepare-change.json`（0600）。每次开始有效prepare会清掉旧成功回执，备份或drill失败不写成功回执；锁冲突时旧文件可能还在，**只接受本次命令退出0的结果**。回执不等于快照永久保留，也不是可绕过门禁的授权令牌。
4. 记录change ID/snapshot ID到本批执行记录或PROGRESS；同批连续步骤可复用本次结果，范围/排除变化或中断后续接须重验。采用 `&&` 或 `set -e`，失败不能继续；禁止用 `;`、`|| true`掩盖备份失败。
5. 备份成功后再同步管理机模板 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/`，按本批已验证清单上传/安装。维护脚本可独立安装；应用发布明确固定现役DSH版本（当前0.1.7-rc.2，setup默认仍为0.1.5-rc.2，不可无参数盲跑）。
6. 涉及发布切换时：新冻结点 → 隔离副本/schema与应用预演 → 发布 → 冒烟 → 恢复调度 → 小批运行观察。失败走已演练恢复流程，保留新队列/回执/签封密钥/证据，不仅回退代码。
7. 变更后检查服务、错误、业务不变量、维护timer和恢复能力，回填本页及对应模块/PROGRESS，验证通过后提交推送。

**执行边界**：这是项目规则强制的操作顺序，`prepare-change`自身自动完成备份/校验；目前没有拦截所有底层 `spool exec/sync/setup` 的全局钩子，执行者必须主动先调用。只改本地代码/文档或只读巡检，无需为每个动作远程备份。例行备份/保留清理按§5运行，不递归备份。故障窗口中的必要恢复按已有恢复方案执行，不用NAS不可达阻塞应急恢复。服务重建继续遵守既有用户批准要求。

## 3. 存储、覆盖与配置

- TrueNAS独立数据集 `NAS/secagent-backup`，配额256GiB；SFTP专用账号 `secagent_backup`，仓库位于该数据集的 `restic` 子目录。不使用NFS共享（csai宿主禁止挂载，曾创建的NFS入口已撤销）。
- 配置文件 `/etc/silksec-maintenance.json`；状态/互斥锁/缓存/单份数据库暂存位于 `/var/lib/silksec-maintenance`，须在源目录之外。
- `base` 是DSH主目录；`extra_roots` 指定外置工作区，当前包括 `/home/silkspool/美团SRC`、`字节SRC`、`日常`。各根目录不得重叠。新工作区必须同步加入配置。
- 主目录 `data` 与工作区按SQLite文件头识别数据库，包括非 `.db` 后缀。在线backup API生成暂存副本，quick_check通过后纳入快照；原库及其WAL/SHM/journal排除，恢复时用副本覆盖。副本记录原数据库权限和UID/GID，root恢复时归位。
- 排除旧本地 `data/backups`/`backups`、配置的缓存路径；数据库探测跳过node_modules及软链。软链不跟随，外部目标须另列根目录；应用安装树不能存可变业务库。
- `exclude_paths` 当前显式排除 `日常/browser/.shared-browser-profile`：Chromium性能库持续独占锁，曾导致120秒备份失败。目录源文件保留，**常规备份不含浏览器登录态**；若变更依赖登录态恢复，使用覆盖它的新冻结点。
- `/etc`的systemd配置、`/usr/local/node`、管理机配置/私钥不在上述常规根目录内；涉及这些资源的变更须单独备份或纳入冻结清单。仓库密码、SFTP私钥、固定known_hosts和维护配置在管理机 `/opt/SilkSpool/keys/secagent-backup/` 托管，权限0700/0600，不入git、不输出密钥。配置或密钥变化须同步托管副本。

| 配置项 | 当前约定 |
|---|---|
| `repository` | SFTP restic仓库地址；挂载方式仅兼容，必须验证findmnt源和文件系统类型，禁止断挂后落本地 |
| `password_file` / `ssh_key` / `known_hosts` | 宿主受控文件；密码为普通文件且无组/其他用户权限，SSH严格校验固定主机密钥 |
| `keep_last` | 默认8，可设2–32；成功的routine快照参与保留 |
| `min_free_bytes` | 默认20GiB；低于阈值拒绝开始新备份 |
| `max_backup_age_seconds` | 默认86400（24小时） |
| `host` / `upgrade_root` | 默认csai / DSH同级dsh-upgrades；用于保留分组及归档边界 |

## 4. 备份、恢复与预演命令

```bash
# 状态：磁盘、NAS可达性、最后备份/恢复/检查、新鲜度
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh status'
# 手动仅备份；正常变更应使用prepare-change
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh backup'
# SQLite恢复演练，默认最后成功快照，也可指定ID
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh drill --snapshot SNAPSHOT_ID'
# 完整恢复到一个尚不存在的绝对路径，目标不能位于生产/状态/工作区内部
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh restore-copy --snapshot SNAPSHOT_ID --target /opt/silkspool/recovery-CHANGE_ID'
# 仓库检查与块空间回收
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh check'
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh prune'
# 本地契约预检；数据库只在临时副本演进
python3 bundles/dsh/templates/dsh-release-preflight.py --templates bundles/dsh/templates --database /path/to/backup-image.db
```

`drill`仅恢复暂存的SQLite与manifest，校验sha256/integrity_check，结束删除临时副本；不恢复整树、不启动应用。`restore-copy`调用restic `--verify`恢复完整文件树（目标下保留源绝对路径的目录层次），校验并归位DB副本；`restore-report.json`始终 `safe_to_start=false`。启动前必须隔离路径、凭据、网络，校对UID/权限及宿主依赖，做应用验证，不能直接覆盖在线WAL库。

`preflight`输入包含模板字节、脚本自身、Node路径/版本、平台及相关环境；组装树也须字节匹配才复用契约结果。模板变动立即失效，`--force`强制重跑。指定DB时，每次仍在临时副本验证task/endpoint schema、原表行数及完整性；不是全部域迁移或应用启动验收。`silksec-ops.sh`还转发freeze/resume/restore-frozen/rehearse/release，具体参数使用各自 `--help`；原release状态机和冻结守卫不变。冻结期间自动停止并恢复已安装维护单元。

## 5. 常驻调度、保留与清理

| 单元后缀（前缀silksec-maintenance-） | 北京时间 | 宿主UTC | 行为 |
|---|---|---|---|
| backup | 02:17、08:17、14:17、20:17 | 00/6:17 | 每6小时备份，留最近8个routine成功快照 |
| check | 周日11:17 | 周日03:17 | 仓库检查＋读取5%数据 |
| drill | 周日12:17 | 周日04:17 | NAS SQLite恢复校验 |
| prune | 周日13:17 | 周日05:17 | 回收无引用块，单次重打包上限2GiB |
| cleanup | 每日13:30 | 每日05:30 | 本地备份/日志有界清理 |
| health | 每15分钟 | 每15分钟 | 健康与备份过期检查 |

timer采用Persistent与最多120秒随机延迟。服务为root（读证书所需），UMask0077，CPUQuota50%、MemoryMax1GiB、Nice15、idle IO、2小时超时、PrivateTmp和NoNewPrivileges。原silksec-backup/retention timer停用。只有初始化空仓库时运行`init`，不得每次setup初始化仓库。

- 全部写维护操作共用非阻塞flock；锁冲突退出75。定时服务将75记作跳过成功，下周期再试；**变更前门禁不得把75当成功**。status不占锁。
- 备份先打pending标签，成功后才标routine并发布last-backup。备份失败不淘汰最后成功副本；routine保留8份、pending最多1份，forget只删索引引用，prune才回收无引用数据块。
- cleanup：旧本地图快照留2份，先quick_check保留副本；audit/events活动JSONL超过50MiB轮转，`.bak`各留3份（bus内置`.1`轮转独立）。不按年龄删除results/flows/evidence/sessions、不删业务表。默认只列计划，`--apply`才删除；例行timer已带apply。
- archive-release：只接受升级根目录的日期命名直接子目录；最新发布目录固定保留。无未解除冻结、进程/软链引用或挂载才允许归档；完整备份＋全仓库read-data校验后再次静态比对，成功才允许`--apply`删除本地。NAS保留最近3个release-archive快照，不修改封存升级STATE。

```bash
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh cleanup'
# 手工清理须先按§2备份；例行清理按上述保留策略
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh cleanup --apply'
spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh archive-release --path /opt/silkspool/dsh-upgrades/OLD_RELEASE --apply'
```

## 6. 故障与容量边界

80%磁盘使用告警；90%或可用空间低于20GiB为严重并拒绝新备份暂存。NAS不可达、24小时无成功备份或磁盘非ok时status非零；查看对应systemd service的journal。告警尚未接入外部通知，不能保证证据无限增长而永不满盘；需定期审查容量、引用感知归档或扩容。容量阈值检查不等于自动删除业务证据。

恢复演练失败不放行正常变更；不能伪造回执或削弱完整性检查。密钥丢失需从独立托管恢复，仓库本身无法代替密码。跨宿主灾备目前仍需人工准备基础运行环境与路径配置。旧 `silksec-backup.sh`/`retention.sh`/`silksec-restore.sh`仅兼容转发，restore不再支持覆盖在线生产库。

## 7. 已有验收与本次维护

- 2026-10-01维护基线（`27b592d`、`f696d21`）：完整范围5,646,539,344字节/40库备份306.41秒、新增121,176,510字节；快照 `a7c87eab…` 的SQLite恢复19.56秒通过。常规耗时受资源限制及新增范围影响，不能用手动初次85秒推算所有运行。
- 旧 `20260913-rc2`归档快照 `1725625f…`：逻辑97.77GB、新增4.82GB，完整读回和静态复核后本地removed=true；最新 `20260926-017`保留。宿主使用率27%→16.8%，可用702→约796GiB。
- 全域659/659、57表task/endpoint副本schema通过；预检130.21秒→缓存3.56秒。root冻结10项/发布恢复19项/快照6项、维护7项以及Go CLI/新增RPC检查通过。Go tools全包既有uptime测试失败曾用HEAD覆盖对照确认，未计为本批通过。
- 本次prepare-change维护测试10/10通过，覆盖真实restic恢复、失败不发布回执、CLI锁冲突75。部署前旧入口快照`0fd330c0…`（40库120.53秒/恢复7.34秒）通过后上传新脚本；新入口实测change `20261001-backup-contract-18`、snapshot `d5758fa6735b1f948dd4bbaf038320d02f7d357d7953d1916fa1c1e393cfc892`，40库备份32.38秒/恢复6.77秒、总计约41秒，成功回执已落盘。主服务PID=922156/NRestarts=0，未发布27号业务增量；当前进度见[PROGRESS](PROGRESS.md)。
