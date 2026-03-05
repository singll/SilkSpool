# 项目规则

## 自动提交规则

当你完成一次**完整的修改任务**后，必须自动执行 git commit + push。

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
- **文件被 `.gitignore` 忽略** → 绝对不要用 `git add -f` 强制添加。`.gitignore` 中的规则是有意设置的，被忽略的目录/文件可能包含敏感信息、本地配置或不应公开的内容

### 避免碎片化提交

以下是**错误**示范：
- 用户说"删除无用文件、优化字体、更新文档" → 删一个文件就提交一次 ❌
- 修改了 3 个模块的同一个 Bug → 每改一个文件就提交一次 ❌
- 重构某功能涉及 5 个文件 → 改完 2 个就先提交 ❌

**正确**做法：等所有相关修改全部完成，合并为一次有意义的提交 ✅

### 提交流程

1. 确认所有修改已完成
2. 检查涉及的仓库（可能涉及多个工作目录）
3. 对每个有变更的仓库分别执行：
   - 先用 `git check-ignore <文件>` 检查文件是否被忽略，**被忽略的文件不得提交**
   - `git add <具体文件>` （不用 `git add -A`，逐个添加已修改的文件；**禁止使用 `git add -f`**）
   - `git commit` 使用有意义的中文提交信息
   - `git push origin <当前分支>`
4. 提交信息格式：`<类型>: <简要描述>`
   - 类型：`feat` / `fix` / `refactor` / `docs` / `chore`
   - 示例：`feat: 添加 OBS WebSocket v5 控制器`
   - 示例：`fix: 修复模式优先级逻辑反转`
   - 多项修改可用多行描述
5. 提交完成后告知用户提交结果

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
| K | 知识管道（采集、入库、解析、总结） | K01-article-ingest.json |
| M | 机器人/交互（Matrix 指令、UI 联动） | M01-matrix-bot-base.json |
| O | 运维（监控、备份、清理） | O01-health-monitor.json |

规则：
- 文件名格式：`{前缀}{两位数字}-{英文短名}.json`
- JSON 内部 `"name"` 字段格式：`{前缀}{两位数字}-{中文名称}`（如 `"K02-RSS定时采集"`）
- 子工作流用 `.1` 后缀（如 `K02.1-rss-parse-trigger.json`）
- 新增工作流时在对应分类内递增序号，预留间隔便于插入
- 基础工作流（B 类）排在最前，被其他工作流依赖

当前工作流清单和调用关系详见 `doc/WORKFLOWS.md`。

## Matrix 机器人房间规则

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
