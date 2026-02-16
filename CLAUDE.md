# 项目规则

## 自动提交规则

当你完成一次**完整的修改任务**后，必须自动执行 git commit + push。

### 判断"完整修改"的标准

一次完整修改 = 用户提出的一个需求被全部实现完毕，包括：
- 所有相关代码已修改/创建
- 文档已同步更新（如果涉及）
- 无编译/语法错误

### 不应提交的情况

- 仅做了调研/阅读代码，没有实际修改文件
- 修改进行到一半，还有未完成的步骤
- 用户明确说"先不提交"或"不要push"

### 提交流程

1. 确认所有修改已完成
2. 检查涉及的仓库（可能涉及多个工作目录）
3. 对每个有变更的仓库分别执行：
   - `git add <具体文件>` （不用 `git add -A`，逐个添加已修改的文件）
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
