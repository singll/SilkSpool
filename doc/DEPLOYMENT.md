# SilkSpool 部署指南

> 适用于: v1.0.0+
> 部署模型: 自包含二进制目录（out/）+ 系统 PATH 软链

---

## 本机实际部署（控制节点）

当前控制节点上的 spool 已按如下方式部署，**日常运维直接用 PATH 中的 `spool` 命令即可**：

```
/opt/SilkSpool/                 # ← 自包含运行目录（由 out/ 复制而来）
├── spool                       # 二进制（make build 产物）
├── silkspool.yaml              # 主配置
├── bundles/                    # Bundle 预制文件
├── hosts/                      # 主机配置（sync pull 填充）
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储

/usr/local/bin/spool  →  /opt/SilkSpool/spool   # 软链，已在 PATH 中
```

因此**任意目录**下执行 `spool <command>` 都会运行 `/opt/SilkSpool/spool`，并自动以
`/opt/SilkSpool/` 为 BaseDir 解析配置。无需 `cd`、无需 `./`、无需 `go run`。

> ⚠️ 注意大小写：本机控制节点安装目录是 `/opt/SilkSpool`（大写 S）。
> 远程 keeper 主机上的 `/opt/silkspool/keeper/...`（小写）是**另一台机器**上的容器栈路径，
> 二者不是同一个目录，配置示例中的远程路径请勿改成大写。

---

## 目录结构

### 项目源码（Git 管理）

```
SilkSpool/                      # ← 代码仓库 (git)
├── cmd/spool/                  # CLI 入口
├── internal/                   # 核心模块
├── pkg/                        # 共享包
├── bundles/                    # Bundle 预制模板
├── silkspool.yaml.example      # 配置模板
├── Makefile                    # 构建脚本
├── doc/                        # 文档
└── ...
```

### 构建输出（`out/`，不在 git 中）

```
out/                            # ← 自包含运行包（make build 产物）
├── spool                       # 可执行文件
├── silkspool.yaml              # 主配置文件（make all 时由 example 生成，幂等不覆盖）
├── bundles/                    # Bundle 预制文件
├── hosts/                      # 主机配置（运行时 sync pull 填充）
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储
```

**设计原则**：`out/` 是完全自包含的目录，复制到任何位置（如 `/opt/SilkSpool`）即可运行，
无需依赖项目源码或 `~/.silkspool`。

---

## 安装步骤（首次部署）

### 1. 从源码构建

```bash
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool

make all          # 编译 + 初始化 out/（复制 bundles、创建运行时目录、生成示例配置）
ls -la out/       # 查看构建产物
```

### 2. 复制到系统目录并软链到 PATH

```bash
# 复制自包含目录到 /opt/SilkSpool
sudo cp -r out/ /opt/SilkSpool
sudo chown -R "$USER":"$USER" /opt/SilkSpool
chmod 755 /opt/SilkSpool/spool
chmod 700 /opt/SilkSpool/keys

# 软链到 PATH，之后任意目录都能用 `spool`
sudo ln -sf /opt/SilkSpool/spool /usr/local/bin/spool
spool version
```

---

## 配置初始化

### 1. 编辑主配置

```bash
vim /opt/SilkSpool/silkspool.yaml
```

关键字段：

```yaml
global:
  ssh_key_path: "./keys/id_silkspool"   # 相对于 /opt/SilkSpool 目录
  default_domain: "singll.net"
  backup_dir: "~/silkspool_backups"

hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    # ... 其他配置
```

### 2. 生成 SSH 密钥

```bash
ssh-keygen -t ed25519 -f /opt/SilkSpool/keys/id_silkspool -N "" -C "silkspool"
chmod 600 /opt/SilkSpool/keys/id_silkspool
```

### 3. 初始化主机配置（从远程拉取）

```bash
spool init keeper          # 初始化远程主机 SSH 信任 + Docker 权限
spool sync pull keeper     # 拉取远程配置到 /opt/SilkSpool/hosts/
```

**说明**：`hosts/` 目录在首次构建时为空，通过 `sync pull` 从远程主机填充，或手动复制旧配置进去。

---

## 使用方式

### 直接用 PATH 中的 `spool`（推荐）

```bash
spool sync push keeper
spool service keeper status
spool exec keeper "docker ps"
```

`spool` 自动以二进制所在目录（`/opt/SilkSpool/`）为 BaseDir 解析配置，**无论从哪运行**都正确。

### 开发模式（项目目录运行）

在项目根目录开发、调试源码时：

```bash
go run ./cmd/spool/ version
go run ./cmd/spool/ sync pull keeper
```

> 运维远程主机时不要用 `go run`，直接用已部署的 `spool` 命令。`go run` 仅用于开发期验证代码改动。

### 指定配置路径

```bash
spool --config /etc/silkspool/silkspool.yaml sync push keeper
```

### 配置搜索顺序

1. `--config` 命令行参数
2. `SILKSPOOL_CONFIG` 环境变量
3. 可执行文件所在目录（`/opt/SilkSpool/`）
4. 当前工作目录（fallback，开发模式）
5. `/etc/silkspool/`（系统级 fallback）

---

## 升级（覆盖二进制）

升级**只覆盖二进制**，绝不整目录覆盖 —— `hosts/`、`keys/`、`silkspool.yaml`、`backups/` 必须原样保留。

```bash
cd /path/to/SilkSpool
git pull
make build                              # 重新编译，产出 out/spool

# 仅覆盖二进制；软链 /usr/local/bin/spool 会自动指向新版本
cp /opt/SilkSpool/spool /opt/SilkSpool/spool.bak.$(date +%Y%m%d_%H%M%S)   # 备份旧版（可选）
cp out/spool /opt/SilkSpool/spool
chmod 755 /opt/SilkSpool/spool
spool version
```

> ❌ 不要用 `cp -r out/ /opt/SilkSpool` 升级 —— 会覆盖运行时的 `hosts/`、`keys/`、`silkspool.yaml`。
> 整目录复制只用于**首次**部署到一个空目录。

---

## Makefile 目标

| 目标 | 说明 |
|------|------|
| `make all` | 编译 + 初始化 out/（默认）。幂等，不覆盖已有 `out/silkspool.yaml` 和 `out/hosts/` |
| `make build` | 仅编译二进制到 `out/spool`（升级时用这个） |
| `make init-out` | 仅初始化 out/ 目录结构（复制 bundles、创建空运行时目录） |
| `make clean` | 删除二进制和 `out/bundles/`，**保留** `hosts/`、`keys/`、`backups/`、`silkspool.yaml` |
| `make dist-clean` | **删除整个 out/ 目录**（含用户数据，破坏性，3 秒确认窗口） |
| `make build-linux` | 交叉编译 linux/amd64 |
| `make build-darwin` | 交叉编译 darwin/arm64 |
| `make build-windows` | 交叉编译 windows/amd64 |

---

## 关于 ~/.silkspool（已移除）

旧版本中 `~/.silkspool/` 是推荐的配置目录。从 v1.0.0+ 起，运行时模型已迁移到**二进制自包含目录**（`/opt/SilkSpool/`）。

- 配置搜索顺序已收敛为 `baseDir → baseDir/.. → /etc/silkspool`，**不再回退到 `~/.silkspool/`**
- 运行时唯一根目录是 `/opt/SilkSpool/`：`spool` 经 `os.Executable()` 自动解析，任意目录运行结果一致
- 如机器上仍有遗留的 `~/.silkspool/`，可安全删除

---

## 安全建议

1. **密钥保护**: `/opt/SilkSpool/keys/` 目录权限设为 `700`
2. **配置隔离**: `out/` 目录不加入 git（已在 `.gitignore` 中）
3. **定期备份**: 备份 `/opt/SilkSpool/silkspool.yaml` 和 `/opt/SilkSpool/hosts/` 目录

---

## 常用命令

```bash
# 初始化主机
spool init keeper

# 同步配置
spool sync push keeper
spool sync pull keeper

# Bundle 操作
spool bundle keeper init keeper
spool bundle keeper up keeper

# 服务管理
spool service keeper status
spool restart keeper n8n
spool logs keeper bellkeeper 200

# n8n 工作流
spool n8n list
spool n8n import

# 远程执行 / 备份
spool exec keeper "docker ps"
spool backup keeper
```

---

*部署模型: 自包含二进制目录 + PATH 软链 | 最后更新: 2026-05-31*
