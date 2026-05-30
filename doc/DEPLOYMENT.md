# SilkSpool 部署指南

> 适用于: v2.0.0+
> 二进制与代码分离部署

---

## 目录结构

### 代码仓库 (Git 管理)

```
SilkSpool/                      # ← 代码仓库 (git)
├── cmd/spool/                  # CLI 入口
├── internal/                   # 核心模块
│   ├── config/
│   ├── engine/
│   └── tools/
├── pkg/                        # 共享包
├── bundles/                    # Bundle 模板
├── doc/                        # 文档
├── silkspool.yaml.example      # 配置模板
├── go.mod
└── go.sum
```

### 用户运行环境 (本地配置)

```
~/.silkspool/                   # ← 用户配置目录 (不 git)
├── silkspool.yaml               # 主配置文件
├── keys/                       # SSH 密钥
│   ├── id_silkspool
│   └── age.key                 # SOPS 密钥 (可选)
├── hosts/                      # 主机特定配置
│   └── keeper/
│       ├── .env                # 敏感信息
│       └── n8n-workflows/
└── backups/                   # 备份存储
```

---

## 安装步骤

### 方式 1: 下载预编译二进制

```bash
# 下载最新版本
curl -fsSL https://github.com/singll/SilkSpool/releases/latest/download/spool-linux-amd64 \
  -o spool
chmod +x spool
sudo mv spool /usr/local/bin/

# 验证
spool --version
```

### 方式 2: 从源码编译

```bash
# 克隆代码仓库
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool

# 编译
go build -o spool ./cmd/spool/

# 可选: 安装到系统
sudo mv spool /usr/local/bin/
```

---

## 配置初始化

### 1. 创建配置目录

```bash
mkdir -p ~/.silkspool
mkdir -p ~/.silkspool/keys
mkdir -p ~/.silkspool/hosts
mkdir -p ~/.silkspool/backups
```

### 2. 复制配置模板

```bash
# 从代码仓库复制
cp /path/to/SilkSpool/silkspool.yaml.example ~/.silkspool/silkspool.yaml

# 编辑配置
vim ~/.silkspool/silkspool.yaml
```

### 3. 配置示例

```yaml
global:
  ssh_key_path: "~/.silkspool/keys/id_silkspool"
  default_domain: "example.com"
  backup_dir: "~/.silkspool/backups"
  age_key_path: "~/.silkspool/keys/age.key"

hosts:
  keeper:
    address: "user@192.168.1.10"
    # ... 其他配置
```

### 4. 生成 SSH 密钥

```bash
ssh-keygen -t ed25519 -f ~/.silkspool/keys/id_silkspool -N "" -C "silkspool"
chmod 600 ~/.silkspool/keys/id_silkspool
```

---

## 使用方式

### 基本用法

```bash
# 使用默认配置 (~/.silkspool/silkspool.yaml)
spool sync push keeper
spool bundle keeper up keeper

# 使用指定配置
spool --config /path/to/config.yaml sync push keeper
```

### 环境变量

```bash
# 可选: 设置配置路径环境变量
export SILKSPOOL_CONFIG=~/.silkspool/silkspool.yaml
spool sync push keeper
```

### 配置搜索顺序

1. `--config` 命令行参数
2. `SILKSPOOL_CONFIG` 环境变量
3. `./silkspool.yaml` (当前目录)
4. `~/.silkspool/silkspool.yaml`
5. `/etc/silkspool/silkspool.yaml`

---

## Bundle 模板

Bundle 模板在代码仓库中，使用时需要共享到配置目录：

```bash
# 方式 1: 符号链接
ln -s /path/to/SilkSpool/bundles ~/.silkspool/bundles

# 方式 2: 直接在代码目录运行
cd /path/to/SilkSpool
spool --config ~/.silkspool/silkspool.yaml bundle keeper up keeper
```

---

## 安全建议

1. **密钥保护**: `~/.silkspool/keys/` 目录权限设为 `700`
2. **配置隔离**: 不将 `~/.silkspool/` 目录加入 git
3. **定期备份**: 备份 `~/.silkspool/` 目录

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

## 升级

```bash
# 下载新版本
curl -fsSL https://github.com/singll/SilkSpool/releases/latest/download/spool-linux-amd64 \
  -o spool
chmod +x spool
sudo mv spool /usr/local/bin/spool

# 配置文件不受影响
spool --version
```
