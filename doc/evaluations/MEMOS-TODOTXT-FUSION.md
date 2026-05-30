# Memos + todo.txt 格式融合方案

> 日期：2026-04-10
> 状态：推荐方案

---

## 一、核心思路

**用 Memos 存储，todo.txt 格式内容**

```
Memos (后端存储)
    ↓ 内容字段使用 todo.txt 语法
    ↓
同时支持：
├── Sleek 客户端 (通过文件系统同步)
├── Matrix 机器人 (直接读取 todo.txt 格式)
└── Obsidian (原生识别 +项目 和 @上下文)
```

---

## 二、格式对比与转换

### 2.1 当前 Memos 格式

```
#待办 #P1 #D:2026-04-15 完成项目报告
```

| 元素 | Memos 格式 | 说明 |
|------|-------------|------|
| 待办标记 | `#待办` | 标签 |
| 优先级 | `#P1` / `#P2` / `#P3` | P1=高, P2=中, P3=低 |
| 截止日期 | `#D:2026-04-15` | YYYY-MM-DD |
| 项目分类 | 无原生支持 | 可用 `#项目名` 模拟 |
| 上下文 | 无原生支持 | 可用 `#@上下文` 模拟 |

### 2.2 todo.txt 标准格式

```
(P) 2026-04-10 完成项目报告 +工作 @办公室 due:2026-04-15
```

| 元素 | todo.txt 格式 | 说明 |
|------|---------------|------|
| 优先级 | `(A)` ~ `(Z)` | 首位，A 最高 |
| 创建日期 | `YYYY-MM-DD` | 无优先级时首位 |
| 项目分类 | `+项目名` | 空格分隔 |
| 上下文 | `@上下文` | 空格分隔 |
| 截止日期 | `due:YYYY-MM-DD` | 扩展字段 |

### 2.3 格式转换对照

| 功能 | Memos 内容 | todo.txt 输出 |
|------|------------|----------------|
| 待办内容 | `完成报告` | `完成报告` |
| 高优先级 | `#P1` | `(A)` |
| 中优先级 | `#P2` | `(B)` |
| 低优先级 | `#P3` | (省略) |
| 截止日期 | `#D:2026-04-15` | `due:2026-04-15` |
| 项目 | `#项目名` | `+项目名` |
| 上下文 | `#@上下文` | `@上下文` |

### 2.4 转换示例

**Memos 内容 → Matrix 显示：**

```
Memos: #待办 #P1 #D:2026-04-15 完成报告 +工作 @办公室
          ↓ 转换为 todo.txt
显示:     (A) 完成报告 +工作 @上下文 due:2026-04-15
```

---

## 三、方案优势

### 3.1 同时获得两者优点

| 能力 | Memos 提供 | todo.txt 格式提供 |
|------|-----------|-------------------|
| API 访问 | ✅ REST API | ✅ 内容即是格式 |
| 移动端 | ✅ iOS/Android | ❌ 需第三方同步 |
| Matrix 集成 | ✅ Bellkeeper | ✅ 原生格式 |
| Sleek 桌面 | ❌ | ✅ 读取同一文件 |
| Obsidian 联动 | ❌ | ✅ `+` 和 `@` 原生识别 |
| 版本控制 | ❌ | ✅ Git 管理历史 |

### 3.2 具体场景

#### 场景 1：Matrix 指令

```
用户输入: !新增 P1 D4/20 完成周报 +工作
    ↓
Memos 存储: #待办 #P1 #D:2026-04-20 完成周报 +工作
    ↓
Matrix 响应: (A) 完成周报 +工作 due:2026-04-20
```

#### 场景 2：Obsidian 笔记

```markdown
## 项目进度

- [ ] +项目A 任务1
- [ ] +项目A 任务2
- [ ] @电话 联系客户

Obsidian 插件自动识别为项目和上下文标签
```

#### 场景 3：Sleek 桌面客户端

```
Sleek 监控 ~/SilkSpool/data/todo.txt
    ↓
读取 Memos 导出的 todo.txt 格式
    ↓
显示截止日期、优先级、筛选视图
```

---

## 四、实施方案

### 4.1 Bellkeeper 处理流程

```
Matrix !指令
    ↓
Bellkeeper DirectMemosHandler
    ↓
1. 写入 Memos: #待办 #P1 #D:2026-04-15 内容
2. 同时导出到 todo.txt 文件
    ↓
Matrix 响应: (A) 内容 due:2026-04-15
```

### 4.2 写入流程

```go
// 创建待办
func CreateTodo(content, priority, dueDate, project, context string) {
    // 1. 写入 Memos
    memosContent := formatMemosContent(content, priority, dueDate, project, context)
    memos.Create(memosContent)

    // 2. 追加到 todo.txt
    txtContent := formatTodoTxt(content, priority, dueDate, project, context)
    todoTxt.Append(txtContent)
}
```

### 4.3 导出流程

```bash
# Memos → todo.txt 导出
curl http://memos:5230/api/v1/memos?tagSearch=待办 | \
  jq -r '.memos[] | .content' > ~/todo.txt

# 或由 Bellkeeper 定时同步
```

### 4.4 文件位置

```
/opt/silkspool/
├── keeper/
│   └── data/
│       ├── todo.txt      # 当前待办
│       └── done.txt      # 已完成待办
├── memos/
│   └── memos.db          # Memos 数据库
└── ...
```

---

## 五、命令格式设计

### 5.1 Matrix 指令映射

| 指令 | Memos 存储 | Matrix 显示 |
|------|------------|-------------|
| `!新增 P1 D4/20 完成报告` | `#待办 #P1 #D:2026-04-20 完成报告` | `(A) 完成报告 due:2026-04-20` |
| `!新增 +工作 @电话 联系` | `#待办 #+工作 #@电话 联系` | `联系 +工作 @电话` |
| `!列表` | 查询 `#待办` | todo.txt 格式输出 |
| `!完成 5` | Memos API 标记 done | `x` 开头格式 |

### 5.2 todo.txt 优先级映射

| Matrix 指令 | Memos 标签 | todo.txt |
|-------------|------------|----------|
| P1 | `#P1` | `(A)` |
| P2 | `#P2` | `(B)` |
| P3 / 无 | `#P3` / 无 | (无优先级) |

---

## 六、结论

### 6.1 推荐度

```
⭐⭐⭐⭐⭐ 强烈推荐
```

### 6.2 理由

1. **零迁移成本** - 继续使用 Memos，只需改内容格式
2. **生态打通** - 同时获得 Memos + Sleek + Obsidian 能力
3. **格式统一** - Matrix/Obsidian/CLI 都用 todo.txt
4. **简单实现** - 只需 Memos → todo.txt 导出脚本

### 6.3 下一步行动

1. **Bellkeeper 修改 DirectMemosHandler**
   - 写入时使用 todo.txt 兼容格式
   - 输出时转换为 todo.txt 显示格式

2. **添加导出功能**
   - 定时同步 Memos → todo.txt
   - 或使用 Memos webhook 实时同步

3. **测试验证**
   - Matrix 指令正常
   - Obsidian 插件识别 `+` 和 `@`
   - Sleek 客户端读取

---

## 七、格式模板

### 7.1 Memos 内容模板

```
#待办 #{priority} #{dueDate} {content} {+project} {@context}
```

示例：
```
#待办 #P1 #D:2026-04-20 完成季度报告 +Q1-汇报 @办公室
```

### 7.2 todo.txt 输出模板

```
{priority} {createdDate} {content} +{project} @{context} due:{dueDate}
```

示例：
```
(A) 2026-04-10 完成季度报告 +Q1-汇报 @办公室 due:2026-04-20
```
