# SilkSpool (丝轴)

> **"Threads unseen, binding the void."**
> (丝线隐于虚空，编织万物。)

**[English](#english)** | **[中文](#中文)**

---

<a id="english"></a>

## English

**SilkSpool** is a lightweight **Infrastructure as Code (IaC)** orchestration framework inspired by *Hollow Knight: Silksong*.

It rejects the heaviness of K8s and the complex DSL of Ansible, returning to pure **Shell + Docker Compose**. Through silk threads (scripts), it weaves scattered cloud servers, home routers (iStoreOS/OpenWrt), and PVE virtual machines into an organic, controllable whole.

### ✨ Core Features

* **🧬 Zero Dependency**: Remote nodes require **no agent** — only Docker and SSH. All logic runs locally, driven purely by Shell.
* **🕸️ Dynamic Prefix**: Unique dynamic container naming. The same template on node A can use `sp-redis`, while node B uses `redis`.
* **📦 Bundle System**: Package complex multi-container full-stack applications into independent "bundles" for one-click distribution, build, and launch.
* **🛡️ Portable & Secure**: Sensitive data lives only in `hosts/**/.env` (gitignored). SSH keys in `keys/` — pull the USB and take your ops environment.
* **⚡️ Full-Stack Management**: Docker containers, binary tools (Caddy, Headscale), and static config file sync.
* **🌐 DNS & Site Management**: One-click management of internal DNS (dnsmasq, OpenClash, Headscale) and reverse proxy (Caddy, Homepage).
* **🔗 Post-Push Hooks**: Auto-execute custom operations after config push (Caddy hot reload, file permission fixes).
* **📥 Auto Config Init**: Bundles automatically download default configs from official sources on first deploy.

### 📂 Project Structure

```
SilkSpool/
├── spool.sh               # CLI entry point
├── config.ini.example     # Configuration template (copy to config.ini)
├── .gitignore             # Protect keys and sensitive configs
├── keys/                  # SSH private keys (gitignored)
│   └── .gitkeep
├── hosts/                 # Per-node data (gitignored)
│   ├── router/            #   caddy/, homepage/, dnsmasq/, openclash/
│   ├── keeper/            #   .env, n8n-workflows/
│   ├── knowledge/         #   .env, ragflow/conf/
│   └── vps/               #   headscale/config.yaml, caddy/Caddyfile
├── bundles/               # Multi-container application bundles
│   ├── knowledge/         #   remote.sh, defaults.sh, templates/
│   ├── gateway/           #   remote.sh, defaults.sh, templates/
│   ├── bili/              #   remote.sh, defaults.sh, templates/
│   └── server/            #   remote.sh, templates/
└── lib/
    ├── core/              # Atomic capability modules
    │   ├── utils.sh       #   Utility library (logging, downloaders)
    │   ├── ssh.sh         #   SSH initialization
    │   ├── sync.sh        #   Config sync + Post-Push Hooks
    │   ├── service.sh     #   Service management (systemd/docker/initd/openwrt)
    │   ├── dns.sh         #   DNS and site management
    │   ├── backup.sh      #   Backup management
    │   ├── install.sh     #   Binary installation
    │   ├── env.sh         #   Shared config/env loader
    │   ├── confirm.sh     #   Write/destructive confirmations
    │   ├── truenas_rpc.py #   TrueNAS WebSocket JSON-RPC helper
    │   └── runner.sh      #   Bundle runner
    └── tools/
        ├── n8n.sh         #   n8n workflow management
        └── nas.sh         #   TrueNAS management
```

### 🚀 Quick Start

#### 1. Preparation

**Local**: Linux or macOS (Bash 4.0+), `git`, `rsync`
**Remote**: Linux servers with Docker and Docker Compose

```bash
git clone https://github.com/YOUR_USERNAME/silkspool.git
cd silkspool
cp config.ini.example config.ini
```

#### 2. Configure

```ini
# config.ini
HOST_INFO["my-vps"]="silkspool@1.2.3.4"
HOST_INFO["router"]="root@192.168.1.1"
HOST_META["my-vps"]="APP_PREFIX="
HOST_META["router"]="APP_PREFIX=sp-"
```

#### 3. Init

```bash
./spool.sh init
```

#### 4. Deploy

```bash
# Knowledge Base Stack
./spool.sh bundle knowledge init my-node
vim hosts/my-node/.env  # Edit passwords
./spool.sh bundle knowledge setup my-node

# Gateway Stack
./spool.sh bundle gateway setup router

# Binary Tools Stack
./spool.sh bundle server setup my-vps
```

### 🛠️ Command Reference

#### Core

| Command | Description |
| --- | --- |
| `init` | Initialize SSH trust and Docker permissions |
| `sync pull <host\|all>` | Pull remote configs to local |
| `sync push <host\|all>` | Push local configs to remote (triggers Post-Push Hooks) |

#### DNS Management

| Command | Description |
| --- | --- |
| `dns list` | List all DNS records |
| `dns add <domain> [ip]` | Add domain (default IP from `DNS_GATEWAY_IP`) |
| `dns remove <domain>` | Remove domain from all DNS systems |
| `dns pull` / `dns push` | Pull / push DNS configs |
| `dns sync-caddy` | Sync domains from Caddyfile to DNS |

```bash
./spool.sh dns add myapp.example.com 192.168.1.10
./spool.sh dns push
./spool.sh restart router dnsmasq openclash
```

#### Site Management

| Command | Description |
| --- | --- |
| `site list` | List all sites (Caddy + Homepage) |
| `site add <domain> <backend> <name> [desc] [icon] [category]` | Add complete site |
| `site remove <domain>` | Remove site (DNS + Caddy + Homepage) |
| `site push` | Push site configs |

```bash
./spool.sh site add myapp.example.com 192.168.1.10:8080 MyApp 'My App' mdi-apps 'Services'
./spool.sh site push
./spool.sh restart router dnsmasq openclash caddy homepage
```

#### Service Management

| Command | Description |
| --- | --- |
| `status <host> [svc]` | View service status |
| `start / stop / restart / reload <host> [svc]` | Manage services |
| `logs <host> <svc> [N]` | View container logs (default 50 lines) |

Supported types: `systemd`, `docker`, `openwrt`, `initd`

#### Bundle Orchestration

| Command | Description |
| --- | --- |
| `bundle <name> init <host>` | Download default configs |
| `bundle <name> setup <host>` | Full deploy (init → merge → push → start) |
| `bundle <name> up <host>` | Quick update (`docker compose up -d`) |
| `bundle <name> down / status <host>` | Stop / view status |
| `stack <host>` | Install binary stack |
| `install <host> <app>` | Install/update single binary tool |

#### n8n / TrueNAS / Others

| Command | Description |
| --- | --- |
| `n8n list / import / update / export / push-import / push-update` | n8n workflow management |
| `nas info / pool list / dataset list / snapshot list` | TrueNAS management via API key |
| `backup <host>` | Execute backup tasks |
| `exec <host> <cmd...>` | Execute remote command |
| `test-url <domain>` | Test reverse proxy |

n8n and TrueNAS keep non-sensitive settings in `config.ini`, while API keys live in `hosts/<node>/.env` such as `N8N_API_KEY` and `TRUENAS_API_KEY`.

### 📖 Advanced Guide

<details>
<summary><b>Dynamic Prefix Mechanism</b></summary>

```yaml
services:
  redis:
    container_name: ${APP_PREFIX:-sp-}redis
```

Control via `HOST_META`:
- Unset → `sp-redis`
- `APP_PREFIX=` → `redis`
- `APP_PREFIX=kb-` → `kb-redis`

</details>

<details>
<summary><b>Sensitive Data Management</b></summary>

Never write passwords in `templates/` or `config.ini`. Use `hosts/<node>/.env`:

```ini
MYSQL_PASSWORD=MySuperSecretPass!
```

SilkSpool auto-syncs `.env` to server; Docker Compose reads it automatically.

</details>

<details>
<summary><b>Sync Rules & Post-Push Hooks</b></summary>

```bash
# Sync rules
declare -a RULES_ROUTER=(
    "caddy/Caddyfile:/opt/caddy/Caddyfile"
)

# Auto-execute after push
declare -a POST_PUSH_HOOKS_ROUTER=(
    "caddy/Caddyfile:docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
)
```

</details>

<details>
<summary><b>Bundle Default Config Mechanism</b></summary>

Each bundle can include `defaults.sh` for auto-downloading configs:

```bash
declare -a CONFIG_DEFAULTS=(
    "config.yaml|https://raw.githubusercontent.com/.../config.yaml|template"
    ".env|LOCAL_TEMPLATE|template"  # Generated inline
)
```

Modes: `download` (ready to use) / `template` (needs editing)

</details>

<details>
<summary><b>Backup</b></summary>

```bash
declare -a BACKUP_KNOWLEDGE=(
    "db-mysql:sp-mysql:ragflow-sql"
    "volume:sp-minio-data:ragflow-files"
)
```

```bash
./spool.sh backup knowledge
```

</details>

### 🤝 Extending

```bash
# Add new bundle
mkdir bundles/minecraft && vim bundles/minecraft/remote.sh

# Add new binary tool (in config.ini)
INSTALL_SOURCES+=("newtool:github-user/repo:linux_{ARCH}.tar.gz:newtool")

# Add new site (one-click)
./spool.sh site add newapp.example.com 192.168.1.10:9000 NewApp
```

---

<a id="中文"></a>

## 中文

**SilkSpool** 是一套受《空洞骑士: 丝之歌》启发的轻量级 **IaC (基础设施即代码)** 运维编排框架。

它拒绝 K8s 的沉重与 Ansible 的复杂 DSL，回归最纯粹的 **Shell + Docker Compose**。通过一根根"丝线"（脚本），将散落在互联网各处的云服务器、家用软路由 (iStoreOS/OpenWrt) 和 PVE 虚拟机编织成一个有机、可控的整体。

### ✨ 核心特性

* **🧬 零依赖**: 远程节点**无需安装 Agent**，仅需 Docker 和 SSH。一切逻辑在本地运行，纯 Shell 驱动。
* **🕸️ 动态前缀**: 独创的动态容器名机制。同一套模板在节点 A 可命名为 `sp-redis`，在节点 B 可命名为 `redis`。
* **📦 护符编排 (Bundle)**: 将复杂的多容器全栈应用打包成独立"护符"，一键分发、构建、启动。
* **🛡️ 便携与安全**: 敏感数据仅存于 `hosts/**/.env` (已 gitignore)。SSH 密钥存于 `keys/`——拔掉优盘即带走运维环境。
* **⚡️ 全栈管理**: Docker 容器、二进制工具安装 (Caddy, Headscale) 和静态配置同步。
* **🌐 DNS 与站点管理**: 一键管理内网 DNS (dnsmasq, OpenClash, Headscale) 和反向代理 (Caddy, Homepage)。
* **🔗 推送钩子**: 配置推送后自动执行自定义操作（Caddy 热重载、文件权限修复等）。
* **📥 配置自动初始化**: Bundle 首次部署时自动从官方源下载默认配置。

### 📂 项目结构

```
SilkSpool/
├── spool.sh               # [核心] CLI 主程序
├── config.ini.example     # [配置] 全局配置模板 (需复制为 config.ini)
├── .gitignore             # [安全] 确保密钥和敏感配置不入库
├── keys/                  # [凭证] SSH 私钥 (内容被 git 忽略)
│   └── .gitkeep
├── hosts/                 # [数据] 各节点个性化数据 (被 git 忽略)
│   ├── router/            #   caddy/, homepage/, dnsmasq/, openclash/
│   ├── keeper/            #   .env, n8n-workflows/
│   ├── knowledge/         #   .env, ragflow/conf/
│   └── vps/               #   headscale/config.yaml, caddy/Caddyfile
├── bundles/               # [护符] 多容器应用编排包
│   ├── knowledge/         #   remote.sh, defaults.sh, templates/
│   ├── gateway/           #   remote.sh, defaults.sh, templates/
│   ├── bili/              #   remote.sh, defaults.sh, templates/
│   └── server/            #   remote.sh, templates/
└── lib/
    ├── core/              # [能力] 原子能力模块
    │   ├── utils.sh       #   工具函数库 (日志、下载器)
    │   ├── ssh.sh         #   SSH 初始化
    │   ├── sync.sh        #   配置同步 + 推送钩子
    │   ├── service.sh     #   服务管理 (systemd/docker/initd/openwrt)
    │   ├── dns.sh         #   DNS 与站点管理
    │   ├── backup.sh      #   备份管理
    │   ├── install.sh     #   二进制安装
    │   ├── env.sh         #   共享配置/环境加载
    │   ├── confirm.sh     #   写入/破坏性操作确认
    │   ├── truenas_rpc.py #   TrueNAS WebSocket JSON-RPC 助手
    │   └── runner.sh      #   Bundle 运行器
    └── tools/
        ├── n8n.sh         #   n8n 工作流管理
        └── nas.sh         #   TrueNAS 管理
```

### 🚀 快速开始

#### 1. 环境准备

**本地要求**: Linux 或 macOS (Bash 4.0+), `git`, `rsync`
**远程要求**: 已安装 Docker 和 Docker Compose 的 Linux 服务器

```bash
git clone https://github.com/YOUR_USERNAME/silkspool.git
cd silkspool
cp config.ini.example config.ini
```

#### 2. 配置丝轴

```ini
# config.ini
HOST_INFO["my-vps"]="silkspool@1.2.3.4"
HOST_INFO["router"]="root@192.168.1.1"
HOST_META["my-vps"]="APP_PREFIX="
HOST_META["router"]="APP_PREFIX=sp-"
```

#### 3. 灵魂绑定（初始化）

首次连接新服务器时执行。脚本会自动生成 SSH 密钥（存放在 `keys/`），推送公钥到服务器，并修正 Docker 权限。

```bash
./spool.sh init
```

#### 4. 编织服务（部署）

```bash
# 部署知识库全栈 (RAGFlow + Firecrawl + n8n)
./spool.sh bundle knowledge init my-node      # 初始化默认配置
vim hosts/my-node/.env                         # 修改密码
./spool.sh bundle knowledge setup my-node      # 部署启动

# 部署网关 (Caddy + Homepage)
./spool.sh bundle gateway setup router

# 部署基础工具栈 (Caddy + Headscale + Conduit + ntfy)
./spool.sh bundle server setup my-vps
```

### 🛠️ 命令手册

#### 核心命令

| 命令 | 描述 |
| --- | --- |
| `init` | 初始化 SSH 互信与 Docker 权限 |
| `sync pull <host\|all>` | 拉取远程配置到本地 |
| `sync push <host\|all>` | 推送本地配置到远程 (自动触发推送钩子) |

#### DNS 管理

同时管理三套 DNS 系统：dnsmasq (主 DNS)、OpenClash (代理模式)、Headscale (VPN 远程访问)。

| 命令 | 描述 |
| --- | --- |
| `dns list` | 列出所有内网 DNS 记录 |
| `dns add <域名> [ip]` | 添加域名 (默认 IP 由 `DNS_GATEWAY_IP` 配置) |
| `dns remove <域名>` | 从所有 DNS 系统中删除域名 |
| `dns pull` / `dns push` | 拉取 / 推送 DNS 配置 |
| `dns sync-caddy` | 从 Caddyfile 同步缺失域名到 DNS |

```bash
./spool.sh dns add myapp.example.com 192.168.1.10
./spool.sh dns push
./spool.sh restart router dnsmasq openclash
```

#### 站点管理

一键添加完整站点：DNS 记录 + Caddy 反向代理 + Homepage 仪表盘入口。

| 命令 | 描述 |
| --- | --- |
| `site list` | 列出所有已配置站点 |
| `site add <域名> <后端> <名称> [描述] [图标] [分类]` | 添加完整站点 |
| `site remove <域名>` | 删除站点 (DNS + Caddy + Homepage) |
| `site push` | 推送所有站点配置 |

```bash
./spool.sh site add myapp.example.com 192.168.1.10:8080 MyApp '我的应用' mdi-apps '服务'
./spool.sh site push
./spool.sh restart router dnsmasq openclash caddy homepage
```

#### 服务管理

统一管理不同类型服务：Systemd、Docker 容器、OpenWrt/init.d 服务。

| 命令 | 描述 |
| --- | --- |
| `status <主机> [服务]` | 查看服务状态 |
| `start / stop / restart / reload <主机> [服务]` | 启动 / 停止 / 重启 / 重载 |
| `logs <主机> <服务> [行数]` | 查看容器日志 (默认 50 行) |

支持的服务类型：`systemd`、`docker`、`openwrt`、`initd`

#### 应用编排 (Bundle)

| 命令 | 描述 |
| --- | --- |
| `bundle <名称> init <主机>` | 下载默认配置到 `hosts/<主机>/` |
| `bundle <名称> setup <主机>` | 全量部署 (初始化 → 合并模板 → 推送 → 启动) |
| `bundle <名称> up <主机>` | 快速更新 (`docker compose up -d`) |
| `bundle <名称> down / status <主机>` | 停止 / 查看状态 |
| `stack <主机>` | 安装主机定义的基础二进制栈 |
| `install <主机> <应用>` | 安装/更新单个二进制工具 |

```bash
# 首次部署新主机
./spool.sh bundle bili init bili-node        # 下载默认配置
vim hosts/bili-node/robot/config/bilidanmaku-api.yaml  # 修改参数
./spool.sh bundle bili setup bili-node       # 部署启动
```

#### n8n / TrueNAS / 其他工具

| 命令 | 描述 |
| --- | --- |
| `n8n list / import / update / export / push-import / push-update` | n8n 工作流管理 |
| `nas info / pool list / dataset list / snapshot list` | 通过 API key 管理 TrueNAS |
| `backup <主机>` | 执行备份任务 |
| `exec <主机> <命令...>` | 远程执行命令 |
| `test-url <域名>` | 测试反向代理 |

n8n 和 TrueNAS 的非敏感配置放在 `config.ini`，API key 等敏感信息放在 `hosts/<节点名>/.env`，例如 `N8N_API_KEY`、`TRUENAS_API_KEY`。

### 📖 进阶指南

<details>
<summary><b>动态前缀机制</b></summary>

在 `templates/` 的 YAML 文件中使用变量：

```yaml
services:
  redis:
    container_name: ${APP_PREFIX:-sp-}redis
```

通过 `HOST_META` 控制:
- 不设置 → 容器名 `sp-redis`
- `APP_PREFIX=` → 容器名 `redis`
- `APP_PREFIX=kb-` → 容器名 `kb-redis`

</details>

<details>
<summary><b>敏感数据管理</b></summary>

**绝对不要将密码写在 `templates/` 或 `config.ini` 中！**

在 `hosts/<节点名>/.env` 中配置（`bundle init` 时自动生成）：

```ini
MYSQL_PASSWORD=MySuperSecretPass!
```

SilkSpool 部署时自动将 `.env` 同步到服务器，Docker Compose 自动读取。

</details>

<details>
<summary><b>同步规则与推送钩子</b></summary>

```bash
# 同步规则：本地路径:远程路径
declare -a RULES_ROUTER=(
    "caddy/Caddyfile:/opt/caddy/Caddyfile"
)

# 推送后自动执行
declare -a POST_PUSH_HOOKS_ROUTER=(
    "caddy/Caddyfile:docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
)
```

`sync push` 推送文件匹配 Hook 模式时，自动在远程执行对应命令。

</details>

<details>
<summary><b>Bundle 默认配置机制</b></summary>

每个 Bundle 可以包含 `defaults.sh`，定义配置的下载源或本地模板：

```bash
declare -a CONFIG_DEFAULTS=(
    "config.yaml|https://raw.githubusercontent.com/.../config.yaml|template"
    ".env|LOCAL_TEMPLATE|template"  # 本地生成
)
```

处理方式: `download` (直接可用) / `template` (需要用户修改)

工作流:
1. `bundle init` 检查本地是否存在配置
2. 不存在则从 URL 下载，或从本地模板生成
3. 自动尝试 ghproxy 加速（解决国内网络问题）
4. 显示修改提示

</details>

<details>
<summary><b>备份与恢复</b></summary>

```bash
# 在 config.ini 中定义
declare -a BACKUP_KNOWLEDGE=(
    "db-mysql:sp-mysql:ragflow-sql"
    "volume:sp-minio-data:ragflow-files"
)
```

```bash
./spool.sh backup knowledge
# 备份文件保存到 $BACKUP_DIR/<主机>/日期/
```

</details>

### 🤝 扩展指南

```bash
# 添加新 Bundle
mkdir bundles/minecraft && vim bundles/minecraft/remote.sh

# 添加新二进制工具 (在 config.ini 中)
INSTALL_SOURCES+=("newtool:github-user/repo:linux_{ARCH}.tar.gz:newtool")

# 一键添加新站点
./spool.sh site add newapp.example.com 192.168.1.10:9000 NewApp
```

---

## 📄 License

MIT License.
Designed for the Void, built for the web.
