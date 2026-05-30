# 存储与同步

> TrueNAS 是 SilkSpool 的存储平面。这里讨论的是**长期分层、数据边界与应用挂载关系**，不是围绕当前 `main/*` 目录现状做兼容式修补。
> Windows 侧把 `raw / working` 导入 Vault 的执行入口已独立为 `SilkFiles` 项目；本模块只定义存储边界，不再把 `doc/modules/notes/setup/` 下的脚本副本视为当前入口。

---

## 角色定位

TrueNAS 负责承接以下长期数据：

- 知识原始资料与导出物
- 项目附件、实验产物与大文件
- Windows 便携工具与跨设备工作集
- 媒体库、直播录像、归档、私有文件
- 快照、备份与冷数据沉淀

它不是笔记结构规范的权威来源；笔记结构由 [../notes/README.md](../notes/README.md) 定义。

---

## 数据类型与同步策略

| 数据类型 | 主归属 | 推荐同步方式 | 说明 |
|---------|--------|-------------|------|
| PKB / Markdown 笔记 | Markdown / Obsidian 主库 | LiveSync / CouchDB | 这是最终知识库前端，不走 SMB / Syncthing 通用文件同步 |
| Raw / Working 附件与资料 | TrueNAS knowledge / projects | SMB / SFTP / Rclone / 手动归档 | 承接原始采集与工作层资产，不等同于 PKB |
| 便携工具目录 | TrueNAS 同步区 | Rclone bisync | 适合二进制和按需双向同步 |
| Git 项目代码 | Git 仓库 | Git | 大资产另放 TrueNAS，不混进仓库 |
| 私有文件 | TrueNAS 私有区 | 受控同步 / 加密同步 | 与共享资料隔离 |
| 媒体库 | TrueNAS 媒体区 | SMB / 流媒体应用 | 与知识资料分层 |
| 归档与备份 | TrueNAS 归档区 | 定时备份 / 快照 | 冷数据单独管理 |

---

## 推荐的长期分层

这里强调的是**功能层**，不是要求立即采用某个固定字面路径：

| 层级 | 作用 |
|------|------|
| `inbox/` | 临时接收、待整理、下载中转 |
| `knowledge/` | 书籍、论文、参考资料、知识附件、导出物 |
| `sync/` | 需要多设备共享的工作集，如便携工具 |
| `projects/` | 不适合进 Git 的项目资产、素材、产物 |
| `media/` | `books/`、`movies/`、`music/`、`pictures/`、`tv/`、`recordings/` 等媒体类 |
| `private/` | 敏感资料、凭证、私有归档 |
| `archive/` | 长期保留但低频访问的数据 |

当前 `main/books`、`main/downloads`、`main/knowledge`、`main/movies`、`main/music`、`main/pictures`、`main/tvseries`、`main/Live_Recordings` 等只应视为**迁移输入清单**，不是未来命名和层级的约束。

---

## 推荐的 TrueNAS 落地方式

功能层仍然是权威；但在 TrueNAS 上，推荐给它一个统一的人类可读实现根：

```text
POOL/data/
├── inbox/
├── knowledge/
├── sync/
├── projects/
├── media/
│   ├── books/
│   ├── movies/
│   ├── music/
│   ├── pictures/
│   ├── tv/
│   └── recordings/
├── private/
└── archive/
```

结论：

- `data/` **是合理的**，适合作为实现层根目录
- 真正稳定的抽象仍然是 `inbox / knowledge / sync / projects / media / private / archive`
- 以后即使路径微调，也应尽量保持这组功能层不变

---

## MVP-first：如何基于 `data/` 落地

如果目标是先做一个**少工具依赖、但可多端访问**的最小知识系统，推荐把 TrueNAS `POOL/data/` 作为**文件资产与共享目录基座**，但不要把它误当成 Obsidian 主 Vault 的同步方式。

### 推荐落地关系

```text
POOL/data/
├── knowledge/
│   ├── raw/           # 原始资料、网页保存、截图、导出包、导入文件
│   ├── working/       # AI 摘要、阶段性整理、日报素材、待归档内容
│   └── pkb-assets/    # 已进入 PKB 但不适合直接放进 Vault 的附件与导出物
├── sync/
│   └── works/
│       └── knowledge-mvp/   # 需要跨设备共享的临时工作集（可选）
└── archive/
    └── knowledge/     # 长期低频知识归档（可选）

Windows 本地导入缓冲区
└── D:\SilkSpoolImport\
    ├── raw\
    └── working\

Windows / 多端本地
└── D:\Notes\obsidian-note
    ├── 00-Inbox/
    ├── RAW/
    ├── WORKING/
    ├── KNOWLEDGE/
    └── Daily/
```

### 三层模型与目录映射

| 知识层 | 文件资产主落点 | 笔记主落点 | 说明 |
|------|-----------|-----------|------|
| Raw Capture | `POOL/data/knowledge/raw` | Vault `RAW/` | TrueNAS 承接原始文件资产；导入后进入 Vault 的 Markdown 原料笔记落到 `RAW/` |
| Working Layer | `POOL/data/knowledge/working` | Vault `WORKING/` | AI 输出、阶段性中间产物先放 working；导入到 Vault 后再继续整理 |
| PKB | `POOL/data/knowledge/pkb-assets`（附件资产） | Vault `KNOWLEDGE/` | 最终知识主库仍以 Markdown / Obsidian + LiveSync 为主 |
| 导入缓冲区 | Windows `D:\SilkSpoolImport\raw|working` | 不属于 Vault | 受控把 TrueNAS 文件资产带到当前设备，供统一脚本更新 Vault |

### 为什么不建议把完整 PKB 直接放进 TrueNAS 共享同步

因为三类东西的同步特性不同：

- **笔记主库**需要低摩擦编辑、冲突处理、接近实时的多端同步，适合 LiveSync。
- **原始资料和大附件**更适合 TrueNAS + SMB / SFTP / Rclone。
- **导入缓冲区**适合作为当前设备上的受控中转层，而不是长期主库。
- **Windows 工具与工作集**更适合 `data/sync`，不应与知识主库混在一起。

所以最小可用方案不是“所有目录都统一走 SMB / Rclone”，而是：

- **PKB 主库**：单 Vault + LiveSync
- **Raw / Working 文件资产**：TrueNAS
- **Raw / Working 进入 Vault**：Windows 本地导入缓冲区 + 统一 PowerShell 脚本
- **跨设备工具/工作集**：`data/sync`

统一 PowerShell 入口已经独立迁入 `SilkFiles` 项目：

- 执行入口：`SilkFiles/files.ps1`
- 规则说明：[../notes/setup/windows-knowledge-sync.md](../notes/setup/windows-knowledge-sync.md)

当前应通过 `SilkFiles/files.ps1 knowledge ...` 执行拉取、导入与刷新。该入口默认采用：Markdown 优先导入、成功即清理缓冲区、外置资产生成相对路径索引页。这样可以避免在 Windows 上长期保留 TrueNAS 缓冲副本和 Vault 副本两份同实体文件。

### 推荐实施步骤

#### Step 1：先准备 TrueNAS 目录

至少确认以下目录存在：

- `POOL/data/knowledge/raw`
- `POOL/data/knowledge/working`
- `POOL/data/knowledge/pkb-assets`

如果还没有，可继续在现有 `NAS/data/knowledge` 下创建普通目录，先不必再次拆 dataset。

#### Step 2：把多端共享文件先放到 TrueNAS

优先迁入这些内容：

- 网页保存包、PDF、导出 Markdown、截图
- AI 摘要导出物、日报素材、待整理汇总
- 不适合进 Vault 的大附件与配套资料

#### Step 3：在 Windows 创建本地 Vault 与导入缓冲区

继续使用：

- `D:\Notes\obsidian-note`

并通过 [../notes/setup/windows-vault-bootstrap.md](../notes/setup/windows-vault-bootstrap.md) 与 [../notes/setup/livesync-checklist.md](../notes/setup/livesync-checklist.md) 完成：

- Vault 目录初始化（含 `RAW/`、`WORKING/`、`KNOWLEDGE/`）
- Windows 本地导入缓冲区初始化（`D:\SilkSpoolImport\raw`、`D:\SilkSpoolImport\working`）
- Obsidian 配置
- LiveSync 接入 CouchDB

#### Step 4：定义统一导入与人工流转

最小可用阶段先按“统一脚本 + 人工整理”跑通：

1. 外部资料先进入 `POOL/data/knowledge/raw`
2. AI 输出、阶段性汇总、待筛选内容先进入 `POOL/data/knowledge/working`
3. 在 Win11 打开 Obsidian 后，运行统一 PowerShell 脚本 / 快捷方式
4. 脚本先把 `raw / working` 同步到 `D:\SilkSpoolImport\raw|working`
5. 脚本再把适合进入知识系统的内容更新到 Vault `RAW/` / `WORKING/`
6. 用户在同一个 Vault 中继续整理、移动、改写或派生到 `KNOWLEDGE/`
7. 大附件、导出物、配套文件回落到 `pkb-assets`

推荐把统一脚本理解为内部串联三步：

- **同步步骤**：TrueNAS → Windows 本地导入缓冲区
- **导入步骤**：本地导入缓冲区 → Vault `RAW/WORKING`
- **刷新步骤**：触发 Obsidian 重扫或依赖文件监听自动刷新

#### Step 5：再按需补自动化

只有当上面的手工流转已经稳定后，才建议增加：

- RSS / 爬虫自动写入 `raw`
- AI 自动总结写入 `working`
- K07 / 检索系统消费高价值 PKB 或 Working 内容

### 一句话结论

- **是的，TrueNAS `data/` 应该成为 MVP-first 的文件资产基座。**
- **但不建议把完整 PKB 目录也直接改成 NAS 文件同步主链路。**
- 更推荐的结构是：**TrueNAS 承接 raw / working / assets，Windows 本地导入缓冲区承接受控同步，Obsidian 单 Vault 承接 `RAW/WORKING/KNOWLEDGE`，统一 PowerShell 脚本负责把 raw / working 更新进 Vault。**

---

## 功能层 → dataset / 目录 → 应用联动

推荐把 `POOL/data/*` 一级目录建成独立 dataset；具体业务子目录按需要继续拆分 dataset 或普通目录。

| 功能层 | 推荐 TrueNAS 落点 | 主要生产者 | 主要消费者 | 说明 |
|------|------------------|-----------|-----------|------|
| `inbox` | `POOL/data/inbox` | qBittorrent、手工上传、临时采集 | FileBrowser、人工整理流程 | 下载中转和待整理入口 |
| `knowledge` | `POOL/data/knowledge` | 手工归档、资料整理、导出流程 | FileBrowser、Komga、知识管道 | 存书籍、论文、知识附件、导出物 |
| `sync` | `POOL/data/sync` | Rclone bisync、人工同步 | FileBrowser、跨设备工作流 | 承接便携工具和共享工作集 |
| `projects` | `POOL/data/projects` | 项目资产整理、实验过程 | FileBrowser、实验流程 | 放不适合进 Git 的素材、样本、构建产物 |
| `media/books` | `POOL/data/media/books` | 手工归档 | Komga、FileBrowser | 书籍/漫画媒体 |
| `media/movies` `media/music` `media/pictures` `media/tv` | `POOL/data/media/...` | 手工整理、下载后搬运 | FileBrowser、后续媒体服务 | 标准媒体库 |
| `media/recordings` | `POOL/data/media/recordings` | 录播/SMB 同步 | Jellyfin、FileBrowser | 直播录像长期落点 |
| `private` | `POOL/data/private` | 人工归档 | 受控访问流程 | 敏感资料单独隔离 |
| `archive` | `POOL/data/archive` | 清理归档流程 | 低频人工访问 | 冷数据与历史数据 |

### 当前已确认的应用事实

- bili 录播器当前把录像写入 `${BREC_REC_PATH:-/mnt/smb/Live}`，说明**现状挂载点**是 SMB 路径，而不是上表里的最终命名；长期目标建议映射到 `data/media/recordings`。
- Obsidian LiveSync 使用 keeper 上的 CouchDB，数据存放在 Docker volume，而不是 NAS 共享目录。
- 2026-04-03 通过 `app.query` 实测可确认 TrueNAS 已安装并运行 qBittorrent、FileBrowser、Komga、PhotoPrism、Syncthing；其当前宿主挂载分别仍指向旧路径：qBittorrent → `/mnt/NAS/main/downloads`、FileBrowser → `/mnt/NAS/main`、Komga → `/mnt/NAS/main/Books`、PhotoPrism → `/mnt/NAS/main/pictures`、Syncthing → `/mnt/NAS/main`。
- 当前**未**在 `app.query` 中看到 Jellyfin，因此 Jellyfin 仍应表述为推荐目标，而不是“当前已安装现状”。
- 这些运行态事实不等于“当前全部由 SilkSpool bundle 编排并管理”；仓库里可直接确认的 bundle 事实，仍以 bili 录播器和 keeper 的 CouchDB 为准。

---

## 应用职责与状态边界

| 应用 | 角色 | 关联目录 | 当前状态口径 |
|------|------|---------|-------------|
| qBittorrent | 下载入口 | `data/inbox` | 可确认有站点入口；文档中作为下载生产者，不写成当前由 SilkSpool bundle 管理 |
| FileBrowser | 统一文件浏览入口 | `data/inbox`、`data/knowledge`、`data/sync`、`data/projects`、`data/media` | 可确认有站点入口；适合作为统一文件 UI |
| Komga | 书籍/漫画阅读服务 | `data/knowledge` 或 `data/media/books` | 可确认有站点入口；适合书库，不适合通用录像播放 |
| PhotoPrism | 图片/照片管理 | `data/media/pictures` | 可确认有站点入口；不适合通用录像播放 |
| Obsidian + LiveSync + CouchDB | 笔记主同步链路 | 不以 NAS 文件共享为主 | 当前权威链路仍是 LiveSync → CouchDB |
| bili recorder | 直播录像生产者 | 现状 `/mnt/smb/Live`，目标 `data/media/recordings` | 仓库里已确认实际写入 SMB 挂载 |
| Jellyfin | 直播录像与综合媒体播放 | `data/media/recordings` 及其他媒体目录 | 这是**推荐目标**，不是当前已确认由本仓库 bundle 管理的现状 |

---

## FileBrowser 联动边界

FileBrowser 应承担“统一文件视图”，但**不应承担笔记主同步**。

它推荐可见的内容包括：

- qBittorrent 下载后的待整理文件
- 手工上传的文件
- 项目资产和共享工作集
- 媒体库与直播录像
- 与 Obsidian 相关的普通文件资产，例如：
  - 附件导出物
  - 归档包
  - 备份文件
  - 非 LiveSync 数据库本体的文件型资产

它不应该被写成：

- Obsidian 主 Vault 的同步权威
- CouchDB 的替代品
- LiveSync 的替代方案

笔记主同步边界仍以 [../notes/README.md](../notes/README.md) 为准：单 Vault + LiveSync + CouchDB。

---

## 直播录像的播放建议

针对 SMB 同步上来的直播录像，推荐播放器/媒体服务为：

- **Jellyfin**：首选，适合视频库、目录浏览、刮削与多端播放

不推荐作为该场景的主播放器：

- **Komga**：偏书籍/漫画，不适合录像库
- **PhotoPrism**：偏照片，不适合录像库
- **FileBrowser**：只能做文件浏览，不是媒体中心
- **qBittorrent**：下载器，不是播放器

因此，`data/media/recordings` 的长期角色应是：

- FileBrowser 负责看见文件
- Jellyfin 负责播放文件

---

## 应用 ACL 建议（TrueNAS SCALE 25.10.2.1）

### 基线原则

新建 `NAS/data/*` dataset 当前统一采用：

- `share_type=SMB`
- `acltype=NFSV4`
- `aclmode=RESTRICTED`
- `casesensitivity=INSENSITIVE`

实测新 dataset 继承出来的初始 ACL 接近当前 `/mnt/NAS/main/smb` 风格：

- `owner@ = FULL_CONTROL`
- `group@ = MODIFY`
- `builtin_users (gid 545) = MODIFY`
- `builtin_administrators (gid 544) = FULL_CONTROL`

这套基线适合先把 dataset 建出来；随后再按应用补充最小必需 ACL。**不要**把所有应用都直接给 `FULL_CONTROL`。

### 建议保留的通用主体

- `builtin_administrators`：`FULL_CONTROL`，继承到子目录
- `builtin_users`：`MODIFY` 或按需要降为 `READ`，继承到子目录
- `apps`（gid 568）：给需要写入的应用目录 `MODIFY`
- `singll`：如果你希望自己通过 SMB/本地都稳定管理这些目录，建议显式补一个 `MODIFY` 或 `FULL_CONTROL`

### 各应用建议 ACL

| 应用 | 推荐目录 | 建议 ACL | 说明 |
|------|---------|---------|------|
| FileBrowser | `data/inbox`、`data/knowledge`、`data/sync`、`data/projects`、`data/media` | `apps: MODIFY` | 当前 app 以 `uid/gid 568` 运行；要浏览、上传、移动文件，通常需要写权限 |
| Komga | `data/media/books`（或部分 `data/knowledge`） | `apps: READ` 起步；需要封面缓存/写元数据时再升 `MODIFY` | 当前 app 以 `uid/gid 568` 运行，书库目录优先只读 |
| PhotoPrism | `data/media/pictures` | `apps: MODIFY` | 当前容器以 root 运行且具备变更文件能力；若希望它导入后整理原图，需要写权限 |
| Syncthing | `data/sync`（必要时单独子目录） | `apps: MODIFY` | 当前容器以 root 运行，但说明里带 supplementary group `apps`；同步目录应与媒体/私有区隔离 |
| qBittorrent | `data/inbox` | `apps: MODIFY` | 当前 app 以 `uid/gid 568` 运行，下载目录必须可写 |
| Jellyfin | `data/media/recordings`、其他媒体目录 | `apps: READ` 起步 | 作为播放器/媒体库优先只读；只有确实要写元数据/转码缓存到库内时才升权限 |

### 推荐做法

1. 先保持 dataset 级 ACL 简洁，只保留管理员、用户基线。
2. 对需要给应用写入的路径，优先在**对应 dataset 或叶子目录**上单独补 `apps: MODIFY`。
3. 对只读消费型媒体目录，优先给 `apps: READ`，不要默认写入。
4. `private` 不建议直接给 `apps` 组通配访问；如后续某应用必须访问，再做单点授权。

### 目录级建议

- `data/inbox`：`apps: MODIFY`（qBittorrent / FileBrowser）
- `data/knowledge`：默认不放宽；仅在 `notes-assets/` 或特定导出目录给 `apps: MODIFY`
- `data/sync`：`apps: MODIFY`（Syncthing / FileBrowser）
- `data/projects`：按需给 `apps: MODIFY`；默认可先不给
- `data/media/books`：`apps: READ`（Komga），如 FileBrowser 需要上传可额外给 `apps: MODIFY`
- `data/media/pictures`：`apps: MODIFY`（PhotoPrism / FileBrowser）
- `data/media/movies`、`data/media/music`、`data/media/tv`：`apps: READ` 起步
- `data/media/recordings`：FileBrowser 若要整理文件可给 `apps: MODIFY`；Jellyfin 仅播放则 `READ`
- `data/private`：只给人工账户与管理员，不给通用 `apps`
- `data/archive`：通常人工访问即可，默认不放宽给应用

---

## 2026-04-03 已执行的创建结果

已通过 `./spool.sh nas dataset create` 创建：

- `NAS/data`
- `NAS/data/inbox`
- `NAS/data/knowledge`
- `NAS/data/sync`
- `NAS/data/projects`
- `NAS/data/media`
- `NAS/data/media/books`
- `NAS/data/media/movies`
- `NAS/data/media/music`
- `NAS/data/media/pictures`
- `NAS/data/media/tv`
- `NAS/data/media/recordings`
- `NAS/data/private`
- `NAS/data/archive`

已通过 `./spool.sh nas dir create` 创建叶子目录：

- `knowledge/notes-assets`
- `sync/tools`
- `sync/envs`
- `sync/works`
- `projects/projects`
- `projects/datasets`
- `projects/sec-tools`
- `projects/works`
- `media/recordings/live`
- `media/recordings/stripchat`

### 关于 `nas dir create` 的兼容说明

TrueNAS SCALE 25.10.2.1 的 `filesystem.mkdir` 参数格式已经不是旧的 `[path, options]` 位置参数，而是字典型参数；并且在 NFSv4 ACL dataset 上，创建后再 `chmod` 可能返回 `Operation not permitted`。

因此当前 `lib/tools/nas.sh` 已适配：

- 自动把旧写法转换为 `{"path": ..., "options": ...}`
- 默认补 `raise_chmod_error=false`

这样可以在 NFSv4 ACL dataset 上稳定创建普通目录，避免“目录其实已创建，但命令报错”的假失败。

---

## 创建后建议的手工配置顺序

1. 在 TrueNAS UI 中检查 `NAS/data/*` 各 dataset ACL 是否仍为 NFSv4 基线。
2. 先对 `data/inbox`、`data/sync`、`data/media/pictures`、`data/media/recordings` 按上表补应用 ACL。
3. 再逐个修改 app host path：
   - qBittorrent：`/mnt/NAS/main/downloads` → `/mnt/NAS/data/inbox`
   - FileBrowser：`/mnt/NAS/main` → 建议拆成多个 `/mnt/NAS/data/...` 挂载，或至少改到 `/mnt/NAS/data`
   - Komga：`/mnt/NAS/main/Books` → `/mnt/NAS/data/media/books`
   - PhotoPrism：`/mnt/NAS/main/pictures` → `/mnt/NAS/data/media/pictures`
   - Syncthing：`/mnt/NAS/main` → `/mnt/NAS/data/sync`（不建议继续整棵 main 映射）
   - Jellyfin：后续若安装，优先挂 `/mnt/NAS/data/media/recordings` 和其他媒体目录
4. 应用切换挂载前先停对应 app，确认目标目录 ACL 已生效，再重新启动。
5. 旧目录迁移时按“先复制、核对、再切换挂载、最后清旧目录”的顺序执行，不要直接原地改名。

---

## 创建策略：哪些手工，哪些可自动化

- pool 的创建、导入、删除
- 顶层共享策略、权限模型、ACL
- 对现有历史数据的大迁移与改名

原因：这些动作风险高，且通常牵涉全局存储结构与权限边界。

### 可以由现有工具自动创建

当前 `nas` 工具已经支持：

- 创建 dataset：`./spool.sh nas dataset create --resource <name> --args '[...]' --yes`
- 创建目录：`./spool.sh nas dir create --resource <path> --args '[...]' --yes`

推荐顺序：

1. 先人工确认 pool 与顶层权限策略
2. 再用 `nas dataset create` 建 `data/*` 层级
3. 最后用 `nas dir create` 建具体叶子目录

简化理解：

- **pool：手工主导**
- **dataset：可以半自动/自动创建**
- **普通目录：可以自动创建**

---

## `nas` 工具当前能力边界

当前一等支持的命令组是：

- `info`
- `pool`
- `dataset`
- `dir`
- `snapshot`
- `rpc call`

这意味着：

- 现在已经可以稳定查看系统信息、存储池、dataset、目录、快照
- 现在**还没有**一等的 `nas app ...`、`nas share ...`、`nas service ...` 子命令

但通过原始 RPC，已经可以直接读取更多 TrueNAS 资源，例如：

```bash
./spool.sh nas rpc call app.query --args '[]'
./spool.sh nas rpc call service.query --args '[]'
./spool.sh nas rpc call sharing.smb.query --args '[]'
./spool.sh nas rpc call sharing.nfs.query --args '[]'
```

结论：

- **能读已安装 APP / share / service 吗？能，但当前走 `nas rpc call`，不是一等封装命令。**
- 如果后续高频使用，再考虑补 `nas app/share/service` 专用子命令。

---

## 同步边界

### 1. 笔记

- 单一真实 Vault
- LiveSync 负责同步到 CouchDB
- CouchDB 是 Obsidian LiveSync 的私有同步后端，不是公共写入口
- 外部工具如需把 raw / working 带入知识系统，应先写 TrueNAS 文件资产区或 Windows 本地导入缓冲区，再由统一 PowerShell 脚本更新 Vault
- 高价值笔记可按需进入检索增强链路
- 不再把笔记同步问题和通用文件同步绑在一起

详见 [../notes/README.md](../notes/README.md)。

### 2. Windows 便携工具

工具目录保留“一个目录走天下”的使用习惯，但同步方式改为：

- **TrueNAS 作为中转存储**
- **Rclone bisync** 作为主同步方式
- 避免继续使用 Syncthing 做大量二进制与运行时数据库的实时双向同步

原因：实时监听 + 二进制 + 缓存 / SQLite 文件，会带来高冲突、高流量和低可控性。

### 3. 项目文件

- 代码与配置优先 Git
- 大型构建产物、样本、视频、实验数据优先 TrueNAS
- 需要跨设备时按目录特性决定是否补充 Rclone 或手动同步

### 4. 私有与敏感资料

- 单独数据集
- 单独权限边界
- 不混入公开媒体、工具同步区、知识共享区

---

## 迁移原则

1. **允许重命名、拆分、合并**，不要被旧目录绑死。
2. **应用状态与用户数据分离**：`appdata` / `appstorage` / `ix-applications` 继续归基础设施层，用户资料另做长期布局。
3. **按数据类型选同步工具**：笔记、工具、项目、大文件、私有资料不再共用一套策略。
4. **先定层级，再挂应用**：先明确数据集边界，再调整 SMB、Rclone、应用挂载与自动化脚本。
5. **先承认现状，再推进目标结构**：文档中“当前已存在”必须有仓库依据，“推荐目标”必须明确写成推荐。

---

## 与其他模块的边界

- [../notes/README.md](../notes/README.md) — Obsidian Vault、LiveSync、笔记规范
- [../knowledge/README.md](../knowledge/README.md) — AI 工作层、笔记消费与检索支撑
- [../../architecture/infrastructure.md](../../architecture/infrastructure.md) — 主机、网络、IaC、运维红线
- [../../old/superseded/WINDOWS-SYNC.md](../../old/superseded/WINDOWS-SYNC.md) — 历史版 Windows 同步设计与脚本示例
