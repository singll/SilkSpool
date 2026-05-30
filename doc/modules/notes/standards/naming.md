# 命名规范

> 目标：让笔记在文件系统、全文检索、链接引用和长期维护中都保持稳定。

---

## 总原则

- 标题优先可读，不优先花哨
- 文件名尽量稳定，避免频繁改名
- 同类笔记命名模式尽量统一
- 永久笔记尽量使用「结论句」命名
- 目录负责粗粒度分层，标题负责表达具体内容
- 领域分类靠 tags，不靠多层目录

---

## 各类型命名模式

### 来源笔记

```text
YYYY-MM-DD 主题 - 来源名
```

落点：`RAW/Articles/` 或 `RAW/Advisories/`

示例：
- `2026-03-29 Kerberos 委派滥用 - SpecterOps`
- `2026-03-29 CVE-2026-xxxx 初步分析 - Vendor Advisory`

### 永久笔记

```text
结论句 / 方法句
```

落点：`KNOWLEDGE/Evergreen/`

示例：
- `Windows 凭据转储检测的关键在访问链而非工具名`
- `漏洞复现记录只有补足边界条件才具备复用价值`

### MOC 文件

```text
主题-MOC
```

落点：对应主题目录内，如 `KNOWLEDGE/Evergreen/Security/`

示例：
- `Security-MOC.md`
- `Windows-AD-MOC.md`

### Lab 笔记

```text
产品/漏洞 - 复现记录 - 版本/场景
```

落点：`KNOWLEDGE/Labs/`

示例：
- `Exchange ProxyShell - 复现记录 - Lab 2019`
- `Confluence OGNL RCE - 复现记录 - Docker 环境`

### 编程笔记

```text
语言 - 问题或模式
```

落点：`KNOWLEDGE/Programming/`

示例：
- `Go - HTTP 超时控制模式`
- `Python - requests 重试策略`
- `PowerShell - Base64 编解码处理`

### 日记

```text
YYYY-MM-DD
```

落点：`Daily/Daily/`

### 周整理

```text
YYYY-Www 周整理
```

落点：`Daily/Weekly/`

示例：`2026-W13 周整理`

### 月复盘

```text
YYYY-MM 月复盘
```

落点：`Daily/Monthly/`

---

## 标签命名规范

- 标签用小写英文，单词间用连字符
- 避免中文、空格、随意缩写
- 标签做横切主题，不替代目录分类

推荐词汇见 [standards/frontmatter.md](frontmatter.md) 的 tags 部分。

---

## 链接与别名

- 文件名保持正式，别名承接简称或英文对应
- 如果一个主题有多个常见叫法，改 `aliases` 而不是频繁改文件名

示例：

```yaml
aliases:
  - Kerberos Delegation Abuse
  - Kerberos 委派滥用
```

---

## 不推荐做法

- 文件名堆砌标签词
- 文件名使用大量特殊字符
- 同类笔记命名模式频繁变换
- 把「最终版」「新版」「可用版」写进标题
- 因措辞不满意而频繁重命名
