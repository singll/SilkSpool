# 穿越 / LFI（路径穿越与本地文件包含）测试手册

> **触发信号**: path traversal, directory traversal, LFI, file inclusion, `../`, alias, koa-static, express.static, serve-static, web.config, App.config, .NET, readFile, Caddy template, VS Code, code-server, theia, 绝对路径, 进程环境, /proc/self/environ, package.json 泄露, config yml
> **适用**: 静态前缀后能拼相对路径、静态服务根配错、模板引擎吃用户输入、公网编辑器无登录墙 · **不适用**: 纯上传漏洞（走 file-upload-test.md）、对象存储 key 越界（走 file-upload-test.md STS 节） · 索引: rules/src/technique-index.md
> 写不写只认 `rules/srcskill/vuln-report-format.md`。读到密钥/账密实值才算成，占位符（`ENTER_YOUR_PASSWORD`）不算。**读文件最小伤害**：只读配置/密钥/环境变量证明，不下载业务库、不碰 `/etc/shadow` 以外的批量拖库。

## 一、四类高价值形态（对 technique-index 短表 88-91 行的展开）

### 1. Nginx alias 缺斜杠 / 静态前缀拼接

```
location /static {
    alias /usr/share/nginx/html/app/static/;   # 少了结尾 / 时
}
```

- 认什么：站上有 `/static` `/assets` `/img` `/files` 这类静态前缀；响应头 Server: nginx。
- 打哪：`/static../`（前缀直接拼 `../`，不带斜杠变体都试：`/static..%2f`、`/static/..%2f..%2f`）。alias 配置错误时 `../` 逃出静态根。
- 出什么算成：读到 web 根外文件——`nginx.conf`、应用配置、`~/.bash_history`、密钥文件，**响应体是文件原文**（不是渲染页）。
- 假点：只 404；`/static/../` 被归一化回静态目录内（本来就有的文件不算）；CDN 直接拦截。

### 2. Node 静态根配错（仓库根交给 koa-static / express.static）

- 认什么：能直接 GET 到 `/package.json`（能 GET 到 package.json 说明静态根可能就是仓库根，`node_modules`、`routes/`、`config/` 都在根下）。
- 打哪：`/config/online.yml` `/config/default.yml` `/config/production.yml`；有 `package.json` 就按 node-config 环境名扫（`/config/custom-environment-variables.yml` 也试）。
- 出什么算成：yml/json 里是**完整库账密或云密钥实值**。
- 假点：静态根只 expose `public/`；yml 里有配置但没有账密（配置结构不算密）；`package.json` 200 但 config 全 404。

### 3. Caddy / 模板引擎吃用户输入

- 认什么：Caddy（响应头 `Server: Caddy`）+ 配了 `templates` 指令；或任何服务端模板渲染口接受用户控制的模板片段。
- 打哪：`{{readFile "path"}}`、`{{include "path"}}` 一类模板原语；Caddy 还可以 `{{httpInclude}}`。
- 出什么算成：模板渲染后文件内容出现在响应里。
- 假点：模板指令被当纯文本输出（没开 templates）；WAF 拦 `{{`。

### 4. .NET 发布物遗留在静态桶 / 静态目录

- 认什么：对象存储或静态目录上有旧 .NET 发布物——`.aspx` 源码还能 GET。
- 打哪：同目录 `web.config` 被 WAF 拦（456/403）别停，打 `App.config`、`*.exe.config`、`bin/*.dll.config`、`bin/*.xml`（XML 文档常带连接串）。
- 出什么算成：完整账密或 DeveloperToken，不是 `ENTER_YOUR_PASSWORD` 占位。
- 假点：aspx 200 但 config 全 404；只有源码没有钥；占位符口令。

### 5. 公网 VS Code 系编辑器（code-server / theia / coder）

- 认什么：`/login` 直接进（无登录墙）或弱口令进；页面里 `AuthType.None` 是常见皮，**没有这个字也打**。
- 打哪：资源接口 path 吃绝对路径——`/proc/self/status` 看 Uid（确认进程身份），再读 `/proc/<pid>/environ`（环境变量里常有 SSH 私钥、Git token、云钥）。抄到环境里的 SSH 私钥别停：解开 PEM，**假钥对照**（假钥应 Permission denied，真钥连环境里配置的 Git 主机问出用户名）。
- 出什么算成：环境里是**他人**邮箱和完整 SSH 私钥，且真钥能问出 Git 用户名。
- 假点：path 要登录；只读到 README/安装脚本；真假钥同一句 Permission denied（私钥可能是部署模板的通用钥）。

## 二、通用探针序列（懒人包）

```
目标/前缀 + ../ → ../.. → /etc/passwd（探活，只证明穿越不报）
/config/*.yml、/package.json、/web.config、/.env（高价值文件优先）
/proc/self/environ（编辑器/容器场景）
%2e%2e%2f、..%2f、%252e（编码变体，WAF 层拦截时逐个试）
```

- 编码变体只试一轮，命中一个就停，别把 bypass 枚举当扫描跑（waf-bypass.md 有全表）。
- 读到 `odbc`/`mysql`/`postgres` 连接串 → 认钥闸前先看 `authbypass-test.md`「调试文档写死 AppSecret」的过闸要求。
