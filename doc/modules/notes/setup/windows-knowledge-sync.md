# Windows 知识同步脚本说明

> 目标：提供一个运行在 Windows 上的统一 PowerShell 入口，使用 Rclone 从 TrueNAS 拉取 `raw / working` 文件资产，并把适合进入 PKB 的内容导入单 Vault；同时显式避免在 Windows 上长期保留多份重复实体文件。

---

## 定位

这个脚本是 **Windows 知识导入脚本**，不是：

- Linux 运维编排命令
- TrueNAS 与 Vault 的全量镜像器
- LiveSync / CouchDB 的替代同步器
- 一般意义上的“所有文件都双向同步”工具

它的默认职责只有三段：

1. `TrueNAS -> D:\SilkSpoolImport\raw|working`
2. `D:\SilkSpoolImport\raw|working -> Vault RAW/WORKING`
3. 触发 Vault 刷新，让 Obsidian 看见导入结果

当前 Windows 侧文件编排已经独立为 `SilkFiles` 项目。

当前执行入口：

```text
SilkFiles/files.ps1
```

知识同步统一通过 `knowledge` 子命令进入：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\files.ps1 knowledge <plan|dry-run|pull|import|run|status|clean|publish> [args...]
```

`SilkSpool/doc/modules/notes/setup/` 这里现在只保留规则文档；旧脚本副本不再作为当前入口。

---

## 固定路径

### TrueNAS 文件资产层

```text
POOL/data/knowledge/raw
POOL/data/knowledge/working
POOL/data/knowledge/pkb-assets
```

### Windows 本地导入缓冲区

```text
D:\SilkSpoolImport\raw
D:\SilkSpoolImport\working
D:\SilkSpoolImport\state\knowledge-import-manifest.json
```

### Obsidian 单 Vault

```text
D:\Notes\obsidian-note
├── 00-Inbox/
├── RAW/
├── WORKING/
├── KNOWLEDGE/
└── Daily/
```

---

## 默认策略

### 1. Markdown 优先

默认导入对象优先是“笔记化内容”：

- `.md`
- `.txt` / 纯文本稿
- OCR / 转写后的文本材料
- 少量确实需要直接放进 Obsidian 的轻量图片附件

默认**不**把以下对象当成常规导入目标：

- PDF 原件
- 网页保存包
- 大图片 / 大附件
- 压缩包
- 取证类文件
- 虚拟机镜像
- 样本、大日志、仓库目录

### 2. 成功即清理

导入缓冲区 `D:\SilkSpoolImport\raw|working` 只是事务缓存，不是长期存储层。

默认行为：

- 成功导入到 Vault 后，立刻删除缓冲区中的那一份副本
- 失败项、冲突项、阻止项保留在缓冲区，等待人工处理
- 这样可以避免形成：TrueNAS 一份 + 本地缓冲区一份 + Vault 一份

### 3. 外置资产生成相对路径引用

对不进入 Vault 的资产，脚本默认在 Vault 中生成索引页，而不是复制实体。

索引页记录：

- `surface`（来自 raw / working）
- `asset_ref`（相对资产路径，例如 `raw/report/foo.pdf`）
- 文件名
- 哈希
- 大小
- 策略原因

这样做是为了：

- 不把路径绑定到某一台 Windows 机器的绝对盘符
- 让后续脚本、人工流程或多设备环境都能基于相对路径解析资产

---

## 复制 / 剪切原则

### TrueNAS `raw`

- 是原始资产层
- **复制，不剪切离开 TrueNAS**
- TrueNAS 保留主副本

### TrueNAS `working`

- 是工作中间产物层
- **复制到 Vault，但主副本仍留在 TrueNAS**
- 不因进入 Obsidian 而把长期资产搬离文件层

### Windows 导入缓冲区

- 是中转层
- **成功导入后删除**
- 这不叫“从长期层剪切”，而是移除事务缓存

### Markdown / PKB 笔记

- 主副本永远在 Vault
- 不再回迁 TrueNAS 作为主编辑面

### 最终知识附件

- 长期归宿优先是 `POOL/data/knowledge/pkb-assets`
- Vault 只保留：
  - 必须直接嵌入/查看的轻量副本
  - 或外置资产的索引页

---

## 命令动作

### `plan` / `dry-run`

只输出计划，不改文件。

会显示：

- 远端路径
- 本地路径
- 导入缓冲区中发现了哪些文件
- 每个文件会被判为：
  - `import-note`
  - `import-attachment`
  - `externalize-with-index`
  - `skip-blocked`

### `pull`

用 Rclone 执行：

- TrueNAS `raw -> D:\SilkSpoolImport\raw`
- TrueNAS `working -> D:\SilkSpoolImport\working`

### `import`

扫描导入缓冲区，并按规则执行：

- 文本类 -> 写入 Vault `RAW/` 或 `WORKING/`
- 轻量附件 -> 复制进 Vault
- 外置资产 -> 写索引页，不复制实体
- 冲突项 -> 不覆盖，标记冲突
- 已导入成功项 -> 默认立刻从缓冲区删除

### `run`

统一入口：

- 先 `pull`
- 再 `import`
- 再刷新 Vault 时间戳

### `status`

输出：

- `raw` 缓冲区大小
- `working` 缓冲区大小
- manifest 记录总数
- 每种状态的数量
- 当前待导入候选数

### `clean`

再次清理缓冲区中已成功导入的缓存副本。

适合场景：

- 之前导入时用了 `-SkipClean`
- 你先人工确认，再单独清理

### `publish`

显式把 Vault 中选定的稳定文件复制到 TrueNAS `pkb-assets`。

这是**后置动作**，不纳入默认 `run`。

---

## 判定规则

### 导入到 Vault

默认进入 Vault 的内容：

- `.md`
- `.txt`
- `.text`
- `.org`
- `.rst`
- 小于等于 `AttachmentMaxBytes` 的图片附件（默认 1 MB）

### 外置但生成索引页

默认外置：

- PDF
- 大于轻量附件阈值的文件
- 其他未知但不适合直接导入的文件

### 直接阻止

默认阻止进入 Vault：

- `.zip` `.7z` `.rar`
- `.pcap` `.pcapng`
- `.dmp`
- `.iso` `.vhd` `.vhdx` `.qcow2`
- `.exe` `.msi` `.dll`
- `.mp4` `.mp3` `.wav` `.mov` `.mkv`

这些文件应继续留在 TrueNAS，或由人工决定是否进入 `pkb-assets`。

---

## 去重与冲突

脚本使用 SHA256 哈希作为主判定依据。

### 默认规则

- 目标文件已存在且哈希相同：视为已存在，不重复导入
- 目标文件已存在但哈希不同：标记为冲突，不自动覆盖
- manifest 中已记录且哈希相同：视为已导入
- 默认不删除 TrueNAS 原件
- 默认不覆盖 Vault 现有文件

### manifest 记录字段

`knowledge-import-manifest.json` 至少记录：

- `source_path`
- `surface`
- `relative_source`
- `target_path`
- `relative_target`
- `hash`
- `size`
- `modified_at`
- `imported_at`
- `status`
- `reason`
- `asset_ref`
- `kind`

这使得后续 `status`、`clean`、重跑 `import` 都有依据。

---

## 原料目录到 Vault 的默认映射

### 来自 `raw`

按文件名关键词粗分：

- `CVE- / advisory / bulletin` -> `RAW/Advisories`
- `lab / poc / exploit / repro` -> `RAW/Lab-Notes`
- `code / program / script / powershell / python / go` -> `RAW/Programming-Drafts`
- `ai / llm / summary / distill` -> `RAW/AI-Drafts`
- `article / blog / paper / writeup / report` -> `RAW/Articles`
- 其他 -> `RAW/Imports`

### 来自 `working`

按文件名关键词粗分：

- `summary / digest / brief` -> `WORKING/Summaries`
- `review / weekly / monthly` -> `WORKING/Reviews`
- 其他 -> `WORKING/Distill`

这是第一版的保守规则，后续可以再演进为更细的分类映射表。

---

## 示例

### 只看计划

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\files.ps1 knowledge plan
```

### 执行完整入口

```powershell
.\files.ps1 knowledge run
```

### 拉取但不导入

```powershell
.\files.ps1 knowledge pull
```

### 只导入，并保留缓冲区副本

```powershell
.\files.ps1 knowledge import -SkipClean
```

### 查看状态

```powershell
.\files.ps1 knowledge status
```

### 把某个 Vault 文件发布到 `pkb-assets`

```powershell
.\files.ps1 knowledge publish `
  -PublishPath "D:\Notes\obsidian-note\KNOWLEDGE\Attachments\example.png" `
  -PublishPrefix "lab-assets"
```

---

## Rclone 约定

建议通过参数明确以下值：

- `-RclonePath`
- `-RemoteName`
- `-RemoteKnowledgeRoot`

默认示例：

```powershell
-RclonePath "C:\Tools\rclone\rclone.exe"
-RemoteName "truenas"
-RemoteKnowledgeRoot "/mnt/POOL/data/knowledge"
```

脚本本身不负责 `rclone config` 的交互初始化；应先在 Windows 上单独配置好远端。

---

## 与现有文档的关系

这份脚本说明补充的是“Windows 统一入口”层面的执行规则。

相关上位文档：

- [README.md](../README.md)
- [windows-vault-bootstrap.md](windows-vault-bootstrap.md)
- [../vaults/single-vault.md](../vaults/single-vault.md)
- [../standards/sync-and-ignore-rules.md](../standards/sync-and-ignore-rules.md)
- [../../storage/README.md](../../storage/README.md)

---

## 当前边界

第一版脚本**故意保守**：

- 不直接写 CouchDB
- 不把 Vault 变成双向文件同步根目录
- 不自动覆盖冲突文件
- 不把所有附件都强行塞进 Vault
- `publish` 只做显式文件复制，不做复杂清单编排

如果后续要增强，也应继续遵守同一原则：

> TrueNAS 管文件资产，Vault 管笔记主副本，导入缓冲区只做短期事务中转。
