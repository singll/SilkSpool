# 统一 Frontmatter 字段规范

> 目标：让单 Vault 内的笔记具有一致的检索、筛选、流转和归档能力，同时保持日常写作的低摩擦。

---

## 核心原则

- 必填字段不超过 5 个，其余全部可选
- 路径本身已隐含分区信息，不需要再加 `section` 字段
- 领域分类靠 `tags`，不引入额外 `domain` / `category` 字段
- `updated` 由 Obsidian 或 Templater 自动维护，不手动强制填写

---

## 必填字段（5 个）

| 字段 | 说明 | 示例 |
|------|------|------|
| `title` | 笔记标题 | `"Windows 凭据转储检测要点"` |
| `type` | 笔记类型 | `source` / `evergreen` / `lab` / `programming` / `playbook` / `daily` |
| `status` | 生命周期状态 | `inbox` / `to-distill` / `active` / `evergreen` / `stable` / `archived` |
| `created` | 创建日期 | `2026-03-29` |
| `tags` | 横切标签列表 | `[security, windows, detection]` |

---

## 可选字段

| 字段 | 说明 | 适用场景 |
|------|------|----------|
| `aliases` | 别名 | 有多个常见叫法时 |
| `related` | 相关笔记链接 | 建立主题关联 |
| `derived_from` | 来源笔记 | 提炼时回链原始笔记 |
| `distilled_to` | 提炼目标笔记 | 来源笔记提炼后回填 |
| `confidence` | 内容可信度 | `low` / `medium` / `high` |
| `sensitivity` | 敏感级别 | `public` / `normal` / `internal` / `restricted` |
| `review_cycle` | 回顾周期 | Evergreen 笔记：`quarterly` / `yearly` |
| `updated` | 更新日期 | 建议由 Templater 自动维护 |
| `source` | 原始链接或资料名 | 来源笔记专用 |
| `author` | 作者 | 来源笔记专用 |
| `lab_target` | 目标产品/系统 | Lab 笔记专用 |
| `lab_environment` | 环境说明 | Lab 笔记专用 |
| `verification` | 复现结果 | `success` / `partial` / `failed` |

---

## 推荐枚举值

### `type`

- `source`：来源笔记（文章摘录、通告等）
- `evergreen`：永久笔记
- `lab`：实验/漏洞复现
- `programming`：编程知识
- `playbook`：操作手册 / SOP
- `daily`：日记/周记
- `project`：项目决策/复盘

### `status`

- `inbox`：刚进入，未处理
- `to-distill`：待提炼
- `active`：正在维护
- `evergreen`：已沉淀为稳定知识
- `stable`：已稳定可复用
- `archived`：已归档

### `sensitivity`

- `public`：可公开
- `normal`：普通个人笔记
- `internal`：仅个人内部使用
- `restricted`：高度敏感，不应进入公共同步链路

### 推荐 `tags` 词汇

```text
# 领域
security, programming, ai, operations

# 安全子域
web, windows, linux, active-directory, cloud
reverse-engineering, threat-intel, malware

# 安全能力
detection, hunting, exploitation, persistence
lateral-movement, credential-access, defense-evasion

# 漏洞类型
cve, rce, sqli, xss, privilege-escalation

# 编程语言
python, go, powershell, csharp, shell

# 状态横切
to-distill, evergreen, moc
```

---

## 各类型最小模板示例

### 来源笔记

```yaml
---
title: "文章标题"
type: source
status: to-distill
created: 2026-03-29
tags: [source, security, windows]
source: "https://..."
---
```

### 永久笔记

```yaml
---
title: "Windows 凭据转储检测要点"
type: evergreen
status: evergreen
created: 2026-03-29
tags: [evergreen, security, windows, detection]
derived_from: []
review_cycle: quarterly
---
```

### Lab 笔记

```yaml
---
title: "Exchange ProxyShell 复现记录"
type: lab
status: verified
created: 2026-03-29
tags: [lab, security, web, cve]
lab_target: Exchange 2019
lab_environment: Docker
verification: success
---
```

### 编程笔记

```yaml
---
title: "Go HTTP 超时控制模式"
type: programming
status: stable
created: 2026-03-29
tags: [programming, go]
---
```

### 日记/周记

```yaml
---
title: "2026-W13 周整理"
type: daily
status: active
created: 2026-03-29
tags: [weekly]
---
```

---

## 使用约束

- 不要同时出现多个语义重复字段（如 `tag` 和 `tags`）
- 日期统一使用 `YYYY-MM-DD`
- 列表字段即使为空也建议保留空数组，便于后续自动化
- 不要在 frontmatter 里记录临时状态或过程笔记
