# Win10 → Win11 重装后的 RDP 恢复与 SilkSpool 重建手册

> **适用场景（2026-10-20）**
> - 目标 Windows 已重装为 **Windows 11**，内网 IPv4 变了；
> - txhk 云服务器、iStoreOS、Headscale/Tailscale、家庭宽带都还在；
> - 原控制节点上的 `/opt/SilkSpool` 完全丢失，暂时不能用 `spool`；
> - 目标只是恢复 RDP 三条通路，并在新控制节点重建 SilkSpool。

**先给结论**：

1. **云侧和家侧都不需要“重装”**。`rdp-gateway` 和 `rdp6-agent` 还在跑，先只改 IP/MAC 相关配置。
2. **最快路径是让 Win11 继续使用原来的 `192.168.7.129`**。在 iStoreOS 上给新 Win11 的 MAC 做 DHCP 静态租约，云上 `GW_TARGET`、家侧 DNAT 都不用改。
3. 如果 MAC 也变了，需要额外改 `rdp6-agent` 的 `RDP6_WIN10_MAC`；否则 v6 直连找不到 Win11 的 GUA。
4. SilkSpool 在新控制节点上按本文第 3 节重建：装 Go → clone → `make all` → 安装到 `/opt/SilkSpool` → 软链 → `spool init` 各主机。

---

## 0. 先理解三条通路与“改哪里”

```
外网/公司的 mstsc
  │
  ├─ 路径 B（兜底，任意 v4）
  │    43.129.195.4:33890
  │      → txhk rdp-gateway（TCP/UDP 代理）
  │      → Tailscale 子网路由
  │      → Win11:3389
  │
  ├─ 路径 A-v4（推荐，家宽公网 v4 直连）
  │    家宽当前公网 IPv4:33891
  │      → iStoreOS DNAT（仅 2FA 客户端源 IP）
  │      → Win11:3389
  │
  └─ 路径 A-v6（快，公司有 v6 时）
       [Win11 当前 GUA]:3389
         → iStoreOS fw4 pinhole（TTL 窗口）
         → Win11:3389
```

| 变化 | 必须改的位置 | 说明 |
|------|--------------|------|
| 只有 Win11 IPv4 变，MAC 不变 | 优先 iStoreOS DHCP 静态租约回 `192.168.7.129`；否则改 txhk `GW_TARGET` + iStoreOS `90-rdp4-dnat.nft` | `rdp6-agent` 的 v6 逻辑不依赖 IPv4 |
| MAC 也变了 | 上面的 + iStoreOS `/etc/init.d/rdp6-agent` 里的 `RDP6_WIN10_MAC` | agent 用 MAC 查邻居表/DHCPv6 租约 |
| 只有 Win11 IPv6 变 | 通常不用改 | agent 每次 2FA 后实时发现 GUA |
| Win11 前缀/地址经常变 | 建议脚本关闭 IPv6 临时地址，使用 EUI-64 | 见第 1 节脚本 |

> **关键**：`rdp6-agent` 不保存 Win11 的 IPv4。v4 直连的目标地址在 `/etc/nftables.d/90-rdp4-dnat.nft`；中转目标在 txhk 的 `/etc/rdp-gateway.env` 的 `GW_TARGET`。

---

## 1. 在 Win11 上执行恢复脚本

脚本位置：`doc/rdp-win11-recovery.ps1`。

### 1.1 把脚本放到 Win11

任选一种：

- 用 U 盘/共享目录把 `rdp-win11-recovery.ps1` 拷到 Win11；
- 或者打开 PowerShell，把脚本内容粘贴到 `notepad`，保存为 `C:\rdp-win11-recovery.ps1`。

### 1.2 在“管理员 PowerShell”中运行

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd C:\
.\rdp-win11-recovery.ps1
```

如果不想改 IPv6 隐私设置，可以加 `-SkipIPv6Hardening`（但不推荐；agent 仍可能通过邻居表发现 GUA）。
如果暂时不调 GPU 编码，可以加 `-SkipGpu`。

脚本会：

1. 检查是不是 Win11 家庭版（家庭版不支持 RDP 服务端，会直接报错）；
2. 创建/确认低权账户 `rdp_remote`（仅 Remote Desktop Users + Users）；
3. 启用 RDP、强制 NLA、账户锁定；
4. 强制 RDP **TCP-only**、服务端 KeepAlive、自动重连；
5. 启用 GPU 硬件 H.264（AVC420）、优先物理 GPU、约 60fps；
6. 关闭 IPv6 随机接口标识/临时地址，重启后 Win11 会使用稳定的 EUI-64 地址；
7. 启用 RDP 防火墙入站；
8. 在 `C:\rdp-win11-report.txt` 生成报告，并在屏幕上打印：

```text
WIN11_HOST=...
WIN11_EDITION=Professional
WIN11_ADAPTER=以太网
WIN11_MAC=BC:24:11:98:25:18
WIN11_IPV4=192.168.7.129
WIN11_PREFIX=24
WIN11_GATEWAY=192.168.7.1
WIN11_IPV6=2408:...
RDP_USER=rdp_remote
RDP_LISTEN=yes
```

> **不要把这份报告里的密码/账户信息发到公开渠道**。MAC 和 IPv6 本身不是密码，但也没必要公开。
> 脚本按“默认路由所在网卡”采集 MAC/IP；如果机器同时有有线和 Wi-Fi，请确认 RDP 实际走的就是这块网卡（不需要的网卡建议禁用）。
> 默认不会收紧防火墙。只有确定所有来源都在 `192.168.7.0/24` 或公网 IPv6 时，才加 `-RestrictFirewall`；否则可能把合法的 v4 来源挡掉。

### 1.3 如果必须把 IPv4 固定成旧地址

只有在**本地控制台**（不是远程 RDP）执行，且确认 `192.168.7.129` 没有被别的设备占用：

```powershell
.\rdp-win11-recovery.ps1 -StaticIPv4 192.168.7.129 -PrefixLength 24 `
  -Gateway 192.168.7.1 -DnsServer 192.168.7.1
```

更推荐的做法是**在 iStoreOS 上做 DHCP 静态租约**（见 2.1），Windows 保持自动获取。这样不会和 DHCP 地址池冲突。

### 1.4 重启

IPv6 稳定化设置需要重启才完全生效：

```powershell
Restart-Computer
```

重启后回到 Win11 本地控制台，确认：

```powershell
ipconfig /all
Get-NetTCPConnection -State Listen -LocalPort 3389
Get-NetIPAddress -AddressFamily IPv6 |
  Where-Object { $_.IPAddress -notmatch '^(fe80|fc|fd)' } |
  Select-Object IPAddress, PrefixOrigin, SuffixOrigin
```

> IPv6 稳定化设置重启后可能让 GUA 变化。请在重启后重新看一次 IPv6 地址，并把新 GUA 作为后面 iStoreOS 邻居表检查/`ping -6` 的目标。脚本可以再运行一次（`rdp_remote` 已存在时不会要求重设密码），报告会刷新 `WIN11_IPV6`。

---

## 2. 处理 IP / MAC：优先保留 `192.168.7.129`

### 2.1 方案 A（推荐）：DHCP 静态租约回旧地址

在 iStoreOS 上先看现有的 Win10/Win11 租约配置：

```bash
uci show dhcp | grep -i -E 'win|129|bc:24:11:98:25:18'
```

#### 已有 `config host` 段（例如 `dhcp.win10`）

```bash
uci set dhcp.win10.name='win11'
uci set dhcp.win10.mac='BC:24:11:98:25:18'   # 用脚本报告里的 WIN11_MAC
uci set dhcp.win10.ip='192.168.7.129'
uci set dhcp.win10.hostid='129'
uci commit dhcp
/etc/init.d/odhcpd reload
/etc/init.d/dnsmasq restart
```

如果 Windows 侧已经手动固定了 IP，先把 Windows 改回自动获取，或者直接使用脚本的 `-StaticIPv4` 参数。

#### 没有 `config host` 段

```bash
uci add dhcp host
# 命令会输出类似 cfg0a1b2c，下面用它替换 cfgXXXXXX
uci set dhcp.cfgXXXXXX.name='win11'
uci set dhcp.cfgXXXXXX.mac='BC:24:11:98:25:18'
uci set dhcp.cfgXXXXXX.ip='192.168.7.129'
uci set dhcp.cfgXXXXXX.hostid='129'
uci commit dhcp
/etc/init.d/odhcpd reload
/etc/init.d/dnsmasq restart
```

然后在 Win11 上续租：

```powershell
ipconfig /release
ipconfig /renew
ipconfig
```

确认 `IPv4 地址` 回到 `192.168.7.129` 后，**txhk 和 iStoreOS 的现有 IP 配置都不用改**，直接跳到第 5 节验证。

### 2.2 方案 B：Win11 必须用新 IPv4

> 本节假设新 IP 仍在 `192.168.7.0/24`（Tailscale 子网路由已宣告的网段）。如果 Win11 换到了别的网段，还要在 iStoreOS 的 Tailscale 子网路由里追加该网段，否则路径 B 到不了。

假设脚本报告：

```text
WIN11_IPV4=192.168.7.135
WIN11_MAC=BC:24:11:98:25:18
```

在控制节点上先设变量（后面命令会展开）：

```bash
export WIN_IP='192.168.7.135'
export WIN_MAC='BC:24:11:98:25:18'
```

#### (1) 改 txhk 的中转目标 `GW_TARGET`

```bash
spool exec txhk "sudo cp -a /etc/rdp-gateway.env /etc/rdp-gateway.env.bak.$(date +%s)"
spool exec txhk "sudo grep -n '^GW_TARGET=' /etc/rdp-gateway.env"
spool exec txhk "sudo sed -i 's|^GW_TARGET=.*|GW_TARGET=${WIN_IP}:3389|' /etc/rdp-gateway.env"
spool exec txhk "sudo systemctl restart rdp-gateway"
spool exec txhk "systemctl is-active rdp-gateway; sudo grep -n '^GW_TARGET=' /etc/rdp-gateway.env"
```

> 注意：spool 推送到 `/opt/rdp-gateway/rdp-gateway.env` 只是暂存区，systemd 实际读的是 `/etc/rdp-gateway.env`。改错文件不会生效。

#### (2) 改 iStoreOS 的 v4 直连 DNAT 目标

```bash
spool exec istoreos "cp -p /etc/nftables.d/90-rdp4-dnat.nft /etc/nftables.d/90-rdp4-dnat.nft.bak.$(date +%s)"
spool exec istoreos "grep -n '192[.]168[.]7[.]' /etc/nftables.d/90-rdp4-dnat.nft"
spool exec istoreos "sed -i 's|192[.]168[.]7[.]129|${WIN_IP}|g' /etc/nftables.d/90-rdp4-dnat.nft"
spool exec istoreos "fw4 reload"
spool exec istoreos "grep -n '192[.]168[.]7[.]' /etc/nftables.d/90-rdp4-dnat.nft; nft list ruleset | grep -A4 33891"
```

如果旧地址不是 `.129`，把上面 `192[.]168[.]7[.]129` 换成实际旧地址，或者直接编辑文件。

> 如果 Win11 的 RDP 端口不是 `3389`，`GW_TARGET` 和 DNAT 的目标端口都要一起改；agent 的 `RDP6_RDP_PORT` 也要同步。

#### (3) 如果 MAC 也变了：改 agent 的 `RDP6_WIN10_MAC`

先看 agent 的启动方式（不同版本可能把 env 写在 init 或单独 env 文件）：

```bash
spool exec istoreos "grep -n 'RDP6_' /etc/init.d/rdp6-agent; sed -n '1,120p' /etc/init.d/rdp6-agent"
```

确认 `RDP6_WIN10_MAC` 在 `/etc/init.d/rdp6-agent` 后：

```bash
spool exec istoreos "sed -i 's|RDP6_WIN10_MAC=[^ ]*|RDP6_WIN10_MAC=${WIN_MAC}|' /etc/init.d/rdp6-agent"
spool exec istoreos "/etc/init.d/rdp6-agent restart"
spool exec istoreos "grep -n 'RDP6_WIN10_MAC' /etc/init.d/rdp6-agent; logread | grep rdp6 | tail -20"
```

如果 env 不在 init 文件里，按实际位置修改（例如 `/etc/config/rdp6-agent` 或 `procd_set_param env` 所在文件），不要盲目 sed。

#### (4) 可选：同时为新 IP 做 DHCP 静态租约

即使 Windows 现在是静态 IP，也建议在 iStoreOS 上把该 IP 绑定到该 MAC，防止地址池冲突。命令同 2.1，把 `ip` 改成 `${WIN_IP}`、`hostid` 只在需要 DHCPv6 `::129` 时保留。

---

## 3. 重建 SilkSpool 控制节点

以下命令适用于新的 Ubuntu/Debian 控制节点。其他 Linux 发行版只需替换包管理器。

### 3.1 安装基础依赖

```bash
sudo apt-get update
sudo apt-get install -y git curl make openssh-client rsync ca-certificates
```

> `spool sync pull/push` 依赖本机和远端都有 `rsync`。远端如果没有：
> - Debian/Ubuntu：`sudo apt-get install -y rsync`
> - iStoreOS/OpenWrt：`opkg update && opkg install rsync`
>
> 检查：`spool exec txhk "command -v rsync"`、`spool exec istoreos "command -v rsync"`。

### 3.2 安装 Go（项目要求 Go 1.25+）

```bash
GO_VER=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)
echo "Installing $GO_VER"
curl -fsSLO "https://go.dev/dl/${GO_VER}.linux-amd64.tar.gz"
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf "${GO_VER}.linux-amd64.tar.gz"
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh >/dev/null
. /etc/profile.d/go.sh
go version
```

> 当前项目 `go.mod` 是 `go 1.25.0`。用 1.25 或更高版本都可以；不要用 Ubuntu 自带的旧版 Go。
> 如果机器是 arm64，把 `linux-amd64` 换成 `linux-arm64`。

### 3.3 克隆并编译

```bash
git clone https://github.com/singll/SilkSpool.git ~/SilkSpool
cd ~/SilkSpool
make all          # 编译 spool + 初始化 out/（bundles、hosts、keys、backups、示例配置）
make build-rdp    # 可选：同时编译 rdp-gateway / rdp6-agent
./out/spool version
```

如果 `make all` 提示 `out/silkspool.yaml` 已存在，它不会覆盖，这是正常的。

### 3.4 安装到 `/opt/SilkSpool` 并软链到 PATH

```bash
sudo install -d -o "$USER" -g "$USER" /opt/SilkSpool
sudo cp -a out/. /opt/SilkSpool/
sudo chown -R "$USER":"$USER" /opt/SilkSpool
chmod 755 /opt/SilkSpool/spool
chmod 700 /opt/SilkSpool/keys
sudo ln -sf /opt/SilkSpool/spool /usr/local/bin/spool
spool version
```

> 升级时只覆盖二进制：`make build && cp out/spool /opt/SilkSpool/spool`。
> **绝不** `cp -r out/ /opt/SilkSpool` 覆盖运行目录，否则会清掉 `silkspool.yaml`、`hosts/`、`keys/`。

### 3.5 写主配置

如果 `make all` 已经生成 `/opt/SilkSpool/silkspool.yaml`，直接编辑；否则：

```bash
cp /opt/SilkSpool/silkspool.yaml.example /opt/SilkSpool/silkspool.yaml
vim /opt/SilkSpool/silkspool.yaml
```

先填最小可用配置（只要求能 SSH/exec；bundle、services、sync_rules 可以后补）：

```yaml
global:
  ssh_key_path: "./keys/id_silkspool"
  default_domain: "singll.net"
  dns_gateway_ip: "192.168.7.1"
  dns_gateway_host: "istoreos"
  dns_headscale_server: "100.100.100.100"

hosts:
  istoreos:
    address: "root@192.168.7.1"

  txhk:
    address: "silkspool@43.129.195.4"

  keeper:
    address: "silkspool@192.168.7.230"
```

如果你要恢复完整能力，把 `silkspool.yaml.example` 里对应主机的 `bundles`、`sync_rules`、`services`、`backups` 段落一并保留/补回。示例里已经包含 `istoreos`、`txhk`、`keeper` 的常见配置。

如果希望用 `spool restart` 直接管理 RDP 服务，在对应主机补上：

```yaml
  txhk:
    services:
      - { alias: "rdp-gateway", type: "systemd", name: "rdp-gateway" }

  istoreos:
    services:
      - { alias: "rdp6-agent", type: "initd", name: "rdp6-agent" }
```

之后可以：

```bash
spool restart txhk rdp-gateway
spool restart istoreos rdp6-agent
```

### 3.6 生成/接入 SSH 管控密钥

`spool init` 会自动生成 `/opt/SilkSpool/keys/id_silkspool`，并通过管理员账号把公钥部署到目标用户：

```bash
spool init istoreos    # 目标用户 root；管理员账号通常也是 root
spool init txhk        # 目标用户 silkspool；管理员账号通常 root
spool init keeper      # 目标用户 silkspool；管理员账号通常 root/管理员
```

交互示例：

```text
Admin username (default: root): root
root@43.129.195.4's password: <输入管理员密码>
```

它会：

1. 创建目标用户（如果不存在）；
2. 给目标用户 NOPASSWD sudo；
3. 把新的 `id_silkspool.pub` 追加到 `authorized_keys`；
4. 记录 host key 到 `/opt/SilkSpool/known_hosts`；
5. 验证连接。

> `init` 新建用户时会把初始密码设成用户名（方便首次接入），这是弱密码。恢复后建议给该用户设置强密码，或者直接禁用密码登录（spool 只用 key）。

验证：

```bash
spool exec istoreos "hostname; tailscale status | head"
spool exec txhk "hostname; systemctl is-active headscale; tailscale status | head"
spool exec keeper "hostname; docker ps --format '{{.Names}}' | head"
spool key status --all
```

#### 如果 `spool init` 无法用密码登录

常见于 txhk 关闭了 SSH 密码登录，或 iStoreOS 只允许密钥。到云厂商控制台/VNC（txhk）或路由器 Web/串口控制台（iStoreOS）用管理员登录，手动执行：

```bash
# txhk（目标用户 silkspool）
useradd -m -s /bin/bash silkspool 2>/dev/null || true
echo 'silkspool ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/silkspool
chmod 440 /etc/sudoers.d/silkspool
visudo -cf /etc/sudoers.d/silkspool
mkdir -p /home/silkspool/.ssh
cat >> /home/silkspool/.ssh/authorized_keys <<'EOF'
<把 /opt/SilkSpool/keys/id_silkspool.pub 的内容粘贴到这里>
EOF
chown -R silkspool:silkspool /home/silkspool/.ssh
chmod 700 /home/silkspool/.ssh
chmod 600 /home/silkspool/.ssh/authorized_keys
```

如果目标用户是 root（例如 iStoreOS），把上面的 `/home/silkspool` 改成 `/root`，用户改成 `root`。

然后在控制节点补 known_hosts：

```bash
ssh-keyscan -H 43.129.195.4 >> /opt/SilkSpool/known_hosts
ssh-keyscan -H 192.168.7.1 >> /opt/SilkSpool/known_hosts
chmod 600 /opt/SilkSpool/known_hosts
spool exec txhk "echo ok"
```

> 如果主机重装导致 host key 变化，只删除对应旧记录，不要清空整个 `known_hosts`：
> `ssh-keygen -R 43.129.195.4 -f /opt/SilkSpool/known_hosts`

### 3.7 拉回远程配置（包括 RDP 部署文件）

先看远程 RDP 文件到底叫什么：

```bash
spool exec txhk "sudo systemctl cat rdp-gateway; sudo ls -l /etc/nftables.d /etc/sudoers.d /opt/rdp-gateway | grep -i rdp"
spool exec istoreos "ls -l /etc/init.d/rdp6-agent /opt/rdp6-agent /etc/nftables.d; sed -n '1,140p' /etc/init.d/rdp6-agent"
```

> `spool sync pull` 是用 `silkspool@` 登录用户去读远端文件。txhk 的 `/etc/rdp-gateway.env` 通常是 `640 root:root`，直接 pull 会权限不足。先把它们复制到 spool 用户可读的暂存目录：

```bash
spool exec txhk "sudo install -d -m700 -o silkspool -g silkspool /opt/rdp-gateway/recover"
spool exec txhk "sudo cp -p /etc/rdp-gateway.env /etc/systemd/system/rdp-gateway.service /etc/nftables.d/rdp_guard.nft /etc/sudoers.d/rdp-gateway /opt/rdp-gateway/recover/ && sudo chown silkspool:silkspool /opt/rdp-gateway/recover/*"
```

iStoreOS 是用 `root@` 登录，通常可以直接 pull；如果文件权限特殊，也同样先复制到 `/tmp/rdp6-recover/`。

在 `/opt/SilkSpool/silkspool.yaml` 的对应主机下增加同步规则（把文件名换成上面实际看到的）。**把这些条目追加到已有的 `sync_rules:` 列表里**；只有该主机还没有这个键时才新建 `sync_rules:`，否则 YAML 会出现重复键：

```yaml
  txhk:
    sync_rules:
      # 原有规则保留，不要删
      - { local: "rdp/rdp-gateway.env", remote: "/opt/rdp-gateway/recover/rdp-gateway.env" }
      - { local: "rdp/rdp-gateway.service", remote: "/opt/rdp-gateway/recover/rdp-gateway.service" }
      - { local: "rdp/rdp_guard.nft", remote: "/opt/rdp-gateway/recover/rdp_guard.nft" }
      - { local: "sudoers/rdp-gateway", remote: "/opt/rdp-gateway/recover/rdp-gateway" }

  istoreos:
    sync_rules:
      - { local: "rdp6-agent/init", remote: "/etc/init.d/rdp6-agent" }
      - { local: "rdp6-agent/90-rdp4-dnat.nft", remote: "/etc/nftables.d/90-rdp4-dnat.nft" }
      - { local: "rdp6-agent/token", remote: "/opt/rdp6-agent/token" }
```

然后拉取：

```bash
spool sync pull txhk
spool sync pull istoreos
spool sync pull keeper
spool exec txhk "sudo rm -rf /opt/rdp-gateway/recover"
```

> `hosts/` 下会有 `.env`、token 等敏感文件，务必只在控制节点保存：
> `chmod 600 /opt/SilkSpool/hosts/txhk/rdp/rdp-gateway.env`
> `chmod 600 /opt/SilkSpool/hosts/istoreos/rdp6-agent/token`
> 不要把这些文件提交到 Git。

### 3.8 可选但建议：轮换旧的 spool 密钥

旧控制节点丢失，旧私钥可能随磁盘泄露。等所有主机都恢复可达后：

```bash
spool key status --all
spool key rotate --dry-run
spool key rotate
```

`rotate` 是两阶段全有或全无：先在所有主机部署并验证新公钥，全部成功后才切换本地密钥并移除旧公钥，不会把自己锁在门外。如果有主机永久失联，先 `spool decommission <host>` 再轮换。

---

## 4. 用 spool 修改云侧 / 家侧配置（方案 B）

> 本节**只改配置，不重装二进制**。`rdp-gateway` / `rdp6-agent` 还在跑就不要动它们的可执行文件。

如果第 2.1 节已经把 Win11 恢复到 `192.168.7.129`，本节可以跳过，直接看第 5 节。

### 4.1 查看当前生效配置

```bash
spool exec txhk "sudo grep -E '^(GW_HTTP_LISTEN|GW_PROXY_LISTEN|GW_TARGET|GW_PUBLIC_ADDR|GW_AGENT_URL|GW_AGENT_V4_URL|GW_LOGIN_URL|GW_NFT_SET|GW_TTL)=' /etc/rdp-gateway.env"
spool exec txhk "sudo systemctl show rdp-gateway -p EnvironmentFiles -p ExecStart -p User"
spool exec istoreos "grep -n '192[.]168[.]7[.]' /etc/nftables.d/90-rdp4-dnat.nft; nft list ruleset | grep -E '33891|rdp4_clients|rdp6_open'"
```

### 4.2 改 txhk 中转目标

```bash
spool exec txhk "sudo cp -a /etc/rdp-gateway.env /etc/rdp-gateway.env.bak.$(date +%s)"
spool exec txhk "sudo sed -i 's|^GW_TARGET=.*|GW_TARGET=${WIN_IP}:3389|' /etc/rdp-gateway.env"
spool exec txhk "sudo cp -p /var/lib/rdp-gateway/state.json /var/lib/rdp-gateway/state.json.bak.$(date +%s) 2>/dev/null || true"
spool exec txhk "sudo systemctl restart rdp-gateway"
spool exec txhk "systemctl is-active rdp-gateway; sudo grep -n '^GW_TARGET=' /etc/rdp-gateway.env"
```

### 4.3 改 iStoreOS v4 DNAT 目标

```bash
spool exec istoreos "cp -p /etc/nftables.d/90-rdp4-dnat.nft /etc/nftables.d/90-rdp4-dnat.nft.bak.$(date +%s)"
spool exec istoreos "sed -i 's|192[.]168[.]7[.]129|${WIN_IP}|g' /etc/nftables.d/90-rdp4-dnat.nft"
spool exec istoreos "fw4 reload"
spool exec istoreos "grep -n '192[.]168[.]7[.]' /etc/nftables.d/90-rdp4-dnat.nft"
```

### 4.4 改 agent 的 MAC（仅 MAC 变化时）

```bash
spool exec istoreos "grep -n 'RDP6_WIN10_MAC' /etc/init.d/rdp6-agent"
spool exec istoreos "sed -i 's|RDP6_WIN10_MAC=[^ ]*|RDP6_WIN10_MAC=${WIN_MAC}|' /etc/init.d/rdp6-agent"
spool exec istoreos "/etc/init.d/rdp6-agent restart"
```

### 4.5 确认两端 token 一致

token 不需要重新生成；两边必须完全相同：

```bash
spool exec txhk "sudo sed -n 's/^RDP6_TOKEN=//p' /etc/rdp-gateway.env | tr -d '\r\n' | sha256sum"
spool exec istoreos "tr -d '\r\n' < /opt/rdp6-agent/token | sha256sum"
```

两个 SHA256 应一致。如果不一致，把其中一边改成另一边（注意不要打印完整 token 到公开日志），然后重启：

```bash
spool exec txhk "sudo systemctl restart rdp-gateway"
spool exec istoreos "/etc/init.d/rdp6-agent restart"
```

### 4.6 检查 agent 能否看到 Win11

```bash
export WIN11_GUA='2408:...'   # 用 Win11 报告里重启后的 WIN11_IPV6

# agent 自身状态（不打印 token）
spool exec txhk "sudo bash -c 'source /etc/rdp-gateway.env; curl -fsS \"http://100.64.0.2:8091/status?token=\$RDP6_TOKEN\"'"

# iStoreOS 邻居表里找 Win11 MAC
spool exec istoreos "ip -6 neigh show dev br-lan | grep -i '${WIN_MAC}'"

# 如果邻居表是空的，用 Win11 当前 GUA ping 一次，促使邻居表建立
spool exec istoreos "ping -6 -c 3 ${WIN11_GUA}"
spool exec istoreos "ip -6 neigh show dev br-lan | grep -i '${WIN_MAC}'"
```

`/status` 的 `source` 含义：

- `eui64-observed`：EUI-64 地址已在邻居表，最稳；
- `neigh`：邻居表里的 Win11 真实 GUA；
- `dhcpv6-lease`：DHCPv6 租约；
- `hostid-computed`：按 `RDP6_HOSTID=129` 算出的 `<前缀>::129`（只有 Win11 确实持有该地址时才对）；
- `eui64-computed`：按 MAC 计算，但邻居表没观测到。

如果 `gua` 为空、`resolve_error`，或 `source=hostid-computed` 但 Win11 并没有 `::129`，先解决 IPv6（见第 6 节）。

### 4.7 回滚

前面的命令都留了 `.bak.<timestamp>`：

```bash
spool exec txhk "sudo cp -p \$(ls -t /etc/rdp-gateway.env.bak.* | head -1) /etc/rdp-gateway.env && sudo systemctl restart rdp-gateway"
spool exec istoreos "cp -p \$(ls -t /etc/nftables.d/90-rdp4-dnat.nft.bak.* | head -1) /etc/nftables.d/90-rdp4-dnat.nft && fw4 reload"
```

---

## 5. 验证（按顺序）

先在控制节点设好变量（如果第 2.2 节已经设过就跳过）：

```bash
export WIN_IP='192.168.7.129'       # 或新 IPv4
export WIN_MAC='BC:24:11:98:25:18'  # 脚本报告里的 WIN11_MAC
export WIN11_GUA='2408:...'          # 重启后 Win11 的当前 GUA（没有 v6 可留空）
```

### 5.1 本机 RDP 服务

在 Win11 上：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3389
Test-NetConnection -ComputerName 127.0.0.1 -Port 3389
```

### 5.2 txhk → Win11 的 TCP 可达性

```bash
spool exec txhk "timeout 5 bash -c '</dev/tcp/${WIN_IP}/3389' && echo RDP-TCP-OK || echo RDP-TCP-FAIL"
```

如果失败：

- `GW_TARGET` 是否改对；
- Win11 防火墙是否放行；
- Tailscale 子网路由是否还在（`spool exec txhk "tailscale status | grep 100.64.0.2"`）；
- Win11 是否有网络隔离/AP 隔离。

### 5.3 服务状态

```bash
spool exec txhk "systemctl is-active rdp-gateway; curl -fsS http://127.0.0.1:8090/health; tailscale ping -c 3 100.64.0.2"
spool exec istoreos "/etc/init.d/rdp6-agent status; ss -tlnp | grep 8091"
```

期望：

- `rdp-gateway` active；
- `/health` 返回 `ok`；
- `tailscale ping` 能到 `100.64.0.2`；
- agent 只监听 `100.64.0.2:8091`，不是 `0.0.0.0:8091`。

### 5.4 授权页

浏览器打开：

```text
https://rdp.singll.net
```

通过 Authelia 2FA 后，控制页会显示三条通路。分别点击开通：

- **v4 直连**：页面返回当前家宽公网 IPv4 和端口 `33891`，用 mstsc 连接；
- **v6 直连**：页面返回 Win11 当前 GUA 和端口 `3389`，用 mstsc 连接；
- **中转**：连接 `43.129.195.4:33890`。

### 5.5 三条通路分别验证

```bash
# 中转白名单（开通后）
spool exec txhk "sudo nft list set inet rdp_guard allowed_ips"

# v4 直连限源集合（开通后）
spool exec istoreos "nft list set inet fw4 rdp4_clients"

# v6 pinhole（开通后）
spool exec istoreos "nft list set inet fw4 rdp6_open"
```

预期：

- 未开通时集合为空，端口关闭；
- 开通后出现客户端 IPv4 或 Win11 GUA，带 TTL；
- mstsc 登录用 `rdp_remote` 账户，必须走 NLA；
- 3 分钟（v6/中转）或 `RDP4_TTL`（v4，默认 300/部署 600 秒）后，新连接关闭；已建立会话不受影响。

---

## 6. 故障排查

| 现象 | 优先检查 | 处理 |
|------|----------|------|
| 授权页打不开 / 502 | Caddy、Authelia | `spool exec txhk "systemctl status caddy authelia headscale --no-pager"` |
| 中转 33890 连不上 | `GW_TARGET`、rdp-gateway、Win11 防火墙 | 先 `spool exec txhk "timeout 5 bash -c '</dev/tcp/IP/3389'"` |
| v4 直连卡片报“家侧 agent 无响应” | Tailscale 路由、agent | `tailscale ping 100.64.0.2`；`/etc/init.d/rdp6-agent status` |
| v4 直连有窗口但连不上 | DNAT 目标、fw4 reload | `nft list ruleset \| grep -A5 33891`；确认目标 IP |
| v6 卡片没有 GUA | MAC 不对、Win11 无 v6、邻居表没有 | 改 `RDP6_WIN10_MAC`；Win11 `ipconfig /all`；`ip -6 neigh` |
| v6 有 GUA 但连接被拒 | pinhole 未写入/窗口过期 | `nft list set inet fw4 rdp6_open`；重新点开通 |
| NLA 登录失败 | 账户组、密码、锁定 | `rdp_remote` 在 Remote Desktop Users；密码非空；等待锁定过期 |
| Win11 家庭版 | 不支持 RDP 服务端 | 升级到 Pro/Enterprise/Education |
| `spool init` 密码登录失败 | SSH 禁用了密码/root 登录 | 用云控制台/VNC 手动追加公钥（3.6） |
| `spool sync` 报 rsync not found | 本机或远端缺 rsync | 安装 rsync（3.1） |
| `spool` 报 host key mismatch | 主机重装或 known_hosts 旧记录 | `ssh-keygen -R <host> -f /opt/SilkSpool/known_hosts` 后 `ssh-keyscan` |

日志位置：

```bash
spool exec txhk "sudo journalctl -u rdp-gateway -n 100 --no-pager"
spool exec istoreos "logread | grep rdp6 | tail -50"
spool exec txhk "sudo nft list table inet rdp_guard"
```

---

## 7. 附：云侧组件重建（仅在原文件丢失时）

> 你说云上还在运行，正常情况下**不要执行本节**。先把现有文件 `systemctl cat` / `cat` 出来备份，再考虑重建。

### 7.1 编译

```bash
cd ~/SilkSpool
make build-rdp
ls -lh out/rdp-gateway out/rdp6-agent
```

### 7.2 推送二进制（走 spool 暂存区，不直接覆盖运行文件）

在 `/opt/SilkSpool/silkspool.yaml` 各主机**已有的 `sync_rules:` 列表里追加**（不要把原有列表整个替换掉）：

```yaml
  txhk:
    sync_rules:
      # 原有规则保留，不要删
      - { local: "rdp/rdp-gateway.new", remote: "/opt/rdp-gateway/rdp-gateway.new" }

  istoreos:
    sync_rules:
      # 原有规则保留，不要删
      - { local: "rdp6-agent/rdp6-agent.new", remote: "/opt/rdp6-agent/rdp6-agent.new" }
```

```bash
mkdir -p /opt/SilkSpool/hosts/txhk/rdp /opt/SilkSpool/hosts/istoreos/rdp6-agent
cp out/rdp-gateway /opt/SilkSpool/hosts/txhk/rdp/rdp-gateway.new
cp out/rdp6-agent /opt/SilkSpool/hosts/istoreos/rdp6-agent/rdp6-agent.new

spool sync push txhk
spool sync push istoreos

spool exec txhk "sudo install -m755 -o root -g root /opt/rdp-gateway/rdp-gateway.new /opt/rdp-gateway/rdp-gateway.new.installed && sudo mv /opt/rdp-gateway/rdp-gateway.new.installed /opt/rdp-gateway/rdp-gateway && sudo systemctl restart rdp-gateway"
spool exec istoreos "chmod 755 /opt/rdp6-agent/rdp6-agent.new && mv /opt/rdp6-agent/rdp6-agent.new /opt/rdp6-agent/rdp6-agent && /etc/init.d/rdp6-agent restart"
```

> 注意 `spool sync push` 对非 root 主机会把目标父目录 chown 给同步用户。所以只推到 `/opt/...` 暂存区，再用 `sudo install` 落位到 `/etc` 或运行目录。
> **不要直接覆盖正在运行的二进制**（Linux 会报 `Text file busy`）：先写到 `.new`，再用 `mv` 原子替换，最后重启服务。iStoreOS 是 BusyBox，可能没有 `install` 命令，所以 agent 用 `chmod + mv`。

### 7.3 txhk 最小 env / systemd 模板

`/etc/rdp-gateway.env`（token 与 agent 相同）：

```bash
GW_HTTP_LISTEN=127.0.0.1:8090
GW_PROXY_LISTEN=0.0.0.0:33890
GW_TARGET=192.168.7.129:3389
GW_PUBLIC_ADDR=43.129.195.4:33890
GW_AGENT_URL=http://100.64.0.2:8091/open
GW_AGENT_V4_URL=http://100.64.0.2:8091/open4
GW_LOGIN_URL=https://auth.singll.net/
GW_NFT_SET=rdp_guard
GW_TTL=180
GW_UDP_IDLE=1800
GW_STATE_FILE=/var/lib/rdp-gateway/state.json
GW_HISTORY_LIMIT=160
GW_PERMANENT_REFRESH=90
RDP6_TOKEN=<与 /opt/rdp6-agent/token 相同>
```

如果服务用户还不存在：

```bash
spool exec txhk "id rdp-gateway >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin rdp-gateway"
```

`/etc/systemd/system/rdp-gateway.service`（最小可用；优先恢复原 unit）：

```ini
[Unit]
Description=RDP Gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=rdp-gateway
Group=rdp-gateway
EnvironmentFile=/etc/rdp-gateway.env
ExecStart=/opt/rdp-gateway/rdp-gateway
Restart=always
RestartSec=3
StateDirectory=rdp-gateway
StateDirectoryMode=0750

[Install]
WantedBy=multi-user.target
```

```bash
spool exec txhk "sudo systemctl daemon-reload && sudo systemctl enable --now rdp-gateway"
```

`rdp-gateway` 需要受限 sudo 执行 nft。若 `/etc/sudoers.d/rdp-gateway` 也丢了，先恢复原文件；最小权限示例：

```text
rdp-gateway ALL=(root) NOPASSWD: /usr/sbin/nft add element inet rdp_guard allowed_ips *, /usr/sbin/nft delete element inet rdp_guard allowed_ips *
```

```bash
spool exec txhk "sudo visudo -cf /etc/sudoers.d/rdp-gateway"
```

### 7.4 txhk nft 表模板

```nft
table inet rdp_guard {
    set allowed_ips { type ipv4_addr; flags timeout; }

    chain input {
        type filter hook input priority 0; policy accept;
        ct state established,related accept
        iif "lo" accept
        udp dport 3478 accept
        tcp dport 33890 ip saddr @allowed_ips accept
        udp dport 33890 ip saddr @allowed_ips accept
        tcp dport 33890 drop
        udp dport 33890 drop
    }
}
```

```bash
# 只在表不存在时加载；已有表不要删，避免 33890 短暂失去 drop 闸
spool exec txhk "sudo nft list table inet rdp_guard >/dev/null 2>&1 || sudo nft -f /etc/nftables.d/rdp_guard.nft"
spool exec txhk "sudo nft list table inet rdp_guard"
```

> 如果表已存在但规则不对，先备份 `sudo nft list table inet rdp_guard > /root/rdp_guard.backup.nft`，再在维护窗口用 `nft -f` 原子替换；不要在正常使用时直接 `delete table`。

持久化 unit 优先恢复原有的 `nftables-rdp.service`；如果确实丢了，用 oneshot：

```ini
[Unit]
Description=RDP guard nftables
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/nftables.d/rdp_guard.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

### 7.5 iStoreOS agent init 模板

优先恢复原 `/etc/init.d/rdp6-agent`；如果丢了，最小模板：

```sh
#!/bin/sh /etc/rc.common
START=95
USE_PROCD=1

start_service() {
    procd_open_instance
    procd_set_param command /opt/rdp6-agent/rdp6-agent
    procd_set_param env RDP6_LISTEN=100.64.0.2:8091
    procd_set_param env RDP6_WIN10_MAC=bc:24:11:98:25:18
    procd_set_param env RDP6_LAN_IF=br-lan
    procd_set_param env RDP6_HOSTID=129
    procd_set_param env RDP6_TOKEN="$(cat /opt/rdp6-agent/token)"
    procd_set_param env RDP4_TTL=600
    procd_set_param env RDP4_REFRESH=60
    procd_set_param respawn
    procd_close_instance
}
```

```bash
spool exec istoreos "chmod +x /etc/init.d/rdp6-agent && /etc/init.d/rdp6-agent enable && /etc/init.d/rdp6-agent restart"
```

> `RDP6_WIN10_MAC` 必须换成 Win11 脚本报告里的 MAC（小写或大写都行，agent 会统一转小写）。
> `RDP6_HOSTID=129` 只负责 DHCPv6 `::129` 兜底；MAC 才是邻居表发现的主依据。

### 7.6 iStoreOS fw4 集合 / DNAT

v6 pinhole 集合 `rdp6_open` 与 v4 限源集合 `rdp4_clients` 由 `/etc/config/firewall` 的 `config ipset` 声明；DNAT/SNAT 在 `/etc/nftables.d/90-rdp4-dnat.nft`。这些文件如果还在，**不要重写**，只改目标 IP。若确实丢失，按 `doc/RDP-GUARD.md` 的 §6.3 与 v3.6/v3.7 注记恢复，并确保：

- `rdp4_clients` 是 `ipv4_addr` + `flags timeout`；
- `90-rdp4-dnat.nft` 只做 TCP `33891 → Win11:3389`，源匹配 `@rdp4_clients`；
- `Allow-RDP4-dynamic` / `Allow-RDP6-dynamic` 规则在 fw4 转发链内，不要用独立 base chain；
- 改完执行 `fw4 reload`。

---

## 8. 最小操作清单（赶时间版）

```text
Win11：
  1. 管理员 PowerShell 运行 rdp-win11-recovery.ps1
  2. 记下 WIN11_MAC / WIN11_IPV4 / WIN11_IPV6
  3. 重启

iStoreOS：
  4. 给 WIN11_MAC 做 DHCP 静态租约，IP 保持 192.168.7.129，hostid=129
  5. Win11 上 ipconfig /release && ipconfig /renew

控制节点：
  6. 安装 Go 1.25+、git、make、rsync
  7. git clone / make all
  8. 安装到 /opt/SilkSpool，软链 /usr/local/bin/spool
  9. 写 silkspool.yaml，spool init --all（或逐台 spool init <host>）
  10. spool sync pull，补回 RDP 文件
  11. spool exec txhk "systemctl is-active rdp-gateway"
  12. 打开 https://rdp.singll.net 分别测三条通路
```

如果第 4 步无法保留 `.129`，再执行第 2.2 / 4 节的 IP 修改。
