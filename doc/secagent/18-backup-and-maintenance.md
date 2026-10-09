# 18 · 备份、恢复与变更前维护

> 版本：1.2（2026-10-08）｜常驻正式契约，后续备份/更新流程在本页维护。用户已授权以质量和速度优先、现有业务数据与实现可舍弃；以下分级流程替代每次变更完整演练的旧要求。§7历史记录不改写。
> 原18号迁移路线图已改名为 [archive/migration-v4-to-v5.md](archive/migration-v4-to-v5.md)，仍保留在归档目录；历史迁移编号不代表本页章节。
> 工程源：`bundles/dsh/templates/`；生产：csai `/opt/silkspool/dsh/`。远程操作一律使用 PATH 中的 `spool`。时间表同时列北京时间（Asia/Shanghai）与宿主UTC。

## 1. 三类恢复保障

| 类型 | 用途与覆盖 | 边界 |
|---|---|---|
| 常规NAS快照 | 在线备份DSH、配置的外置工作区、证据/密钥/配置及SQLite副本；restic加密、块级去重，每个快照逻辑完整、可独立恢复 | 各SQLite分别一致，非跨库/文件同一时点；不暂停业务 |
| 变更前准备 `prepare-change` | 新备份＋**同一snapshot ID**的SQLite恢复校验＋带change ID的成功回执 | 按变更风险选用；普通修复不强制每批新跑，选用后不能把失败或旧回执记作成功 |
| 冻结恢复点 `freeze` | 排空并冻结完整写者清单，保留应用、工作区、运行时和宿主状态；沿用freeze/release状态机 | 用于确需保留的跨库一致性恢复、破坏性迁移或运行时升级；普通同版本代码发布不默认使用 |

## 2. 按变更风险执行（2026-10-08用户授权）

用户允许舍弃现有SilkSecAgent业务数据和实现以提高质量与速度。可选择清理、重建投影或替换模块，不再为保全每条旧记录无限延长任务；凭据、授权范围及新验收的原始证据仍是运行和结论所必需。授权不涉及n8n/Memos等其他服务。

| 变更 | 必要验证与恢复准备 | 不再默认执行 |
|---|---|---|
| 普通代码、查询/索引、可兼容增列、UI或可重建投影 | 固定包和受影响文件清单；相关回归；兼容性核查；保留旧代码或明确重建路径；生产启动与受影响业务冒烟 | 全工作区冻结快照、整树恢复、新旧应用各演练一次、发布后再做NAS恢复 |
| 舍弃受污染旧业务数据、重建派生索引/评分 | 明确重建范围和真相源，验证不会把旧弱标签当真值；无法重建的数据明确未知；检查新流程实际效果 | 逐条追索无原件的旧记录、恢复所有历史计数、要求新旧业务行数相同 |
| 必须保留数据的破坏性迁移、运行时大版本、跨库一致性或恢复工具变更 | 对受影响范围备份并验证迁移/恢复；需要时使用隔离副本和冻结；列出退出条件 | 与变更无关工作区的重复演练、无新证据的全流程重试 |

执行顺序：

1. 固定本批版本、变更范围、验收结果和回退/重建路径；相关修复合批。平时只跑受影响测试，最终集成跑一次；源码/环境未变不重复全域测试。跨进程执行、授权隔离、技术判定等重要行为保留相应故障/反例验证。
2. 只在上表需要备份时执行 `spool exec csai 'sudo bash /opt/silkspool/dsh/silksec-ops.sh prepare-change --change <ID>'`，核对退出0、change、snapshot、同ID的drill及覆盖范围。75或失败不是成功；不得伪造回执。已有可靠基线可以如实复用，会话续接只核对状态，不自动生成新快照。
3. 同步管理机模板并按固定包安装；DSH仍为0.1.7-rc.2，不无参数盲跑setup。上传前完成适用的恢复准备，普通发布可以使用文件级回退/可重建数据方案，不冒称执行了全量备份。
4. 测试、打包和耗时数据验证在停写前完成。停写仅覆盖切换、必要迁移及启动核验，普通发布目标10分钟内结束；达到10分钟仍未完成，应解除维护返回可运行状态，或采取已确定的前向修复/重建路径，不能原样开启下一轮整树循环。10分钟是止损检查点，不是服务可用性承诺。
5. 启动就绪和稳态性能分别记录。保留接口延迟与失败证据；单次冷启动统计超时先定位，不自动触发整树恢复，不靠无限重试获得偶然通过。只有影响执行正确性、授权隔离、证据真值或持续不可用的故障阻塞相应业务放行。
6. 服务及关键业务通过后立即恢复调度；检查受影响接口、必要数据关系及维护状态。 WebUI须同时核对silksecagent与silksecagent-edge，并经3080或正式域名完成认证浏览器冒烟；仅3081的RPC成功不足以证明入口可用。常规NAS继续按timer运行，不把发布后新备份/完整恢复作为普通发布关账条件。没有新证据不重跑相同失败阶段。

**工具边界**：这是现行执行政策，未宣称已重写freeze/release工具状态机。选用这些工具仍须满足其实际前置条件；普通修复可用已核对的同版本固定包路径，不制造虚假门禁回执。已经完成的本批备份/隔离结果直接复用；应急恢复不递归备份。只读巡检、本地修改与例行维护无需额外备份。

## 3. 存储、覆盖与配置

- TrueNAS独立数据集 `NAS/secagent-backup`，配额256GiB；SFTP专用账号 `secagent_backup`，仓库位于该数据集的 `restic` 子目录。不使用NFS共享（csai宿主禁止挂载，曾创建的NFS入口已撤销）。
- 配置文件 `/etc/silksec-maintenance.json`；状态/互斥锁/缓存/单份数据库暂存位于 `/var/lib/silksec-maintenance`，须在源目录之外。
- `base` 是DSH主目录；`extra_roots` 指定外置工作区，当前包括 `/home/silkspool/美团SRC`、`字节SRC`、`日常`。各根目录不得重叠。新工作区必须同步加入配置。
- 主目录 `data` 与工作区按SQLite文件头识别数据库，包括非 `.db` 后缀。在线backup API生成暂存副本，quick_check通过后纳入快照；原库及其WAL/SHM/journal排除，恢复时用副本覆盖。副本记录原数据库权限和UID/GID，root恢复时归位。
- 排除旧本地 `data/backups`/`backups`、配置的缓存路径；数据库探测跳过node_modules及软链。软链不跟随，外部目标须另列根目录；应用安装树不能存可变业务库。
- `exclude_paths` 当前显式排除 `日常/browser/.shared-browser-profile` 与 `日常/browser/.profiles`（隔离 profile 根）：Chromium性能库持续独占锁，曾导致120秒备份失败。目录源文件保留，**常规备份不含浏览器登录态**；若变更依赖登录态恢复，使用覆盖它的新冻结点。
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
# 手动仅备份；需新恢复基线的变更使用prepare-change
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

**冻结点校验期间禁止打开待校验树中的SQLite**：`mode=ro`仍可能创建或更新WAL/SHM，并使目录/共享内存元数据变化。只监控state/failure文件；查询使用独立SQLite镜像或另建可丢弃副本。`immutable=1`只能用于已验证且不依赖WAL的静态镜像，不适用于在线库。复制清单失败时，`tree-diff.json`记录source/copy/source-final及前100条路径/差异字段，不输出文件正文；失败恢复点不得启动或发布。

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

**隔离共享浏览器 profile（2026-10-09，统一界面 + 可自主增删）**：`browser.silksecagent.singll.net` 是**一个统一界面**——`/` 为管理页（列出 primary + 各隔离 profile，带“新增 profile”按钮），每个 profile 的隔离视图在**同域** `/p/<name>/`，页头显示 profile 名。primary（CDP 9222、profile `.shared-browser-profile`）由 `silksec-shared-browser.service` 承载、入口 `/p/primary/`；额外隔离 profile 由模板单元 `silksec-shared-browser@<name>.service` 承载（复用同一 `shared-browser-host.mjs`，独立 `SEC_BROWSER_PROFILE`+`CDP_PORT`），Cookie/Storage 与 primary 及其他 profile 完全隔离，可同时登录不同账号。

“新增/删除 profile”后端为 `silksec-browser-admin.service`（`dsh-browser-admin.mjs`，回环 9230，User=silkspool）：`GET/POST /profiles`、`DELETE /profiles/<name>`，经 `edge-Caddyfile` 反代到 `/_pool/*`。它以 `sudo -n`（`/etc/sudoers.d/silksec-browser-profiles` 单条免密）执行固定运维脚本 `sec-browser-profiles.sh {list|add <name> [--port N]|remove <name>|render|apply}`（profile 名 `[a-z0-9_-]{1,32}` 白名单，无 shell 注入面）。注册表 `data/browser-profiles.json`（644，仅名字/端口/目录，无秘密）；Caddy 片段 `edge-browser-profiles.caddy`（由 `edge-Caddyfile` import，为 primary 与各 profile 生成 `handle_path /p/<name>/*`）。新增 profile 须同步存在于 `exclude_paths`（当前以 `.profiles` 根整体排除）。profile 目录=登录态凭据，权限 700；`remove` 保留目录，不自动删登录态。

**DevTools 交互前端**：`inspect` 入口用**浏览器自带的 `/devtools/inspector.html`**（经 `/p/<name>/devtools/*` 反代到该 profile 的 CDP），不再依赖 `chrome-devtools-frontend.appspot.com`（该域在本网出口被 DNS 解析为 fake-IP、直连与代理均不可达，曾致 inspector 502）。

**反自动化指纹**：`shared-browser-host.mjs` 启动时设置普通 Windows Chrome UA、`--disable-blink-features=AutomationControlled`、`ignoreDefaultArgs:['--enable-automation']`，并对每个页面注入 init 脚本伪装 `navigator.webdriver=undefined`、`platform=Win32`、`languages=zh-CN`、非空 `plugins/mimeTypes`、`window.chrome`、`userAgentData` 及 WebGL vendor/renderer（Intel/ANGLE）。否则 headless-shell 的 `HeadlessChrome` UA、`webdriver=true`、`plugins=0`、SwiftShader WebGL 会被字节风控判为自动化（passport `send_code` 返回 `error_code=7 系统繁忙`）。可用 `SEC_BROWSER_HEADFUL=1` 切换带屏（配合 Xvfb）。

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

当变更依赖该恢复方案时，演练失败阻塞对应变更；可舍弃/重建的业务数据按§2选择其他具体路径，不能伪造恢复成功或削弱完整性检查。密钥丢失需从独立托管恢复，仓库本身无法代替密码。跨宿主灾备目前仍需人工准备基础运行环境与路径配置。旧 `silksec-backup.sh`/`retention.sh`/`silksec-restore.sh`仅兼容转发，restore不再支持覆盖在线生产库。

## 7. 已有验收与本次维护

- 2026-10-09执行政策生效：固定56bca28复用本批NAS/冻结/恢复/新旧应用结果，取消额外重复域/worker演练；首次维护stats超时记录仍失败，按用户授权前向恢复，不整树回退。北京时间00:02:38解除冻结，正常服务15域/授权/技术统计/46摘要/DB及六服务七timer通过，stats158/20毫秒。没有发布后再做NAS恢复，没有宣称冷启动缺陷根治，详见27号§15.119–120。此为分级执行，不是修改工具产生假通过。

- 2026-10-01维护基线（`27b592d`、`f696d21`）：完整范围5,646,539,344字节/40库备份306.41秒、新增121,176,510字节；快照 `a7c87eab…` 的SQLite恢复19.56秒通过。常规耗时受资源限制及新增范围影响，不能用手动初次85秒推算所有运行。
- 旧 `20260913-rc2`归档快照 `1725625f…`：逻辑97.77GB、新增4.82GB，完整读回和静态复核后本地removed=true；最新 `20260926-017`保留。宿主使用率27%→16.8%，可用702→约796GiB。
- 全域659/659、57表task/endpoint副本schema通过；预检130.21秒→缓存3.56秒。root冻结10项/发布恢复19项/快照6项、维护7项以及Go CLI/新增RPC检查通过。Go tools全包既有uptime测试失败曾用HEAD覆盖对照确认，未计为本批通过。
- 本次prepare-change维护测试10/10通过，覆盖真实restic恢复、失败不发布回执、CLI锁冲突75。部署前旧入口快照`0fd330c0…`（40库120.53秒/恢复7.34秒）通过后上传新脚本；新入口实测change `20261001-backup-contract-18`、snapshot `d5758fa6735b1f948dd4bbaf038320d02f7d357d7953d1916fa1c1e393cfc892`，40库备份32.38秒/恢复6.77秒、总计约41秒，成功回执已落盘。主服务PID=922156/NRestarts=0，未发布27号业务增量；当前进度见[PROGRESS](PROGRESS.md)。

- 2026-10-01 27号阶段发布：NAS新门禁`bdeedec6…`、重试`246f1e6a…`，完整冻结`777e3e6b…`及6根恢复应用预演通过；部署后snapshot`df226da14b56c7d0e9b633845b29aced5384bb23f58a2541f192c68cf2b4044c`，40库33.21秒/恢复6.51秒，覆盖新队列/费用账本和本次run。首次mode=ro查询副本干扰SHM导致冻结失败，原服务自动恢复，后续不查询pending树重做成功；快照差异诊断已部署，远端root快照7/冻结10/release19项通过。

- 2026-10-01 WP03发布恢复验证：变更前NAS `7e937747…`、部署后NAS `a82eff64…`（40库191.49秒、恢复6.88秒）；完整冻结`9c7457fe…`，最终三表归属声明修正另建`145a4c2f…`并完整恢复/隔离应用验证后恢复服务。两轮冻结校验及应用预演耗时较长，具体失败/重试与运行事实见27号§15.4；未改备份覆盖/排除范围。

- 2026-10-01 WP03输入计量发布：首次门禁NAS `2988bbaa…`，40库151.9秒/恢复8.9秒，续接同快照再恢复7.84秒；冻结manifest `be110d0c…` 六根完整恢复、63表与旧/新版应用及worker预演通过。北京时间20:23:04–21:46:00停写约82分56秒（含会话中断），已恢复六服务和维护timer。部署后NAS `239b4800aa64d48274cbace0466203346e169eea5e031d3f45b82d92af69e3d3`，40库168.44秒/恢复10.50秒通过，覆盖任务103398/103399与预算回执；覆盖及排除范围未变。详见27号§15.5。

- 2026-10-02失败usage修复：变更前NAS71348e25…，40库268.63秒/恢复6.83秒；冻结ef897819…六根恢复及63表、新旧应用预演通过。北京时间00:20:27–01:03:06停写42分39秒，失败与重试记录见27号§15.6。部署后NAS `136ff53f61ee8a5073334520191f0b23a7edc1610ca0b4e1280826067eedb1eb`，40库备份207.10秒/恢复6.75秒通过；六个维护timer与proxy-refresh.timer均active。27项关键证据SHA256SUMS已保存，本批phase=deployed-failed-usage-guard-accepted-expansion-held。覆盖/排除范围不变。

- 2026-10-02历史用量补账：变更前NAS `d7122308…`，40库36.07秒/恢复7.18秒；冻结`7bf493ae…`六根完整恢复、63旧表及新证据表、旧/新应用和worker17项通过。北京时间18:30:25–19:31:53停写约61分29秒；沙箱目录权限和两次RPC超时失败均保留。生产补账247项/重放增量0后恢复服务，UI80/80；部署后NAS `34bb4b0a9f19dc1aabf24c88de6b0e5f10be7f3cd7b28f386d0d107e3b3d8d86`，40库211.34秒/同快照恢复6.56秒通过，覆盖新证据与账本。46项发布证据摘要封存，六维护timer和proxy-refresh.timer恢复，覆盖/排除范围未变；详见27号§15.8。

- 2026-10-02逐请求终止证据：变更前NAS42ab0f22…（40库36.28秒/恢复6.81秒）；新冻结69b4899d…六根完整恢复，64表无新增，新旧应用与worker19项通过。北京时间20:27:55–21:07:20停写39分25秒，含旧版应用RPC超时后重试；生产静默冒烟、UI80/80及只读canary103401通过。部署后NAS `9dec3a2253472bc56f2162dfc8ee8c16f3f17633fe6feed9c59dd7b30b017d11`，40库备份199.13秒/同快照恢复6.90秒通过。新增results/worker-requests.jsonl在既有覆盖内，排除项未变；58项发布证据封存，六维护timer及刷新timer active，详见27号§15.9。

- 2026-10-02 WP04 HAR导入：变更前NASa09b15f6…（40库35.29秒/恢复6.97秒），冻结4691cef5…六根完整恢复、64表及新旧应用/隔离HAR165项/worker19项通过。北京时间22:12:04–22:49:00停写36分56秒，生产静默冒烟/UI80项及六服务恢复通过。首次冻结撞代理刷新、旧版RPC超时及UI两次启动时序失败均保留。部署后NAS `e01e75ca4147bc02b525056f555b5d0e0137df29e4b5690e6ce3a15b48f7a0f8`，40库216.34秒/同快照恢复6.90秒，新增data/evidence/requests位于既有备份根，排除项不变；55项证据封存，六维护timer及刷新timer active，详见27号§15.10。

- 2026-10-03 WP04浏览器采集：变更前NAS5f14f119…（40库40.41秒/恢复7.08秒），冻结`aa07b266a7f27ea974d65ef9f3db86c95a365afe406cf358bd6de6c13bb7ba4a`六根完整恢复、64表及新旧应用通过。北京时间11:09:30–12:03:48（UTC03:09:30–04:03:48）停写54分19秒；浏览器9项、endpoint/task166项、worker19项、生产静默冒烟/UI80项通过。旧版两次RPC超时、worker一次超时及浏览器夹具环境冲突均保留；只清除测试命令继承的SEC_DATA_DIR，不改生产守卫或超时阈值。部署后NAS `b05227e632536b11a04ebcc1753ebdac8363eeee7e1ade663ad6e9d576c7640b`，40库185.70秒/同快照恢复6.91秒。新增results/RUN/browser-capture在既有覆盖内，浏览器登录态排除不变；96项发布证据封存，六服务及七timer active，无恢复错误。详见27号§15.11。

- 2026-10-03 WP02读取前置：变更前NAS2b3570b2…（40库38.68秒/恢复6.62秒），冻结`9e229e517c5e26ed122f319f07272aea318d4fcb08ead28b6f677ca0029d994e`六根完整恢复、64表及新旧应用通过。北京时间19:12:54–19:49:46停写36分52秒；exec/endpoint/vuln166项、worker19项、生产静默冒烟与UI重跑80项通过。首次隔离启动因发布根0700不能穿越而拒绝，仅改根为0711后原验收通过，私有证据/恢复树内权限不变；UI首轮连接拒绝保留，确认监听后原门禁重跑通过。部署后NAS `bd1bd0daa2b6a0cf7bf2ea4b2a537986f40cc8ea4538d54e46ac648ddd0f303f`，40库249.01秒/同快照恢复6.48秒；前置回执与签封密钥沿用既有备份根，排除不变。64项证据封存并拉回验摘要，六服务与七timer恢复，无恢复错误；详见27号§15.12。

- 2026-10-06健康/采用/规划合批：新NAS0cbddcd1…（40库37.41秒/恢复7.44秒），新冻结e303e166…完整恢复/64表及新旧应用、282域契约和worker19项通过。北京时间10:45:13–11:30:13停写45分01秒，六服务七timer恢复、resume_errors=[]；旧版及生产首轮RPC超时保留、原门禁重跑通过，未放宽标准。覆盖排除不变，详见27号§15.73。

- 同批发布后NAS f217dbae533caba59321f4180f600214e381dd315816ad74c35e4f55678a885f，40库143.89秒/同快照恢复6.55秒通过；UI80/80。恢复范围/排除项不变。

- 2026-10-06 HTTP接线：新NAS305eb67e…40库32.57秒/同快照恢复7.44秒，新冻结8dc976ed…完整恢复/64表及新旧应用、exec58/worker19通过。北京时间11:47:14–12:44:00停写56分46秒，首次生产RPC超时后原门禁通过，六服务七timer恢复且resume_errors=[]。覆盖及排除不变；详见27号§15.76。

- HTTP同批发布后NAS7ae594827d35a38b0827c7bd2f98c2a4dee57531964c5f4cc1b7313c21f8edb2（40库123.78秒/同快照恢复6.90秒）和UI80/80通过，范围/排除未变。

- 2026-10-06学习/指标/索引合批：接续新NAS61e013f9…41库37.86秒/恢复8.98秒，冻结a0e537e4…六根完整恢复及新旧应用通过。北京时间19:18:33–20:01:33停写43分钟，首次stats超时后原门禁通过；18摘要/UI80及六服务七timer恢复。发布后NAS281fcb9bd9de7fe539ede5e335510399de80061ffa1604ba3019bc8484239efc，41库134.10秒/恢复6.80秒，范围/排除不变（新增HTTP私有bus.sqlite属于已有根）。详见27号§15.82。

- 2026-10-07学习真值/查询优化发布失败：新NAS73d60e3b…（41库38.71秒/同快照恢复6.77秒）、冻结44d3d50d…完整恢复及隔离验收通过；生产stats超时拒绝发布，保留新树并完整回退。北京时间17:38:56–18:37:08冻结58分11秒，六服务七timer恢复，resume_errors=[]，覆盖/排除不变；详见27号§15.91，不能记为成功上线。

- 2026-10-07学习真值/统计合批557ffd8：新NASed55b0c2…（41库89.42秒/同快照恢复6.76秒）、冻结fccb9d32…六根完整恢复/65表及新旧应用、九域555项/worker19项通过。北京时间19:11:41–20:05:43停写54分02秒，首次生产stats超时保留、第二轮临时采样下原门禁通过；临时dropin及采样清除，六服务七timer恢复、resume_errors=[]、UI80/80。发布后NAS736e9c22b37cd8a6674dfa9e49e3b2878f913a9a9bd61437f010196cb5e83019，41库147.68秒/同快照恢复6.84秒。覆盖排除未变，21份发布回执下载验摘要；详见27号§15.93。

- 2026-10-07反证/更正合批2ee0d19：新NAS41cbc268…（41库37.19秒/同快照恢复6.50秒），新冻结d43a564b…完整恢复/65表、新旧应用及九域567项/worker19项通过。北京时间21:15:37–21:50:06冻结34分30秒，生产首次原门禁通过，六服务七timer恢复、resume_errors=[]；UI首次超时保留，备份后原门禁80/80通过。发布后NAS e0e1966b342a61ba713cc0b94a198d6210fb4fd995c748bdec830d427a01b90d，41库122.85秒/同快照恢复6.80秒；覆盖排除不变，18份发布回执下载验摘要，详见27号§15.98。

- 2026-10-07候选接线dfd3b11：新NAS303f50e9…（41库42.76秒/恢复6.77秒）、冻结9b2a5298…完整恢复/65表、新旧应用、九域571项/worker19项通过。北京时间22:21:05–22:55:49冻结34分43秒后六服务七timer恢复、resume_errors=[]；生产首轮原门禁通过。发布后NAS5e8b90367f704cbb64395ee7145fb26dbaefc4004a709f441e8700a30a1be9d8（41库125.04秒/恢复7.00秒）、随后UI首轮80/80通过，18回执下载验摘要，覆盖排除不变。见27号§15.100。

- 2026-10-08启动日志读取改进（本地待发布）：current_launch_url按systemd ExecMainStartTimestamp限定journal时间，仍核验当前PID/InvocationID并读后复核。journalctl的15秒超时转为可重试的未就绪错误，仅允许已有启动总窗口内继续，不使用部分凭据；RPC10秒不变。真实首次故障、交错测量及6+7项回归见27号§15.108，未证明全部间歇超时根治。

- 2026-10-08终态审校ea57fdb发布失败已完整回退：新NAS45314f3c…、冻结8ebb60c4…完整恢复/65表、新旧应用、九域574项及worker19项通过；生产journalctl15秒超时拒绝发布。北京时间18:43:39–19:46:42冻结63分02秒后原dfd3b11与六服务七timer恢复，resume_errors=[]，20原版摘要/业务不变量通过。回退后NAS e72e4ad6e34490eea953676291f8097295ef643fa58808338a4b488c630feee5（41库417.46秒/同快照恢复7.01秒）、UI原门禁重跑80/80通过，首轮UI超时保留；23份回执封存，范围排除不变。详见27号§15.108。

2026-10-08发布状态：固定1cce966累计包生产stats超过10秒，已完整回退dfd3b11，不能将本地终态审校/Reviewer/历史评测/解析归属及后续增量标记为上线。六服务七timer与原预算/Scope保持，回退后新NAS4145419c…（41库55.71秒/恢复6.55秒）、UI80/80通过；详情见27号§15.115。

- 2026-10-09 D09（专项累计预算硬上限 + 预算审批人工化，change `20261009-d09-budget-cap`，固定 `6f019d0`）：普通同版本修复，按§2未做整树冻结/NAS 重跑。安装前断言 DSH 0.1.7-rc.2、3 模块 6 落点（源模板+已安装插件）旧摘要、无 running task/worker、Campaign 全 paused，旧源码存 `dsh-upgrades/20261009-d09-budget-cap/previous/`。停写到启动 1.36 秒；冒烟 `bus.status`12.4ms、`dashboard.stats`19.7ms、`task.campaign_get` 含 `lifetime_spent_tokens`、六服务 active/NRestarts0/journal err0、无运行任务/worker、quick_check ok。启动就绪约 38 秒，期间在开浏览器轮询 13 次 502 属既有冷启动现象，未归因本批、未宣称冷启动已修；未做发布后 NAS 恢复。见 27 号 §15.127/§18。
- 2026-10-09 D09 评审修复（change `20261009-d09-review-fix`）：修缺额任务饿死后续任务、停止/提请口径不一致、queued 却发 blocked 事件、审批 actor 契约冲突、预算判定越层放后端，并补反例测试。首次用阻塞式 `systemctl stop` 超 90s（应用优雅停止未在 `TimeoutStopSec` 内完成，既有间歇现象）在替换前退出，**文件未改**、当即恢复服务；改用 `--no-block` + 轮询停稳后重装成功，停写到启动 3.13 秒，旧源码入 `dsh-upgrades/20261009-d09-review-fix/previous/`。冒烟：三模块摘要一致、六服务 active/NRestarts0/journal err0、`bus.status`278.9ms(冷)/`stats`25.2ms/`scope.check`2.6ms/`know.health`76.6ms、Campaign 全 paused、无运行任务/worker、quick_check ok；未做发布后 NAS 恢复。见 27 号 §15.127/§17。
