# LiveSync 配置清单

> 目标：把唯一真实 Vault `D:\Notes\obsidian-note` 稳定同步到 CouchDB；如需后续启用检索增强，再通过 K07 等可选链路消费高价值笔记。

---

## 先决条件

1. 电脑已连入 Headscale / VPN，可访问 keeper
2. keeper 上 CouchDB 正常运行
3. 已创建并在 Obsidian 中打开 Vault：`D:\Notes\obsidian-note`
4. 如果后续要启用 K07 / 检索增强，相关服务端链路已准备好

验证 CouchDB 可用：

```bash
curl http://<keeper-headscale-ip>:5984/_up
# 返回 {"status":"ok"} 即正常
```

---

## 原则

- 只同步一个真实 Vault
- 只配置一个 CouchDB 数据库（`obsidian-notes`）
- 全 Vault 参与 LiveSync，目录分层在 Vault 内部完成
- CouchDB 是 LiveSync 的**私有同步后端**，不是外部系统的公共写入口
- 外部工具如需把内容带入知识系统，应写 Vault 文件或本地导入缓冲区，而不是直接写 CouchDB
- 检索增强只是可选后加能力，不反向定义 Vault 结构

---

## 安装插件

1. 设置 → 第三方插件 → 关闭安全模式
2. 搜索安装 **Self-hosted LiveSync**
3. 启用插件

---

## 连接参数

```text
CouchDB URI:    http://<keeper-headscale-ip>:5984
Username:       <COUCHDB_USER>
Password:       <COUCHDB_PASSWORD>
Database name:  obsidian-notes
```

> 注意：这里的 CouchDB 仅供 LiveSync 使用。不要让 RAGFlow、Bellkeeper、导入脚本或其他外部系统直接写这个数据库。

---

## 首台设备初始化

1. 打开 Vault，进入 LiveSync 设置
2. 选择手动配置，填写上述参数
3. 选择「以本地内容为基线推送到远端」
4. 等待首次同步完成

如果不确定远端数据库是否已有旧数据，先检查 `_all_dbs` 再决定方向。

---

## 第二台及后续设备

1. 在第一台设备：LiveSync 设置 → 导出 Setup URI
2. 第二台设备安装并启用 LiveSync
3. 粘贴 Setup URI 一键导入配置
4. 选择从远端拉取

---

## 推荐同步设置

```text
Sync Mode:            LiveSync（实时同步）
Conflict handling:    Merging / newer base
Trash / revision:     开启
Periodic replication: 开启
```

---

## 首次验证

1. 在 `00-Inbox/` 新建 `livesync-test.md`，写入任意内容
2. 观察插件状态是否显示同步成功
3. 在第二台设备或 CouchDB 侧确认数据出现

---

## 检索增强消费建议

```text
Obsidian 单 Vault
  → LiveSync 写入 CouchDB
  → K07-obsidian-sync（可选）轮询 _changes
  → Bellkeeper ingest 接口（可选）
  → 检索 / 问答系统消费高价值笔记
```

这里的边界要特别明确：

- 允许 K07 这类流程**读取** `_changes` 向外消费 Markdown 变更
- 不允许把 K07、Bellkeeper、RAGFlow 或任意导入脚本当成**反向写入 CouchDB** 的入口
- 如果要把 raw / working 收入知识系统，应先写本地导入缓冲区或 Vault 文件，再由 LiveSync 负责同步

推荐消费目录：

```text
KNOWLEDGE/Evergreen/
KNOWLEDGE/Labs/
KNOWLEDGE/Playbooks/
KNOWLEDGE/Programming/
```

不建议消费：`00-Inbox/`、`RAW/`、`Daily/`、`KNOWLEDGE/Templates/`、`KNOWLEDGE/Attachments/`

---

## 常见问题

**连不上 CouchDB**：检查 VPN 状态、CouchDB 进程、URI 格式、用户名密码。

**第一次同步方向搞反**：备份本地 Vault → 清空测试数据库 → 重新按「本地为准」初始化。

**多设备冲突**：避免两台设备同时长时间编辑同一篇笔记；冲突时保留内容更完整的版本，手动合并一次。

**同步成功但没进入检索系统**：检查 K07 运行状态、Bellkeeper ingest 接口、以及目标检索侧是否出现新文档。
