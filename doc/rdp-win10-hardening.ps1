<#
  rdp-win10-hardening.ps1 —— RDP 安全网关「目标 Win10」加固脚本（doc/RDP-GUARD.md §7）
  在目标 Win10（192.168.7.129，内网、未接 Tailscale）上以管理员 PowerShell 运行。

  适配双路径的真实到达源（已实测）：
    - 路径 B（v4 中转）：经 istoreos 子网路由 SNAT，Win10 看到的源是 192.168.7.1（不是 100.64.0.0/10！
      旧方案基于"Win10 是 Tailscale 节点"的错误前提，已纠正）。
    - 路径 A（v6 直连）：Win10 看到的是公司公网 IPv6（不固定）。
  因两路径源族不同且 v6 不固定，RDP 防火墙保持放行，真正门控在上游
  （txhk 2FA+白名单 / istoreos 3min pinhole）+ 下面的 NLA + 账户锁定 + 低权专账户。

  传输策略（本版）：全程强制 RDP TCP-only（SelectTransport=1）+ 服务端 KeepAlive——
  根治"弱显卡直通 + 受限家宽上行"下翻页快即断连、临时窗口断开难重连。网络层已配套：
  istoreos 路径 A 的 v4 DNAT 改 TCP-only、rdp6-agent 按 conntrack 活跃度保活直连窗口。

  用法（管理员 PowerShell）：  powershell -ExecutionPolicy Bypass -File .\rdp-win10-hardening.ps1
#>

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Write-Host "== RDP 安全网关 Win10 加固 ==" -ForegroundColor Cyan

# 1) 专职低权账户 rdp_remote（仅 Remote Desktop Users + Users，绝不进 Administrators）
$u = 'rdp_remote'
if (-not (Get-LocalUser -Name $u -ErrorAction SilentlyContinue)) {
    $pw = Read-Host -AsSecureString "为 $u 设置强密码(16+位)"
    New-LocalUser -Name $u -Password $pw -PasswordNeverExpires -AccountNeverExpires | Out-Null
    Write-Host "  已创建低权账户 $u"
} else { Write-Host "  $u 已存在，跳过创建" }
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $u -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group 'Users'               -Member $u -ErrorAction SilentlyContinue
if (Get-LocalGroupMember -Group 'Administrators' -Member $u -ErrorAction SilentlyContinue) {
    Write-Warning "  $u 竟在 Administrators 组，请手动移除！"
} else { Write-Host "  确认 $u 不在 Administrators 组 ✓" }

# 2) 启用 RDP + 强制 NLA（网络级认证，连接前即需认证，挡未认证爆破/漏洞）
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
(Get-WmiObject -class Win32_TSGeneralSetting -Namespace root\cimv2\terminalservices `
  -Filter "TerminalName='RDP-tcp'").SetUserAuthenticationRequired(1) | Out-Null
Write-Host "  RDP 已启用 + 强制 NLA ✓"

# 3) 账户锁定（5 次失败锁 15 分钟）—— 方案 A 的 v6 不限源窗口尤其依赖此项
& net accounts /lockoutthreshold:5 /lockoutwindow:15 /lockoutduration:15 | Out-Null
Write-Host "  账户锁定：5 次失败锁 15 分钟 ✓"

# 4) 强制 RDP 传输为 TCP-only（关键：根治"翻页快/高码率时直接断连"）
#    目标机是 PVE 显卡直通的弱显卡 Win10、家宽上行已到顶：RDP-UDP(RemoteFX) 在丢包/受限上行下
#    会触发图形管线 reset → 整条 RDP 会话被拉断。TCP 传输有重传，牺牲一点跟手度换"不掉线"。
#    与网络层呼应：istoreos 路径 A 的 v4 DNAT 已改 TCP-only；此处让 Win10 干脆不协商 UDP，
#    连接更快、无 UDP 探测停顿。日后若想换回"流畅优先"：把 SelectTransport 改回 0 即可。
$ts = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $ts)) { New-Item -Path $ts -Force | Out-Null }
Set-ItemProperty $ts -Name SelectTransport -Value 1 -Type DWord   # 0=TCP+UDP(默认) 1=仅TCP 2=任一
Write-Host "  RDP 传输已强制 TCP-only（SelectTransport=1）✓"

# 4b) 服务端 KeepAlive + 允许断线自动重连（配合家侧 conntrack 连接保活：短暂丢包不掉线、掉了能自动回来）
#     KeepAliveInterval 单位=分钟；服务端周期发保活 PDU，及时发现半死连接并驱动客户端自动重连。
Set-ItemProperty $ts -Name KeepAliveEnable       -Value 1 -Type DWord
Set-ItemProperty $ts -Name KeepAliveInterval     -Value 1 -Type DWord   # 每 1 分钟
Set-ItemProperty $ts -Name fDisableAutoReconnect -Value 0 -Type DWord   # 允许客户端自动重连
Write-Host "  RDP KeepAlive(1min) + 自动重连 已启用 ✓"

# 5) 防火墙：确保 RDP 入站放行（门控在上游，不在此处过度收敛）
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
Write-Host "  已启用 Remote Desktop 入站规则（默认放行）✓"

# 5b) 【可选收敛】只想让 v4 中转(路径 B)从内网网关进、并保留 v6 直连(路径 A)：
#     取消注释执行。注意：会禁用过宽的内置 TCP-In 规则，仅放行 192.168.7.0/24(v4) 与任意 v6。
#     v6 侧的真正门控是 istoreos 的 3min pinhole；若公司 v6 前缀稳定，可把 -RemoteAddress 改成 <prefix>::/48 进一步收敛。
<#
Get-NetFirewallRule -DisplayName 'Remote Desktop - User Mode (TCP-In)' | Disable-NetFirewallRule
Get-NetFirewallRule -DisplayName 'Remote Desktop - User Mode (UDP-In)' | Disable-NetFirewallRule
New-NetFirewallRule -DisplayName 'RDP-pathB-LAN-v4 (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -RemoteAddress 192.168.7.0/24
New-NetFirewallRule -DisplayName 'RDP-pathB-LAN-v4 (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 3389 -RemoteAddress 192.168.7.0/24
New-NetFirewallRule -DisplayName 'RDP-pathA-v6 (TCP)'     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -RemoteAddress ff00::/8,2000::/3
New-NetFirewallRule -DisplayName 'RDP-pathA-v6 (UDP)'     -Direction Inbound -Action Allow -Protocol UDP -LocalPort 3389 -RemoteAddress ff00::/8,2000::/3
Write-Host "  已切换为收敛规则（v4=LAN / v6=全局单播）"
#>

Write-Host "`n== 加固完成 ==" -ForegroundColor Green
Write-Host "提示：用 rdp_remote 账户登录测试；其当前 IPv6 GUA 由 txhk 授权页在 2FA 后实时给出（无需在 DNS 公开）。"
