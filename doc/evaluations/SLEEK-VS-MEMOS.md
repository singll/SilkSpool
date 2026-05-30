# Sleek vs Memos 待办系统调研报告

> 日期：2026-04-10
> 目标：评估使用 Sleek (todo.txt) 替代或补充 Memos 作为待办管理系统的可行性

---

## 一、todo.txt 格式规范

### 1.1 核心格式

```bash
# 未完成任务
(P) 2010-03-15 完成项目报告 +工作 @办公室 due:2010-03-20

# 已完成任务
x 2010-03-16 2010-03-15 完成项目报告
```

### 1.2 语法要素

| 要素 | 语法 | 示例 |
|------|------|------|
| 优先级 | `(A)` 到 `(Z)`，首位 | `(A)` 最高，`(P)` 中 |
| 创建日期 | `YYYY-MM-DD`，无优先级时首位 | `2026-04-10` |
| 完成标记 | `x` + 空格开头 | `x 2026-04-10 ...` |
| 完成日期 | `x` 后第一个日期 | `x 2026-04-10 2026-04-09 ...` |
| 项目标签 | `+项目名` | `+工作`, `+家庭` |
| 上下文 | `@上下文` | `@办公室`, `@电话` |
| 截止日期 | `due:YYYY-MM-DD` | `due:2026-04-15` |
| 扩展元数据 | `key:value` | `rec:1w`, `id:123` |

### 1.3 Sleek 扩展支持

Sleek 在标准格式基础上支持：
- 截止日期 `due:YYYY-MM-DD`
- 重复待办 `rec:+1w` (每周重复)
- 标签过滤（基于 `+` 和 `@`）
- 实时文件监控（File Watcher）

---

## 二、Sleek 功能特性

### 2.1 优点

1. **纯文本存储** - 无数据库依赖，文件可被任何工具读取
2. **生态系统丰富** - todo.txt 格式有大量 CLI/GUI 工具支持
3. **版本控制友好** - 可用 Git 管理 todo.txt 历史
4. **与 Obsidian 兼容** - Obsidian 插件可直接解析 `+项目` 标签
5. **轻量级** - Sleek Electron 应用 < 100MB

### 2.2 局限性

1. **无原生 API** - Sleek 无服务端 API，仅桌面应用
2. **无多人协作** - 纯本地/文件同步模式
3. **移动端弱** - 依赖第三方同步方案
4. **复杂查询局限** - 不适合复杂的筛选和统计

---

## 三、Memos 功能特性

### 3.1 优点

1. **REST API 完整** - 有成熟的 API 支持 CRUD 操作
2. **多平台支持** - Web/iOS/Android 客户端
3. **标签系统灵活** - 支持任意标签
4. **多人协作** - 用户系统完善
5. **与 Matrix 集成成熟** - 已有 n8n 工作流和 Bellkeeper 集成

### 3.2 局限性

1. **数据库依赖** - SQLite，迁移麻烦
2. **非文件优先** - 数据锁定在数据库
3. **格式不开放** - 无法直接被其他工具读取

---

## 四、Matrix 集成方案对比

### 4.1 当前 Memos + Matrix 架构

```
Matrix !指令 → Bellkeeper Gateway → Command Router
                                      ↓
                              DirectMemosHandler
                                      ↓
                              Memos REST API
                                      ↓
                              Memos 数据库
```

### 4.2 Sleek + Matrix 架构方案

#### 方案 A：文件监控 + Bellkeeper 处理

```
Sleek 客户端 ──→ todo.txt ──→ File Watcher ──┐
                                               ↓
Matrix !指令 → Bellkeeper ──→ todo.txt 解析器 ──→ Matrix 响应
                                               ↓
Matrix !指令 ───────────────────────────────→ Matrix 响应
```

**实现要点**：
1. 在服务器部署 File Watcher 监控 `todo.txt`
2. Bellkeeper 新增 `/api/todos` 端点读写 todo.txt
3. Matrix 命令由 Bellkeeper DirectTodoHandler 处理
4. 定时读取 todo.txt 并格式化输出到 Matrix

#### 方案 B：纯 Bellkeeper 处理

```
Sleek 客户端 ──→ todo.txt ──→ 同步到 Obsidian vault
                                               ↓
Matrix !指令 → Bellkeeper ──→ 解析 todo.txt/Obsidian
                                      ↓
                              Matrix 响应
```

### 4.3 todo.txt 与当前格式对比

| 功能 | Memos `#待办 #P1 #D:2026-04-15` | todo.txt `(P) due:2026-04-15` |
|------|----------------------------------|--------------------------------|
| 优先级 | `#P1` (1-3) | `(A)` 到 `(Z)` |
| 截止日期 | `#D:YYYY-MM-DD` | `due:YYYY-MM-DD` |
| 项目分类 | 无原生支持 | `+项目名` |
| 上下文 | 无原生支持 | `@上下文` |
| 完成 | `done: true` | `x 2026-04-10` |

---

## 五、迁移评估

### 5.1 工作流改动

| 组件 | Memos | Sleek/todo.txt | 改动量 |
|------|-------|----------------|--------|
| Bellkeeper | DirectMemosHandler | DirectTodoHandler (新增) | 中等 |
| O01 健康监控 | 检查 Memos 状态 | 检查 todo.txt 存在性 | 小 |
| O02 每日摘要 | 查询 Memos API | 读取 todo.txt | 小 |
| M02 工作流 | 调用 Memos API | 保留 API 或删除 | 小 |

### 5.2 客户端影响

| 客户端 | Memos | Sleek |
|--------|-------|-------|
| 桌面 | Memos Web | Sleek 桌面应用 |
| 移动端 | Memos iOS/Android | 无官方支持 |
| Matrix 房间 | 指令交互 | 指令交互 (Bellkeeper) |
| Obsidian | 需导出 | 直接读取 `+项目` 标签 |

---

## 六、建议方案

### 6.1 推荐：混合方案（保留 Memos，增量引入 todo.txt）

**理由**：
1. Memos 有成熟的 API 和移动端，迁移风险高
2. todo.txt 格式更适合 Obsidian 笔记联动
3. Bellkeeper 可以同时支持两种格式

**实施步骤**：

1. **Phase 1 - 并行运行**
   - 保留 Memos 作为主要待办系统
   - 新增 `/api/todos/txt` 端点，生成 todo.txt 导出
   - Obsidian 可读取 todo.txt

2. **Phase 2 - 指令统一**
   - `!待办` 指令同时查询 Memos 和 todo.txt
   - 统一格式化输出

3. **Phase 3 - 评估迁移**
   - 根据使用情况决定是否将新待办迁移到 todo.txt

### 6.2 备选：完全迁移到 todo.txt

**适合场景**：
- 移动端需求低
- Obsidian 是主要工作入口
- 接受使用第三方同步方案

**前提条件**：
- 开发 todo.txt 格式的 CRUD API 服务
- 或使用现有开源方案（如 [do marks](https://do marks.com/)）

---

## 七、todo.txt 命令示例

```bash
# 添加待办
(P) 完成报告 +工作 @办公室 due:2026-04-15

# 查看待办（命令行）
todo.sh -l                    # 列出所有
todo.sh -ls +工作             # 只看工作项目
todo.sh -l due:2026-04-15    # 截止日期筛选

# 完成待办
todo.sh do 1                  # 完成第 1 条

# 在 Obsidian 中
- +工作 @办公室 任务列表会自动识别为项目标签
```

---

## 八、结论

| 评估维度 | Memos | Sleek/todo.txt |
|----------|-------|----------------|
| API 完整性 | ⭐⭐⭐⭐⭐ | ⭐ |
| 文件可移植性 | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| Obsidian 集成 | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| 移动端支持 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| Matrix 集成 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 维护成本 | 中等 | 低 |

**建议**：
- 如果移动端和多人协作是刚需 → 保留 Memos
- 如果 Obsidian 是主要工作入口 → 增量引入 todo.txt
- 如果追求极简和数据主权 → 考虑完全迁移到 todo.txt + 自建 API

---

## 参考资料

- [Sleek GitHub](https://github.com/ransome1/sleek)
- [todo.txt 格式规范](https://github.com/todotxt/todotxt)
- [todo.txt-cli](https://github.com/todotxt/todo.txt-cli)
- [当前 Memos 使用情况](#待办系统评估)
