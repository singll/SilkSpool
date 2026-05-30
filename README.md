# SilkSpool (丝轴)

> **"Threads unseen, binding the void."**
> (丝线隐于虚空，编织万物。)

**[English](#english)** | **[中文](#中文)**

---

<a id="english"></a>

## English

**SilkSpool** is a lightweight **Infrastructure as Code (IaC)** orchestration framework inspired by *Hollow Knight: Silksong*.

It rejects the heaviness of K8s and the complex DSL of Ansible, returning to pure **Go binary + Docker Compose**. Through silk threads (CLI), it weaves scattered cloud servers, home routers (iStoreOS/OpenWrt), and PVE virtual machines into an organic, controllable whole.

### Key Changes in V2.0.0

* **Go Rewritten**: Single cross-platform binary, no shell dependencies
* **YAML Config**: Replaced `config.ini` with `silkspool.yaml`
* **Self-Contained**: `out/` directory model - copy anywhere and run

### Core Features

* **Zero Dependency**: Remote nodes require **no agent** — only Docker and SSH
* **Dynamic Prefix**: Unique container naming per host (`sp-redis` vs `redis`)
* **Bundle System**: Package multi-container apps into deployable bundles
* **Portable & Secure**: Sensitive data in `hosts/**/.env` (gitignored)
* **Full-Stack Management**: Docker containers, binary tools, and config sync
* **DNS & Site Management**: One-click management of dnsmasq, OpenClash, Caddy
* **LLM Proxy Integration**: Built-in multi-channel LLM routing with Bellkeeper

### Architecture

```
SilkSpool/                      # Git repository (source code)
├── cmd/spool/                  # CLI entry point (Go)
├── internal/                   # Core modules (Go)
│   ├── engine/                 # Sync, DNS, Bundle, Service managers
│   └── ssh/                    # SSH connection handling
├── pkg/                        # Shared packages
├── bundles/                    # Bundle templates
│   ├── keeper/                # Bellkeeper + n8n + Meilisearch + Memos
│   ├── gateway/                # Caddy + Homepage + DNS
│   ├── server/                # Headscale + Conduit + ntfy
│   ├── bili/                  # BiliRecorder + BiliRobot
│   └── aigateway/             # NewAPI + Redis
├── silkspool.yaml.example      # Configuration template
└── Makefile                   # Build scripts

out/                            # Self-contained runtime (gitignored)
├── spool                       # Binary executable
├── silkspool.yaml              # Runtime config
├── bundles/                    # Bundle files
├── hosts/                      # Host configurations (sync pull)
├── keys/                       # SSH keys
└── backups/                    # Backup storage
```

### Quick Start

```bash
# 1. Build from source
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool
make all

# 2. Configure
cp silkspool.yaml.example out/silkspool.yaml
vim out/silkspool.yaml

# 3. Initialize hosts
./out/spool init keeper
./out/spool sync pull keeper

# 4. Deploy bundles
./out/spool bundle keeper init keeper
./out/spool bundle keeper up keeper
```

### Command Reference

| Command | Description |
| --- | --- |
| `init [host]` | Initialize SSH trust |
| `sync pull/push <host>` | Sync configs between local and remote |
| `dns list/add/remove/push` | Manage DNS records |
| `site list/deploy/push` | Quick site deployment |
| `bundle <name> <init\|up\|down\|status>` | Bundle orchestration |
| `service <host> <status\|start\|stop\|restart\|logs>` | Service control |
| `n8n list/import/export` | n8n workflow management |
| `nas info/pool/dataset/snapshot` | TrueNAS management |
| `backup <host>` | Backup host data |
| `exec <host> <cmd>` | Execute remote command |

### Bundle Stacks

| Bundle | Components | Description |
|--------|-----------|-------------|
| `keeper` | Bellkeeper, n8n, Meilisearch, Memos, CouchDB, RSSHub, NATS | Knowledge management system |
| `gateway` | Caddy, Homepage, dnsmasq, OpenClash | Router gateway |
| `server` | Headscale, Conduit, ntfy | Binary services for VPS |
| `bili` | BiliRecorder, BiliRobot, Dozzle | Bilibili live/chat tools |
| `aigateway` | NewAPI, Redis | LLM API gateway |

---

<a id="中文"></a>

## 中文

**SilkSpool** 是一套受《空洞骑士: 丝之歌》启发的轻量级 **IaC (基础设施即代码)** 运维编排框架。

它拒绝 K8s 的沉重与 Ansible 的复杂 DSL，回归最纯粹的 **Go 二进制 + Docker Compose**。通过一根根"丝线"（CLI），将散落在互联网各处的云服务器、家用软路由 (iStoreOS/OpenWrt) 和 PVE 虚拟机编织成一个有机、可控的整体。

### V2.0.0 重大变更

* **Go 重构**: 单个跨平台二进制文件，无 Shell 依赖
* **YAML 配置**: 用 `silkspool.yaml` 替代 `config.ini`
* **自包含部署**: `out/` 目录模型，复制即运行
* **命令简化**: `./spool` 替代 `./spool.sh`

### 核心特性

* **零依赖**: 远程节点**无需 Agent**，仅需 Docker 和 SSH
* **动态前缀**: 每个主机独立容器命名 (`sp-redis` vs `redis`)
* **Bundle 系统**: 多容器应用打包成可部署单元
* **便携安全**: 敏感数据存于 `hosts/**/.env` (已 gitignore)
* **全栈管理**: Docker 容器、二进制工具、配置同步
* **DNS 与站点管理**: 一键管理 dnsmasq、OpenClash、Caddy
* **LLM Proxy 集成**: 内置多渠道 LLM 路由 (Bellkeeper)

### 架构概览

```
SilkSpool/                      # Git 仓库 (源码)
├── cmd/spool/                  # CLI 入口 (Go)
├── internal/                   # 核心模块 (Go)
│   ├── engine/                 # Sync/DNS/Bundle/Service 管理器
│   └── ssh/                    # SSH 连接处理
├── pkg/                        # 共享包
├── bundles/                    # Bundle 模板
│   ├── keeper/                 # Bellkeeper + n8n + Meilisearch + Memos
│   ├── gateway/                # Caddy + Homepage + DNS
│   ├── server/                 # Headscale + Conduit + ntfy
│   ├── bili/                   # BiliRecorder + BiliRobot
│   └── aigateway/              # NewAPI + Redis
├── silkspool.yaml.example      # 配置模板
└── Makefile                    # 构建脚本

out/                            # 自包含运行时 (gitignored)
├── spool                       # 可执行二进制
├── silkspool.yaml              # 运行时配置
├── bundles/                    # Bundle 文件
├── hosts/                      # 主机配置 (sync pull 填充)
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储
```

### 快速开始

```bash
# 1. 从源码构建
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool
make all

# 2. 配置
cp silkspool.yaml.example out/silkspool.yaml
vim out/silkspool.yaml

# 3. 初始化主机
./out/spool init keeper
./out/spool sync pull keeper

# 4. 部署 Bundle
./out/spool bundle keeper init keeper
./out/spool bundle keeper up keeper
```

### 命令手册

| 命令 | 描述 |
| --- | --- |
| `init [主机]` | 初始化 SSH 信任 |
| `sync pull/push <主机>` | 本地与远程同步配置 |
| `dns list/add/remove/push` | DNS 记录管理 |
| `site list/deploy/push` | 快速站点部署 |
| `bundle <名称> <init\|up\|down\|status>` | Bundle 编排 |
| `service <主机> <status\|start\|stop\|restart\|logs>` | 服务控制 |
| `n8n list/import/export` | n8n 工作流管理 |
| `nas info/pool/dataset/snapshot` | TrueNAS 管理 |
| `backup <主机>` | 备份主机数据 |
| `exec <主机> <命令>` | 远程执行命令 |

### Bundle 栈

| Bundle | 组件 | 说明 |
|--------|------|------|
| `keeper` | Bellkeeper, n8n, Meilisearch, Memos, CouchDB, RSSHub, NATS | 知识管理系统 |
| `gateway` | Caddy, Homepage, dnsmasq, OpenClash | 路由器网关 |
| `server` | Headscale, Conduit, ntfy | VPS 二进制服务 |
| `bili` | BiliRecorder, BiliRobot, Dozzle | B站直播/弹幕工具 |
| `aigateway` | NewAPI, Redis | LLM API 网关 |

---

## 部署模型

SilkSpool V2 采用**自包含二进制目录**模型：

```
# 方式 1: 从源码构建 (推荐)
make all                    # 编译 + 初始化 out/
./out/spool version        # 验证

# 方式 2: 复制 out/ 到目标位置
cp -r out/ /opt/silkspool
/opt/silkspool/spool version

# 方式 3: 下载预编译发行包
wget https://github.com/singll/SilkSpool/releases/latest/download/spool-linux-amd64.tar.gz
tar -xzf spool-linux-amd64.tar.gz -C /opt/silkspool
```

### BaseDir 自动解析

`spool` 自动以自身所在目录为 BaseDir，**无论从哪运行**都能正确找到配置：

```bash
/opt/silkspool/spool sync push keeper    # 自动找到 /opt/silkspool/silkspool.yaml
~/SilkSpool/out/spool version           # 也能工作
```

---

## 扩展指南

```bash
# 添加新 Bundle
mkdir bundles/myapp && vim bundles/myapp/manifest.yaml

# 添加新主机 (编辑 silkspool.yaml)
hosts:
  myhost:
    address: "user@1.2.3.4"
    app_prefix: "sp-"
    bundles: ["myapp"]

# 一键部署站点
./spool site deploy myapp.singll.net 192.168.7.100:8080 MyApp
```

---

## License

MIT License.
Designed for the Void, built for the web.
