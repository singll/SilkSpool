# SilkSpool 部署指南

> 适用于: v2.0.0+
> 部署模型: 自包含二进制目录（out/）

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
out/                            # ← 自包含运行包
├── spool                       # 可执行文件
├── silkspool.yaml              # 主配置文件
├── bundles/                    # Bundle 预制文件
├── hosts/                      # 主机配置（运行时 sync pull 填充）
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储
```

**设计原则**：`out/` 是一个完全自包含的目录，复制到任何位置（如 `/opt/silkspool`）即可运行，无需依赖项目源码或 `~/.silkspool`。

---

## 安装步骤

### 方式 1: 从源码构建（推荐）

```bash
# 克隆代码仓库
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool

# 一键构建（编译 + 初始化 out/）
make all

# 查看构建产物
ls -la out/
```

### 方式 2: 复制 out/ 到目标位置

```bash
# 复制到系统目录（或任何你想要的位置）
sudo cp -r out/ /opt/silkspool

# 设置权限（可选）
sudo chmod 755 /opt/silkspool/spool
```

### 方式 3: 下载预编译发行包

```bash
# 下载并解压
wget https://github.com/singll/SilkSpool/releases/latest/download/spool-linux-amd64.tar.gz
tar -xzf spool-linux-amd64.tar.gz -C /opt/silkspool

# 验证
/opt/silkspool/spool --version
```

---

## 配置初始化

### 1. 编辑主配置

```bash
vim /opt/silkspool/silkspool.yaml
```

关键字段：

```yaml
global:
  ssh_key_path: "./keys/id_silkspool"   # 相对于 out/ 目录
  default_domain: "singll.net"
  backup_dir: "~/silkspool_backups"      # 备份路径（可保持为 home 目录）

hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    # ... 其他配置
```

### 2. 生成 SSH 密钥

```bash
ssh-keygen -t ed25519 -f /opt/silkspool/keys/id_silkspool -N "" -C "silkspool"
chmod 600 /opt/silkspool/keys/id_silkspool
```

### 3. 初始化主机配置（从远程拉取）

```bash
# 初始化远程主机 SSH 信任
/opt/silkspool/spool init keeper

# 拉取远程配置到 out/hosts/
/opt/silkspool/spool sync pull keeper
```

**说明**：`hosts/` 目录在首次构建时为空，通过 `sync pull` 从远程主机填充，或手动复制旧配置进去。

---

## 使用方式

### BaseDir 自动解析

`spool` 会自动以自身所在目录为 BaseDir，因此**无论从哪运行**，都能正确找到配置：

```bash
# 直接运行
/opt/silkspool/spool sync push keeper
/opt/silkspool/spool service keeper status

# 不需要 cd 到目录
~/ SilkSpool/out/spool version          # 也能工作
```

### 开发模式（项目目录运行）

在项目根目录开发时，可直接运行：

```bash
# 项目根目录有 bundles/，会被识别为有效 BaseDir
go run ./cmd/spool/ version
go run ./cmd/spool/ sync pull keeper
```

### 指定配置路径

```bash
# 使用 --config 参数覆盖自动解析
spool --config /etc/silkspool/silkspool.yaml sync push keeper
```

### 配置搜索顺序

1. `--config` 命令行参数
2. `SILKSPOOL_CONFIG` 环境变量
3. 可执行文件所在目录（如 `out/`）
4. 当前工作目录（fallback，开发模式）
5. `/etc/silkspool/`（系统级 fallback）
6. `~/.silkspool/`（已弃用，保留兼容）

---

## 升级

```bash
# 进入源码目录
cd /path/to/SilkSpool

# 拉取最新代码
git pull

# 重新构建（保留已有的 out/silkspool.yaml 和 out/hosts/）
make all

# 复制到目标位置（如需）
cp -r out/ /opt/silkspool
```

**注意**：`make all` 不会覆盖已有的 `out/silkspool.yaml` 和 `out/hosts/` 内容。

---

## Makefile 目标

| 目标 | 说明 |
|------|------|
| `make all` | 编译 + 初始化 out/（默认） |
| `make build` | 仅编译二进制到 out/spool |
| `make init-out` | 仅初始化 out/ 目录结构（复制 bundles、创建目录） |
| `make clean` | 删除 out/ 目录 |
| `make build-linux` | 交叉编译 linux/amd64 |
| `make build-darwin` | 交叉编译 darwin/arm64 |
| `make build-windows` | 交叉编译 windows/amd64 |

---

## 关于 ~/.silkspool（已弃用）

旧版本中，`~/.silkspool/` 是推荐的配置目录。从 v2.0.0+ 开始，运行时模型已迁移到**二进制自包含目录**（`out/`）。

- `~/.silkspool/` 仍可作为最后的配置 fallback（向后兼容）
- 如果配置从 `~/.silkspool/` 加载，会输出 deprecation 警告
- 建议新部署直接使用 `out/` 模型，旧环境可逐步迁移

---

## 安全建议

1. **密钥保护**: `out/keys/` 或 `/opt/silkspool/keys/` 目录权限设为 `700`
2. **配置隔离**: `out/` 目录不加入 git（已在 `.gitignore` 中）
3. **定期备份**: 备份 `out/silkspool.yaml` 和 `out/hosts/` 目录

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
spool service keeper restart n8n

# n8n 工作流
spool n8n list
spool n8n import

# 备份
spool backup keeper
```

---

*部署模型: 自包含二进制目录 | 最后更新: 2026-05-30*
