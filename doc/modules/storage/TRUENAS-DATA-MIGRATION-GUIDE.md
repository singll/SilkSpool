# TrueNAS `NAS/data` 迁移操作手册

适用场景：

- TrueNAS SCALE 25.10.x
- 已经创建好 `NAS/data` 及其子 dataset
- 需要把现有应用从旧目录迁到新的 `NAS/data/*`

这份文档重点回答三件事：

1. 迁移前要检查哪些项
2. 在 TrueNAS UI 里要点什么
3. 应用目录如何安全迁移

---

## 1. 当前目录迁移目标

### 已确认的旧路径 → 新路径

| 应用 | 当前宿主目录 | 建议新目录 |
|------|-------------|-----------|
| qBittorrent | `/mnt/NAS/main/downloads` | `/mnt/NAS/data/inbox` |
| FileBrowser | `/mnt/NAS/main` | 推荐拆分为多个 `data/*` 挂载；最低限度可改为 `/mnt/NAS/data` |
| Komga | `/mnt/NAS/main/Books` | `/mnt/NAS/data/media/books` |
| PhotoPrism | `/mnt/NAS/main/pictures` | `/mnt/NAS/data/media/pictures` |
| Syncthing | `/mnt/NAS/main` | `/mnt/NAS/data/sync` |
| Jellyfin（如后续安装） | 暂无 | `/mnt/NAS/data/media/recordings` 及其他媒体目录 |

### 已创建的数据结构

```text
NAS/data
├── inbox
├── knowledge
│   └── notes-assets
├── sync
│   ├── tools
│   ├── envs
│   └── works
├── projects
│   ├── projects
│   ├── datasets
│   ├── sec-tools
│   └── works
├── media
│   ├── books
│   ├── movies
│   ├── music
│   ├── pictures
│   ├── tv
│   └── recordings
│       ├── live
│       └── stripchat
├── private
└── archive
```

---

## 2. 迁移总原则

严格按这个顺序做：

1. **先检查 dataset 和 ACL**
2. **先复制数据，不要先删旧目录**
3. **停应用后再改挂载**
4. **单个应用迁完并验证通过，再迁下一个**
5. **确认新目录稳定运行后，再考虑清理旧目录**

不要这样做：

- 不要直接把旧目录改名顶替
- 不要多个应用同时改挂载后再一起排错
- 不要还没验证就删除 `/mnt/NAS/main/*` 旧数据
- 不要把 `private` 一股脑挂给 FileBrowser / Syncthing / Jellyfin

---

## 3. 迁移前检查清单

## 3.1 检查 dataset 是否都存在

在 TrueNAS UI 中：

1. 进入 `Storage` → `Datasets`
2. 展开 `NAS`
3. 确认能看到：
   - `data`
   - `data/inbox`
   - `data/knowledge`
   - `data/sync`
   - `data/projects`
   - `data/media`
   - `data/media/books`
   - `data/media/pictures`
   - `data/media/recordings`
   - `data/private`
   - `data/archive`

如果这里缺项，先不要做应用迁移。

---

## 3.2 检查 dataset 属性是否一致

对每个核心 dataset（至少检查 `inbox` / `sync` / `media/books` / `media/pictures` / `media/recordings`）：

1. 在 `Storage` → `Datasets` 中选中目标 dataset
2. 打开详情或编辑页面
3. 重点检查这些值：
   - `ACL Type` = `NFSv4`
   - `ACL Mode` = `Restricted`
   - `Case Sensitivity` = `Insensitive`
   - `Share Type` = `SMB`

如果看到是 POSIX 或者权限风格明显不一致，先修正再继续。

---

## 3.3 检查 ACL 是否符合应用用途

先记住一个原则：**不是所有 dataset 都要加 `apps`**。

只给“确定会挂给应用”的 dataset 加 `apps`，其余保持基线 ACL 即可。这样最稳，也最不容易把 `private`、`archive` 之类目录误暴露出去。

### 基线 ACL 长什么样

你现在在 TrueNAS UI 右下角 `Permissions` 里，至少应能看到这 4 条：

- `owner@ - root` → `Allow | Full Control`
- `group@ - root` → `Allow | Modify`
- `Group - builtin_users` → `Allow | Modify`
- `Group - builtin_administrators` → `Allow | Full Control`

如果某个 dataset 连这 4 条基线都不一致，先不要加 `apps`，先把基线确认对。

### 哪些 dataset 现在要加 `apps`

| Dataset | 现在是否建议加 `apps` | 建议权限 | 原因 |
|------|------------------|---------|------|
| `NAS/data` | 否 | 不加 | 不建议把整棵 `data` 一次性开放给所有应用 |
| `NAS/data/inbox` | 是 | `MODIFY` | qBittorrent / FileBrowser 需要写入 |
| `NAS/data/knowledge` | 视情况 | `MODIFY` 或不加 | 如果你准备让 FileBrowser 挂这个 dataset，就加；如果知识库主要人工维护，可先不加 |
| `NAS/data/sync` | 是 | `MODIFY` | Syncthing / FileBrowser 需要写入 |
| `NAS/data/projects` | 视情况 | `MODIFY` 或不加 | 如果 FileBrowser 会管理项目文件就加；否则先不加 |
| `NAS/data/media` | 否 | 不加 | 一般在子 dataset 单独授权，不在 media 根上放权 |
| `NAS/data/media/books` | 是 | `READ` 起步 | Komga 主要读书库；若 FileBrowser 也要上传整理，再升 `MODIFY` |
| `NAS/data/media/movies` | 暂不加或后续加 | `READ` | 等 Jellyfin 真挂这个库时再加 |
| `NAS/data/media/music` | 暂不加或后续加 | `READ` | 等 Jellyfin 真挂这个库时再加 |
| `NAS/data/media/pictures` | 是 | `MODIFY` | PhotoPrism 需要读写整理图片 |
| `NAS/data/media/tv` | 暂不加或后续加 | `READ` | 等 Jellyfin 真挂这个库时再加 |
| `NAS/data/media/recordings` | 是，推荐现在就加 | `MODIFY` | 你大概率会用 FileBrowser 整理录像；若将来仅 Jellyfin 播放，可降成 `READ` |
| `NAS/data/private` | 否 | 不加 | 私有区不要给通用 `apps` |
| `NAS/data/archive` | 否 | 不加 | 归档区默认人工访问即可 |

### 建议你现在实际去加的 `apps` 权限

如果按当前迁移目标直接落地，推荐先给这几个 dataset 加：

- `NAS/data/inbox` → `apps: MODIFY`
- `NAS/data/sync` → `apps: MODIFY`
- `NAS/data/media/books` → `apps: READ`
- `NAS/data/media/pictures` → `apps: MODIFY`
- `NAS/data/media/recordings` → `apps: MODIFY`

下面两个按你的使用方式二选一：

- `NAS/data/knowledge` → 如果 FileBrowser 要挂这里，就加 `apps: MODIFY`；否则先不加
- `NAS/data/projects` → 如果 FileBrowser 要挂这里，就加 `apps: MODIFY`；否则先不加

### 在 UI 里加 `apps` 权限的统一动作

每个 dataset 都按下面动作做：

1. `Storage` → `Datasets`
2. 左侧点选目标 dataset
3. 右下角看 `Permissions`
4. 先确认基线 4 条 ACL 还在
5. 点击右上角 `Edit`
6. 进入 ACL 编辑页后：
   - 点击 `Add ACL Item`
   - `Who` / `ACL Entry Type` 选 `Group`
   - 名称填 `apps`
   - `Access` 选 `Allow`
   - `Permissions` 选 `MODIFY` 或 `READ`
   - 继承选项保持对子目录、文件生效
7. 保存
8. 保存后回到详情页，再确认 `Permissions` 列表里已经出现：
   - `Group - apps` → `Allow | Modify`
   - 或 `Group - apps` → `Allow | Read`

注意：

- 如果这个 dataset 里还没有历史数据，通常可以直接应用
- 如果这个 dataset 下已经有历史数据，看到 `Apply permissions recursively` 一类选项时先确认再点，避免误覆盖旧 ACL
- **不要改动** `owner@`、`group@`、`builtin_users`、`builtin_administrators` 这几条基线，只新增 `apps`

### 按 dataset 逐个处理清单

#### 1. `NAS/data`

- 动作：**不加 `apps`**
- 你只需要确认基线 ACL 正常
- 原因：不建议把整棵 `data` 作为通用应用入口

#### 2. `NAS/data/inbox`

- 动作：**加 `Group - apps` → `Allow | Modify`**
- 操作：
  1. 点 `inbox`
  2. 看 `Permissions`
  3. 点 `Edit`
  4. `Add ACL Item`
  5. 新增 `Group = apps`
  6. 权限选 `MODIFY`
  7. 保存
- 用途：qBittorrent、FileBrowser

#### 3. `NAS/data/knowledge`

- 动作：**默认可先不加**；如果 FileBrowser 要挂这里，就加 `apps: MODIFY`
- 操作（需要加时）：
  1. 点 `knowledge`
  2. 点 `Edit`
  3. `Add ACL Item`
  4. `Group = apps`
  5. 权限选 `MODIFY`
  6. 保存
- 说明：如果你只想让 FileBrowser 看 `notes-assets` 之类子目录，而不想放开整个知识库，那就先不要在 dataset 根上加

#### 4. `NAS/data/sync`

- 动作：**加 `Group - apps` → `Allow | Modify`**
- 操作：
  1. 点 `sync`
  2. 点 `Edit`
  3. `Add ACL Item`
  4. `Group = apps`
  5. 权限选 `MODIFY`
  6. 保存
- 用途：Syncthing、FileBrowser

#### 5. `NAS/data/projects`

- 动作：**默认可先不加**；如果 FileBrowser 要管理项目文件，就加 `apps: MODIFY`
- 操作（需要加时）：
  1. 点 `projects`
  2. 点 `Edit`
  3. `Add ACL Item`
  4. `Group = apps`
  5. 权限选 `MODIFY`
  6. 保存
- 说明：这里先按最小权限做，不急着放开

#### 6. `NAS/data/media`

- 动作：**不加 `apps`**
- 原因：媒体权限建议加在 `books / pictures / recordings / movies / music / tv` 这些子 dataset 上，而不是加在 media 根上

#### 7. `NAS/data/media/books`

- 动作：**加 `Group - apps` → `Allow | Read`**
- 操作：
  1. 展开 `media`
  2. 点 `books`
  3. 点 `Edit`
  4. `Add ACL Item`
  5. `Group = apps`
  6. 权限先选 `READ`
  7. 保存
- 用途：Komga
- 备注：如果后面 FileBrowser 也要在这里上传或重命名书籍，再改成 `MODIFY`

#### 8. `NAS/data/media/movies`

- 动作：**现在可先不加**
- 将来如果 Jellyfin 要挂这个库，再加 `apps: READ`

#### 9. `NAS/data/media/music`

- 动作：**现在可先不加**
- 将来如果 Jellyfin 要挂这个库，再加 `apps: READ`

#### 10. `NAS/data/media/pictures`

- 动作：**加 `Group - apps` → `Allow | Modify`**
- 操作：
  1. 点 `pictures`
  2. 点 `Edit`
  3. `Add ACL Item`
  4. `Group = apps`
  5. 权限选 `MODIFY`
  6. 保存
- 用途：PhotoPrism、FileBrowser

#### 11. `NAS/data/media/tv`

- 动作：**现在可先不加**
- 将来如果 Jellyfin 要挂这个库，再加 `apps: READ`

#### 12. `NAS/data/media/recordings`

- 动作：**推荐现在加 `Group - apps` → `Allow | Modify`**
- 操作：
  1. 点 `recordings`
  2. 点 `Edit`
  3. `Add ACL Item`
  4. `Group = apps`
  5. 权限选 `MODIFY`
  6. 保存
- 说明：如果后面你确定这里只有 Jellyfin 播放、不会通过 FileBrowser 整理文件，也可以改成 `READ`

#### 13. `NAS/data/private`

- 动作：**不要加 `apps`**
- 只检查基线 ACL 和你自己的人工账户权限

#### 14. `NAS/data/archive`

- 动作：**不要加 `apps`**
- 归档区默认不开放给通用应用

---

## 4. 应用迁移的统一步骤

每个应用都按下面流程走，不要跳步：

### 步骤 1：记录当前挂载

1. 进入 `Apps` → `Installed Applications`
2. 找到目标应用
3. 点击右侧 `⋮` → `Edit`
4. 打开 `Storage` / `Volumes` / `Host Path` 相关页面
5. 记下当前宿主目录

### 步骤 2：停止应用

1. 回到应用列表
2. 点击应用右侧 `⋮`
3. 选择 `Stop`
4. 确认应用状态变成已停止

### 步骤 3：复制旧数据到新目录

推荐策略：

- 小目录：可用 SMB / FileBrowser 手工复制
- 大目录：建议在 TrueNAS Shell 使用 `rsync`

推荐命令模板：

```bash
rsync -aHAX --info=progress2 <旧目录>/ <新目录>/
```

示例：

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/downloads/ /mnt/NAS/data/inbox/
rsync -aHAX --info=progress2 /mnt/NAS/main/Books/ /mnt/NAS/data/media/books/
rsync -aHAX --info=progress2 /mnt/NAS/main/pictures/ /mnt/NAS/data/media/pictures/
```

注意末尾 `/`：

- `旧目录/` → 表示复制目录内容
- `新目录/` → 表示复制进目标目录

### 步骤 4：核对复制结果

至少检查：

- 文件数量大致一致
- 目录结构一致
- 随机抽查几个文件能正常打开
- 图片/书籍/视频样本能被读取

### 步骤 5：修改应用挂载

1. `Apps` → `Installed Applications`
2. 找到应用
3. `⋮` → `Edit`
4. 进入 `Storage` / `Host Path` 配置
5. 把旧路径替换成新路径
6. 保存
7. 等待应用重新部署

### 步骤 6：启动并验证

验证至少包括：

- 应用能正常启动
- Web UI 能打开
- 新目录中的文件能被识别
- 新写入的数据确实落在 `NAS/data/*`
- 没有继续写回旧路径

### 步骤 7：保留旧目录观察一段时间

不要立刻删旧目录。

建议做法：

- 先保留旧目录
- 连续使用一段时间
- 确认没有应用再访问旧路径
- 再手工清理旧目录

### 如果你已经先改挂载，再迁旧数据

如果你已经把应用 Host Path 改到了 `NAS/data/*`，现在才准备把旧 `main/*` 数据补迁过去，不要直接在线复制。

按下面顺序做：

1. **先再次停止对应应用**
   - 避免复制过程中旧目录和新目录同时发生变化
2. **先确认应用当前挂载已经是新路径**
   - 例如 qBittorrent 已经指向 `/mnt/NAS/data/inbox`
   - Komga 已经指向 `/mnt/NAS/data/media/books`
3. **判断新目录在切换挂载后是否已经产生新数据**

#### 情况 A：新目录还没有新写入

可以直接把旧目录内容同步到新目录：

```bash
rsync -aHAX --info=progress2 <旧目录>/ <新目录>/
```

#### 情况 B：新目录已经有新文件，或者你不确定

先用更稳妥的“只补旧文件、不覆盖新文件”方式做第一轮同步：

```bash
rsync -aHAX --ignore-existing --info=progress2 <旧目录>/ <新目录>/
```

说明：

- `--ignore-existing` 会跳过新目录里已经存在的同名文件
- 这样更适合“应用已经切到新目录并运行过一段时间”的场景
- **不要先用 `--delete`**，避免把新目录内容误删

4. **同步后立刻做核对**
   - 文件数量是否大致一致
   - 随机抽查样本文件能否打开
   - 新目录里最近新写入的文件是否还在
   - 应用需要的历史内容是否已经补齐
5. **再启动应用并做业务验证**
   - Web UI 正常
   - 历史内容可见
   - 新写入继续落在 `NAS/data/*`
6. **继续保留旧目录观察**
   - 至少观察一段时间再清理

### 已切挂载后的常见补迁移命令

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/downloads/ /mnt/NAS/data/inbox/
rsync -aHAX --info=progress2 /mnt/NAS/main/Books/ /mnt/NAS/data/media/books/
rsync -aHAX --info=progress2 /mnt/NAS/main/pictures/ /mnt/NAS/data/media/pictures/
```

如果你已经切换挂载后又运行过应用，先改成：

```bash
rsync -aHAX --ignore-existing --info=progress2 /mnt/NAS/main/downloads/ /mnt/NAS/data/inbox/
rsync -aHAX --ignore-existing --info=progress2 /mnt/NAS/main/Books/ /mnt/NAS/data/media/books/
rsync -aHAX --ignore-existing --info=progress2 /mnt/NAS/main/pictures/ /mnt/NAS/data/media/pictures/
```

---

## 5. 各应用的具体迁移方案

## 5.1 qBittorrent

### 目标

- 下载目录从 `/mnt/NAS/main/downloads`
- 迁到 `/mnt/NAS/data/inbox`

### ACL 建议

- `data/inbox` 给 `apps: MODIFY`

### 操作步骤

1. 停止 qBittorrent
2. 复制数据：

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/downloads/ /mnt/NAS/data/inbox/
```

3. `Apps` → `Installed Applications` → `qbittorrent` → `⋮` → `Edit`
4. 把 Host Path 从 `/mnt/NAS/main/downloads` 改成 `/mnt/NAS/data/inbox`
5. 保存并等待应用重建
6. 打开 qBittorrent Web UI 检查：
   - 旧任务是否还在
   - 新下载是否写入 `data/inbox`

---

## 5.2 FileBrowser

### 目标

推荐两种方案：

#### 方案 A：直接挂整个 `data`

- 旧路径：`/mnt/NAS/main`
- 新路径：`/mnt/NAS/data`

优点：

- 改动最少
- 一次切换完成

缺点：

- 可能把 `private`、`archive` 也暴露给 FileBrowser

#### 方案 B：拆分多个 Host Path

推荐把这些目录分别挂进去：

- `/mnt/NAS/data/inbox`
- `/mnt/NAS/data/knowledge`
- `/mnt/NAS/data/sync`
- `/mnt/NAS/data/projects`
- `/mnt/NAS/data/media`

优点：

- 权限边界更清楚
- 不会顺手暴露 `private`

### ACL 建议

- FileBrowser 要上传、移动、删除文件时，相关目录给 `apps: MODIFY`

### 操作步骤

1. 停止 FileBrowser
2. 如果准备保留旧目录只读浏览，可先不删旧挂载
3. 编辑应用存储配置
4. 优先采用“拆分多个 Host Path”方案
5. 保存并重启
6. 验证：
   - 目录能正常浏览
   - 上传文件落在新 `data/*`
   - 不会误看到 `private`

---

## 5.3 Komga

### 目标

- 旧路径：`/mnt/NAS/main/Books`
- 新路径：`/mnt/NAS/data/media/books`

### ACL 建议

- 先给 `apps: READ`
- 如果后续确认 Komga 需要写封面或元数据，再升到 `MODIFY`

### 操作步骤

1. 停止 Komga
2. 复制书库：

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/Books/ /mnt/NAS/data/media/books/
```

3. 编辑 Komga Host Path
4. 把 `/mnt/NAS/main/Books` 改成 `/mnt/NAS/data/media/books`
5. 启动 Komga
6. 验证：
   - 书库能重新扫描出来
   - 漫画/书籍能正常打开
   - 没有权限报错

---

## 5.4 PhotoPrism

### 目标

- 旧路径：`/mnt/NAS/main/pictures`
- 新路径：`/mnt/NAS/data/media/pictures`

### ACL 建议

- `data/media/pictures` 给 `apps: MODIFY`

### 操作步骤

1. 停止 PhotoPrism
2. 复制图片库：

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/pictures/ /mnt/NAS/data/media/pictures/
```

3. 编辑 PhotoPrism 的 originals 挂载
4. 把 `/mnt/NAS/main/pictures` 改成 `/mnt/NAS/data/media/pictures`
5. 保存并启动
6. 验证：
   - 图片是否可见
   - 索引是否正常
   - 导入/整理动作是否写入新目录

---

## 5.5 Syncthing

### 目标

- 旧路径：`/mnt/NAS/main`
- 新路径：`/mnt/NAS/data/sync`

### 为什么要缩小挂载范围

不建议继续把整棵 `main` 挂给 Syncthing，因为：

- 范围过大
- 更容易把不该同步的内容也带进去
- 会模糊 `sync` 和 `media/private/archive` 的边界

### ACL 建议

- `data/sync` 给 `apps: MODIFY`

### 操作步骤

1. 停止 Syncthing
2. 把真正需要同步的目录分别迁到：
   - `data/sync/tools`
   - `data/sync/envs`
   - `data/sync/works`
3. 复制示例：

```bash
rsync -aHAX --info=progress2 /mnt/NAS/main/<旧同步目录>/ /mnt/NAS/data/sync/works/
```

4. 编辑 Syncthing 挂载，把 `/mnt/NAS/main` 改为 `/mnt/NAS/data/sync`
5. 启动 Syncthing
6. 在 Syncthing Web UI 里重新核对各 Folder Path
7. 验证同步是否正常

---

## 5.6 Jellyfin（后续如安装）

### 目标

优先挂：

- `/mnt/NAS/data/media/recordings`
- `/mnt/NAS/data/media/movies`
- `/mnt/NAS/data/media/tv`
- `/mnt/NAS/data/media/music`

### ACL 建议

- 默认 `apps: READ`
- 仅在确实需要写媒体库内文件时再升权限

### 建议

- Jellyfin 负责播放
- FileBrowser 负责整理文件
- 不要让 Jellyfin 默认拥有全库写权限

---

## 6. 推荐迁移顺序

建议按风险从低到高迁：

1. Komga
2. PhotoPrism
3. qBittorrent
4. FileBrowser
5. Syncthing
6. Jellyfin（如果后续安装）

原因：

- Komga / PhotoPrism 相对更容易验证
- qBittorrent 关系到持续写入
- FileBrowser / Syncthing 影响面更大

---

## 7. 迁移完成后的验收清单

每迁完一个应用，至少检查这些：

- 应用已恢复运行
- 配置页面没有路径报错
- 文件能被正常读取
- 新文件写入的是 `NAS/data/*`
- 旧路径没有继续增长
- ACL 没有导致“能看见但打不开”或“能打开但不能写”

全部应用迁完后，再检查：

- `data/inbox`
- `data/knowledge`
- `data/sync`
- `data/projects`
- `data/media/*`
- `data/private`
- `data/archive`

确认每个目录的用途和权限边界都清晰。

---

## 8. 最后提醒

最稳妥的迁移方式永远是：

**停应用 → 复制 → 校验 → 改挂载 → 启动 → 验证 → 保留旧目录观察 → 最后清理**

如果某个应用迁移后出现问题，不要先删旧目录，直接把挂载切回旧路径即可快速回退。