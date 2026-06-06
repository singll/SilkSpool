<#
  rdp-win10-hardening.ps1 —— RDP 安全网关「目标 Win10」加固脚本（doc/RDP-GUARD.md §7）
  在目标 Win10（192.168.7.129，内网、未接 Tailscale）上以管理员 PowerShell 运行。

  适配双路径的真实到达源（已实测）：
    - 路径 B（v4 中转）：经 istoreos 子网路由 SNAT，Win10 看到的源是 192.168.7.1（不是 100.64.0.0/10！
      旧方案基于"Win10 是 Tailscale 节点"的错误前提，已纠正）。
    - 路径 A（v6 直连）：Win10 看到的是公司公网 IPv6（不固定）。
  因两路径源族不同且 v6 不固定，RDP 防火墙保持放行，真正门控在上游
  （txhk 2FA+白名单 / istoreos 3min pinhole）+ 下面的 NLA + 账户锁定 + 低权专账户。

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

# 4) 启用 RDP-UDP（RemoteFX，配合 txhk UDP 代理 / 路径 A，提升跟手度；不通自动回退 TCP）
$ts = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $ts)) { New-Item -Path $ts -Force | Out-Null }
Set-ItemProperty $ts -Name fClientDisableUDP -Value 0 -ErrorAction SilentlyContinue
Write-Host "  RDP-UDP 已启用 ✓"

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
