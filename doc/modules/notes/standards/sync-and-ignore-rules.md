# 同步边界与忽略规则

> 目标：明确哪些目录参与 LiveSync 同步，哪些目录可进入检索增强消费范围，哪些内容不应出现在 Vault 中。

---

## LiveSync 同步边界

LiveSync 同步**整个 Vault**，即 `D:\Notes\obsidian-note` 下所有内容。

不需要也不建议按目录配置选择性同步。目录分层在 Vault 内部完成，不是靠多个数据库分割。

这里要固定三条边界：

1. LiveSync 同步的是 **Vault 文件本体**，不是 TrueNAS 文件资产区。
2. `D:\SilkSpoolImport\raw|working` 这类本地导入缓冲区**不属于 Vault**，也不应纳入 LiveSync。
3. CouchDB 是 LiveSync 的私有同步后端；外部系统不能直接写它。

`TrueNAS raw|working -> Windows 导入缓冲区 -> Vault RAW/WORKING` 的文件流转，应通过独立 `SilkFiles` 项目的 `SilkFiles/files.ps1` 执行，例如在项目根目录运行 `.\files.ps1 knowledge run`，而不是把 Vault 本身当成 NAS 文件同步根目录。

---

## 检索增强消费边界

### 推荐消费（高质量内容）

```text
KNOWLEDGE/Evergreen/
KNOWLEDGE/Labs/
KNOWLEDGE/Playbooks/
KNOWLEDGE/Programming/
```

### 不建议消费

```text
00-Inbox/                  # 未处理，质量不稳定
RAW/                       # 原料，半成品
WORKING/                   # 工作稿，中间态内容
KNOWLEDGE/Templates/       # 模板文件，无实质内容
KNOWLEDGE/Attachments/     # 附件，非文本
KNOWLEDGE/Projects/        # 项目决策记录，通常含敏感内容
Daily/                     # 日记，个人流水，不适合检索
```

---

## Obsidian 忽略建议

以下内容通过 `.obsidian/app.json` 的 `userIgnoreFilters` 或 LiveSync 的排除规则配置：

```text
.obsidian/workspace.json   # 窗口状态，不应同步
.obsidian/cache            # 本地缓存
D:\SilkSpoolImport\raw    # 本地导入缓冲区，不属于 Vault
D:\SilkSpoolImport\working
```

LiveSync 默认已排除 `.obsidian/workspace` 状态文件，其余 `.obsidian/` 配置建议参与同步以保持多设备一致。

---

## 不要放进 Vault 的内容

| 类型 | 推荐位置 |
|------|----------|
| PCAP 文件 | TrueNAS |
| 内存转储 | TrueNAS |
| 恶意样本 | 隔离存储 / 加密目录 |
| 大日志（>10MB） | TrueNAS / 本地归档 |
| 大型压缩包 | TrueNAS |
| 虚拟机镜像 | TrueNAS |
| 大型代码仓库 | Gitea / GitHub |
| 凭据和敏感明文 | 密码管理器 / 加密目录 |

---

## Sensitivity 字段与检索增强的关系

| sensitivity 值 | 是否进入检索增强消费 |
|---|---|
| `public` | 可以 |
| `normal` | 可以 |
| `internal` | 谨慎，建议不回流 |
| `restricted` | 不应回流 |

如果一篇笔记包含敏感内容，建议在 frontmatter 中标记 `sensitivity: restricted`，并在 K07 或其他消费链路的过滤逻辑中排除该值。

---

## 一句话原则

- LiveSync 同步全 Vault
- 检索增强只消费 `KNOWLEDGE/` 下高质量目录
- 敏感内容不进 Vault，极敏感内容标记 `restricted` 并在消费链路过滤
- Windows 导入缓冲区只做短期事务中转；成功导入后默认应被清理，避免形成重复实体文件
