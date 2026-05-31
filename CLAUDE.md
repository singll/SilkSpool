# 项目规则

## spool 运维工具使用规则（远程主机运维）

**spool 已编译并部署为系统级二进制**。当确定要用 spool 运维远程主机时，**直接使用系统环境变量（PATH）中的 `spool` 命令** —— 不要重新生成、不要 `go run`、不要写代码绕过它。

| 事项 | 说明 |
|------|------|
| 二进制位置 | `/opt/SilkSpool/spool`（注意大写 S） |
| PATH 命令 | `/usr/local/bin/spool` → 软链到 `/opt/SilkSpool/spool`，**任意目录**直接敲 `spool` |
| BaseDir | 自动解析为 `/opt/SilkSpool/`，配置取 `/opt/SilkSpool/silkspool.yaml` |

### 必须遵守

- ✅ **运维远程主机一律用 PATH 中的 `spool`**（如 `spool exec keeper "..."`、`spool sync push keeper`、`spool restart keeper n8n`），无需 `cd`、无需 `./`
- ❌ **不要为了运维去 `make build` / `go run ./cmd/spool` / 重新编译** —— 已部署的 `spool` 就是运维工具，编译只在改了 spool 源码后才做
- ❌ **不要绕过 spool 写脚本或直接 SSH/curl 操作远程 Docker** —— 一切远程操作走 `spool exec`
- ❌ **不要用 `go run` 跑运维命令** —— `go run` 仅用于开发/调试 spool 源码

### 何时才需要重新编译并部署

**仅当修改了 spool 自身的 Go 源码**（`cmd/`、`internal/`、`pkg/`）后才重新编译，且升级**只覆盖二进制**：

```bash
make build                                # 产出 out/spool
cp out/spool /opt/SilkSpool/spool         # 仅覆盖二进制（保留 hosts/keys/silkspool.yaml）
chmod 755 /opt/SilkSpool/spool
spool version                             # 验证
```

> ❌ **绝不** `cp -r out/ /opt/SilkSpool` 升级 —— 会清掉运行时的 `hosts/`、`keys/`、`silkspool.yaml`。整目录复制只用于首次部署到空目录。

### 常用命令速查

| 命令 | 用途 |
|------|------|
| `spool exec <host> "<cmd>"` | 远程执行命令（运维首选） |
| `spool sync pull/push <host>` | 配置同步（注意：不推送 compose 模板，需手动 push） |
| `spool service <host> status` / `spool restart <host> <svc>` | 服务控制 |
| `spool logs <host> <svc> [lines]` | 查看日志 |
| `spool bundle <name> <init\|up\|down\|status> <host>` | Bundle 编排 |
| `spool n8n list/import/export` | n8n 工作流管理 |
| `spool nas info/pool/dataset/snapshot` | TrueNAS 管理 |
| `spool backup <host>` | 备份主机数据 |
| `spool dns ...` / `spool site deploy ...` | DNS / 站点管理 |

> 完整部署与升级说明见 [doc/DEPLOYMENT.md](doc/DEPLOYMENT.md)。

## 自动提交规则

当你完成一次**完整的修改任务**后，且本次消息产生了至少一个**未被 `.gitignore` 忽略**的文件变更时，必须自动执行 git commit + push。

### 触发前提

自动提交流程只有在同时满足以下条件时才触发：
- 用户在**一条消息**中提出的所有需求都已全部实现
- 本次消息对应的变更中，至少有 1 个文件**未被 `.gitignore` 忽略**

如果本次修改只涉及被 `.gitignore` 忽略的文件/目录：
- **不触发自动提交流程**
- 不进入提交判断或提交执行阶段
- `.gitignore` 判断属于**触发前置条件**，不是触发后的兜底过滤

### 判断"完整修改"的标准

一次完整修改 = 用户在**一条消息**中提出的**所有需求**被全部实现完毕。

核心原则：**一条用户消息 → 一次提交**，不要拆分。

具体来说：
- 用户说"做A、B、C三件事" → 三件事全部做完后，合并为**一次提交**
- 用户说"优化面板" → 所有优化完成后，**一次提交**
- 用户连续发多条消息分别提需求 → 每条消息的需求完成后各提交一次

### 不应提交的情况

- 仅做了调研/阅读代码，没有实际修改文件
- 修改进行到一半，还有未完成的步骤
- 用户明确说"先不提交"或"不要push"
- 一条消息中的多个任务只完成了部分（等全部完成再提交）
- 本次消息产生的变更全部被 `.gitignore` 忽略
- **文件被 `.gitignore` 忽略** → 绝对不要用 `git add -f` 强制添加。`.gitignore` 中的规则是有意设置的，被忽略的目录/文件可能包含敏感信息、本地配置或不应公开的内容

### 操作红线

1. **禁止自行重建容器** — n8n/Memos/Bellkeeper 等有状态服务重建需用户批准
2. **必须用 PATH 中的 `spool` 操作远程** — 禁止直接 SSH 手动操作 Docker（见上 §spool 运维工具使用规则）
3. **禁止 `docker compose down`** — 会停全部服务
4. **绝对禁止对 n8n 执行 `docker compose down -v` / `--volumes`** — 会删除 `kp-n8n-data` volume，工作流、凭证、API Key 永久丢失。n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
5. **禁止 `git add -f`** — doc/hosts/config.ini/keys 在 .gitignore 中

以下是**错误**示范：
- 用户说"删除无用文件、优化字体、更新文档" → 删一个文件就提交一次 ❌
- 修改了 3 个模块的同一个 Bug → 每改一个文件就提交一次 ❌
- 重构某功能涉及 5 个文件 → 改完 2 个就先提交 ❌

**正确**做法：等所有相关修改全部完成，合并为一次有意义的提交 ✅

### 提交流程

1. 确认所有修改已完成
2. 先判断本次消息是否产生了至少一个**未被 `.gitignore` 忽略**的文件变更；如果没有，直接结束，不触发提交流程
3. 检查涉及的仓库（可能涉及多个工作目录）
4. 对每个有变更的仓库分别执行：
   - 先用 `git check-ignore <文件>` 检查文件是否被忽略，**被忽略的文件不得提交**
   - `git add <具体文件>` （不用 `git add -A`，逐个添加已修改的文件；**禁止使用 `git add -f`**）
   - `git commit` 使用有意义的中文提交信息
   - `git push origin <当前分支>`
5. 提交信息格式：`<类型>: <简要描述>`
   - 类型：`feat` / `fix` / `refactor` / `docs` / `chore`
   - 示例：`feat: 添加 OBS WebSocket v5 控制器`
   - 示例：`fix: 修复模式优先级逻辑反转`
   - 多项修改可用多行描述
6. 提交完成后告知用户提交结果

### 管理的仓库

| 目录 | 仓库 |
|------|------|
| `/home/ubuntu/SilkSpool` | singll/SilkSpool |
| `/home/ubuntu/SingllLive` | singll/SingllLive |
| `/home/ubuntu/Bellkeeper` | singll/Bellkeeper |

## n8n 工作流命名规则

工作流文件位于 `hosts/keeper/n8n-workflows/`，命名必须遵循分层序号体系：

| 前缀 | 含义 | 示例 |
|------|------|------|
| B | 基础设施（通知、日志等被广泛依赖的底层服务） | B01-notify.json |
| K | 知识管道（采集、入库、解析、总结） | K01-article-ingest.json, K07-obsidian-sync.json |
| M | 机器人/交互（Matrix 指令、UI 联动） | M01-matrix-bot-base.json |
| O | 运维（监控、备份、清理） | O01-daily-report.json |

规则：
- 文件名格式：`{前缀}{两位数字}-{英文短名}.json`
- JSON 内部 `"name"` 字段格式：`{前缀}{两位数字}-{中文名称}`（如 `"K02-RSS定时采集"`）
- 子工作流用 `.1` 后缀（如 `O02.1-todo-sync.json`）
- 新增工作流时在对应分类内递增序号，预留间隔便于插入
- 基础工作流（B 类）排在最前，被其他工作流依赖

当前工作流清单和调用关系详见 [Bellkeeper/doc/STATUS.md](../Bellkeeper/doc/STATUS.md) 和 [Bellkeeper/doc/ROADMAP.md](../Bellkeeper/doc/ROADMAP.md)。

## Matrix 机器人架构

### 当前实现

Matrix 控制平面已迁移到 **Bellkeeper Matrix Gateway**（`internal/matrix/gateway/`），由 Bellkeeper 直接使用 `mautrix-go` SDK 完成 sync、命令路由、通知发送。**n8n 不再轮询 Matrix**，仅在 M01-M03 工作流中作为命令处理器接收 webhook 转发。

**职责边界**:
- **Bellkeeper**: Matrix Sync、Command Router、权限引擎、通知网关（NATS 队列 + 频道路由）、Admin API
- **n8n M01-M03**: 接收 Bellkeeper 转发的命令 webhook，执行具体业务（Memos 待办、知识问答），结果回写 Bellkeeper `/api/matrix/notify`

### 实现原则

**必须遵守**:
- ✅ 使用前缀命令模式（`!` 或 `！`），不使用 slash 命令（`/`）
- ✅ Matrix 长连接 sync 由 Bellkeeper 承担，n8n 仅做命令业务处理
- ✅ 创建/管理房间通过 Bellkeeper Admin API 或 `/api/matrix/admin/*` 端点

**禁止操作**:
- ❌ 不在 n8n 中重新引入 Matrix 轮询节点
- ❌ 不使用 slash 命令（Matrix 协议未标准化，客户端可能拦截）
- ❌ 不迁移到 Telegram（违背自托管和数据主权原则）

### Matrix 机器人房间规则

创建新的 Matrix 机器人房间或测试房间时，**必须**将 `@singll:matrix.singll.net` 邀请加入房间，以便用户可以使用和测试。

操作方式：
```python
import urllib.request, urllib.parse, json
room_id = '!新房间ID'
encoded = urllib.parse.quote(room_id)
url = f'https://matrix.singll.net/_matrix/client/v3/rooms/{encoded}/invite'
data = json.dumps({'user_id': '@singll:matrix.singll.net'}).encode()
req = urllib.request.Request(url, data=data, headers={
    'Authorization': 'Bearer <BOT_TOKEN>',
    'Content-Type': 'application/json'
})
urllib.request.urlopen(req)
```
