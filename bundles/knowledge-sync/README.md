# Knowledge → Obsidian 发布

prod 独立服务 `sp-knowledge-sync` 使用 [Self-hosted LiveSync 官方 CLI](https://github.com/vrtmrz/obsidian-livesync/tree/main/src/apps/cli) 处理分块、加密和 CouchDB 协议。镜像固定到 compose 中的 digest，不改已有两台客户端的协议设置。

```text
Bellkeeper /mnt/knowledge/vault/（TrueNAS，原件）
  → 30 秒检查 + SHA256 去重/冲突保护
TrueNAS knowledge/obsidian/20-PKB/Bellkeeper/
  ↔ 官方 LiveSync CLI ↔ couchdb.singll.net/obsidian-notes
  ↔ 各终端 Obsidian 的 20-PKB/Bellkeeper/
```

只发布整理后的 `vault/**/*.md`，约 2,535 篇、10 MB。保留领域目录、文件内容和 wikilink。raw、archive、工作流日志、录像和点文件不进入这条发布链路。服务器文件落盘范围由 `syncOnlyRegEx=^20-PKB/Bellkeeper/` 限定；整个数据库的元数据可能出现在 CLI 本地缓存，但不会复制个人 Vault 的其他目录到 NAS。

新增和源更新自动发布；相同内容不重复写。终端修改和删除优先保留，后续源更新会记录为冲突；源删除不删除用户笔记。`publish-status.json` 记录冲突路径，人工对比原件和目标后处理。源文件连续稳定 5 秒才处理；拒绝符号链接、路径越界和大小写/Unicode 冲突。程序没有改写 LiveSync JSON 的逻辑。

## 文件和持久化

| 路径 | 用途 |
|---|---|
| `/mnt/NAS/data/knowledge/vault` | Bellkeeper 产出，只读挂入发布服务 |
| `/mnt/NAS/data/knowledge/obsidian` | NAS 上服务端的局部 Vault，直接 NFS volume 挂载 |
| `/opt/silkspool/knowledge-sync/state` | prod 本地磁盘的 PouchDB、加密配置、发布账本、健康状态；不放 NFS |
| `/opt/SilkSpool/hosts/prod/couchdb/knowledge-livesync-setup.env` | 控制机 Setup URI 与保护口令，0600，不提交 |
| `/opt/SilkSpool/hosts/prod/knowledge-sync/integration` | 推送脚本副本 |

不需要新增域名。两台已经接入的电脑无需再初始化，也无需运行 Windows 拉取脚本。首次数据发布后直接查看现有 Vault 的 `20-PKB/Bellkeeper/`。

## 部署和恢复

配置仍由官方 CLI `setup` 从现有设备导出的 Setup URI 导入。`setup` 后的连接信息和加密口令会由 CLI 加密保存在 `state/.livesync/settings.json`；额外的 `state/monitor.json` 保存用于只读检查的 CouchDB 凭证（0600；当前账号本身仍是专用管理员）；字段为空不代表丢失，应使用 `remote-status` 验证。

首次加入服务器时只对空的本地状态执行官方 `fetch --force --write-settings`，从已存在的远端取回；**不能执行 `rebuild` 或覆盖服务器数据**。正式运行要求 `state/bootstrap-complete.json` 已存在，并确认同步前缀正确。

同步已初始化后更新脚本：

```bash
cp bundles/knowledge-sync/{manifest.yaml,compose.yaml} /opt/SilkSpool/bundles/knowledge-sync/
cp bundles/knowledge-sync/{bridge.cjs,publish.cjs} /opt/SilkSpool/hosts/prod/knowledge-sync/integration/
spool plan knowledge-sync prod --offline
spool apply knowledge-sync prod --yes
spool exec prod 'docker restart sp-knowledge-sync'
```

已有服务只改 bind-mounted 脚本时需要 restart 才加载。日常仅操作此独立服务，不重建 prod-stack/proddata。

```bash
spool exec prod 'docker inspect -f "{{.State.Health.Status}}" sp-knowledge-sync'
spool exec prod 'cat /opt/silkspool/knowledge-sync/state/publish-status.json'
spool exec prod 'docker logs --tail 60 sp-knowledge-sync'
```

容器自动重启，NFS 直接挂载避免 NAS 不可用时误写系统盘；chokidar 使用轮询适配 NFS。CLI 每 30 秒进行同步，初次导入时会有排队延迟。健康检查核对守护进程启动、最近发布检查，以及 CouchDB 元数据的路径/大小/修改时间。待上传持续 5 分钟自动重启并重扫。内部 `http://sp-knowledge-sync:3000/healthz` 已纳入 Bellkeeper 健康探针，n8n O02 沿用既有 Matrix 告警路由；冲突也使该探针返回 503。未发布宿主端口。客户端是否在线仍取决于各终端。

恢复时保留 `publish-manifest.json`，否则会失去“哪些目标由机器写过”的依据。备份 `state` 时先停止本服务，复制状态后启动；冷备状态不替代 NAS 快照/笔记备份。首次发布前加密库的逻辑导出位于 TrueNAS `prod/store/backups/knowledge-sync/20261030/obsidian-notes-before-publish.json.gz`，仅含当前 winning revisions，不是完整 CouchDB 灾备备份。

## 验证

```bash
node --test bundles/knowledge-sync/publish.test.cjs
```

覆盖新增、更新、幂等、原件保留、终端编辑/删除、源删除、已有同名文件、路径越界、symlink、大小写冲突、点文件和未完成写入。


部署后 `spool plan knowledge-sync prod` 的唯一摘要差异来自 Spool 将运行时 generation/lock-hash 标签加入 override，而 desired 未包含；已逐项核对 compose 与挂载一致，不应因此盲目重建。

生产验收：2,535 篇原件与 NAS 发布副本 SHA256 核对；独立官方客户端成功解密读回测试稿和真实整理稿，SHA256 一致；测试稿增量更新同样通过。临时测试稿已从源与同步目录清理。新启动若文件监听漏掉首次批量创建，远端落后检查会触发重扫，不把单纯“容器运行中”当作同步完成。


上线冷备：`/mnt/NAS/data/prod/store/backups/knowledge-sync/20261030/publisher-state.tar.gz`，包含停服后复制的本地缓存、发布账本、配置和脚本，权限 0600。恢复到同一状态路径后再启动服务，避免丢失导入所有权记录。
