<#
  rdp-win11-recovery.ps1 —— Windows 10 → Windows 11 重装后的 RDP 恢复脚本

  适用场景：
    - 目标 Windows 已重装为 Win11，内网 IPv4 可能变化；
    - txhk 的 rdp-gateway、istoreos 的 rdp6-agent 仍在运行；
    - 需要快速恢复 RDP，并打印 MAC / IPv4 / IPv6 GUA 供远端更新配置。

  脚本做的事：
    1. 检查 Win11 版本（Home 版不支持 RDP 服务端）；
    2. 可选：把 IPv4 固定为指定地址（默认不改，推荐在 iStoreOS 做 DHCP 静态租约）；
    3. 关闭 IPv6 随机接口标识/临时地址，保证 agent 能稳定算出 EUI-64 GUA；
    4. 创建/确认低权账户 rdp_remote（仅 Remote Desktop Users + Users）；
    5. 启用 RDP、强制 NLA、账户锁定、RDP TCP-only、KeepAlive、自动重连；
    6. 启用 GPU 硬件 H.264（AVC420）、优先物理 GPU、~60fps；
    7. 启用防火墙 RDP 入站规则（可选 -RestrictFirewall 收紧到 LAN v4 + 公网 v6）；
    8. 打印并保存 WIN11_MAC / WIN11_IPV4 / WIN11_IPV6 报告。

  用法（管理员 PowerShell）：
    powershell -ExecutionPolicy Bypass -File .\rdp-win11-recovery.ps1

  推荐先让 iStoreOS 保留原来地址 192.168.7.129；这样云上不需要改任何东西。
  如果必须换 IP，再带 -StaticIPv4 参数（仅建议在本地控制台执行）：
    .\rdp-win11-recovery.ps1 -StaticIPv4 192.168.7.129 -PrefixLength 24 `
      -Gateway 192.168.7.1 -DnsServer 192.168.7.1

  注意：修改 IPv4/IPv6 后建议重启一次 Win11，再测试 RDP。
#>

#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$RdpUser = 'rdp_remote',
    [string]$StaticIPv4,
    [ValidateRange(8, 30)]
    [int]$PrefixLength = 24,
    [string]$Gateway = '192.168.7.1',
    [string]$DnsServer = '192.168.7.1',
    [switch]$SkipIPv6Hardening,
    [switch]$SkipGpu,
    [switch]$RestrictFirewall
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Text)
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [!] $Text" -ForegroundColor Yellow
}

function Get-PrefixMask {
    param([int]$Prefix)
    $bytes = New-Object byte[] 4
    for ($i = 0; $i -lt 4; $i++) {
        $bits = [Math]::Min(8, [Math]::Max(0, $Prefix - ($i * 8)))
        $bytes[$i] = [byte](256 - [Math]::Pow(2, 8 - $bits))
    }
    return ($bytes -join '.')
}

function Get-ActiveIPv4Config {
    $net = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        Select-Object -First 1
    if (-not $net) {
        $net = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
    }
    return $net
}

Write-Host '============================================================' -ForegroundColor Magenta
Write-Host ' Windows 11 RDP 恢复 / 安全加固' -ForegroundColor Magenta
Write-Host '============================================================' -ForegroundColor Magenta

# ---------- 1. 版本检查 ----------
Write-Step '检查 Windows 版本'
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$edition = $cv.EditionID
$displayVersion = $cv.DisplayVersion
Write-Host ("  {0} (EditionID={1}, {2})" -f $cv.ProductName, $edition, $displayVersion)
if ($edition -match '^(Core|Home)') {
    throw 'Windows 11 Home/家庭版不支持 RDP 服务端。请升级到 Pro/Enterprise/Education 后再运行。'
}
Write-Ok '版本支持 RDP 服务端'

# ---------- 2. 网络现状 ----------
Write-Step '采集网络信息'
$net = Get-ActiveIPv4Config
if (-not $net) {
    throw '没有找到已连接且带默认网关的网卡。请先确认网络正常。'
}
$ifIndex = $net.InterfaceIndex
$adapter = Get-NetAdapter -InterfaceIndex $ifIndex
$ipv4Info = @($net.IPv4Address | Select-Object -First 1)
$currentIPv4 = $ipv4Info.IPAddress
$currentPrefix = $ipv4Info.PrefixLength
$currentGateway = $net.IPv4DefaultGateway.NextHop
$mac = ($adapter.MacAddress -replace '-', ':').ToUpperInvariant()

Write-Host ("  网卡: {0} ({1})" -f $adapter.Name, $adapter.InterfaceDescription)
Write-Host ("  MAC : {0}" -f $mac)
Write-Host ("  IPv4: {0}/{1}  网关={2}" -f $currentIPv4, $currentPrefix, $currentGateway)
Write-Host '  IPv6:'
$v6 = @(Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notmatch '^(fe80|::1)' -and
        $_.IPAddress -notmatch '^(fc|fd)'
    } |
    Select-Object -ExpandProperty IPAddress)
if ($v6.Count -eq 0) {
    Write-Warn '未发现公网 IPv6（SLAAC/DHCPv6 可能未就绪，路径 A 暂不可用）'
} else {
    $v6 | ForEach-Object { Write-Host "        $_" }
}
$rdpListener = Get-NetTCPConnection -State Listen -LocalPort 3389 -ErrorAction SilentlyContinue
Write-Host ("  RDP 3389 监听: {0}" -f $(if ($rdpListener) { '是' } else { '否' }))

# ---------- 3. 可选：固定 IPv4 ----------
if ($StaticIPv4) {
    if ($StaticIPv4 -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
        throw "StaticIPv4 格式非法: $StaticIPv4"
    }
    Write-Step "把 IPv4 固定为 $StaticIPv4/$PrefixLength（网关 $Gateway）"
    Write-Warn '这会短暂中断当前网络；如果你正在通过远程桌面运行本脚本，请改用本地控制台。'
    Write-Host '  5 秒后执行，按 Ctrl+C 取消...'
    Start-Sleep -Seconds 5

    $mask = Get-PrefixMask -Prefix $PrefixLength
    & netsh interface ipv4 set address name="$($adapter.Name)" static $StaticIPv4 $mask $Gateway | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "netsh 设置静态 IPv4 失败（exit=$LASTEXITCODE）"
    }
    & netsh interface ipv4 set dns name="$($adapter.Name)" static $DnsServer | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "netsh 设置 DNS 失败（exit=$LASTEXITCODE），可稍后手动设置"
    }
    Start-Sleep -Seconds 2
    $currentIPv4 = (Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -eq $StaticIPv4 } |
        Select-Object -First 1).IPAddress
    if (-not $currentIPv4) {
        throw "静态 IPv4 设置后未找到 $StaticIPv4，请立即检查网络配置"
    }
    Write-Ok "IPv4 已固定为 $currentIPv4"
}

# ---------- 4. IPv6 稳定化 ----------
if (-not $SkipIPv6Hardening) {
    Write-Step '关闭 IPv6 随机接口标识/临时地址（让 agent 稳定命中 EUI-64）'
    try {
        Set-NetIPv6Protocol -RandomizeIdentifiers Disabled -UseTemporaryAddresses Disabled -ErrorAction Stop
        Write-Ok '已设置 RandomizeIdentifiers=Disabled, UseTemporaryAddresses=Disabled（重启后生效）'
    } catch {
        Write-Warn "Set-NetIPv6Protocol 失败: $($_.Exception.Message)"
        try {
            & netsh interface ipv6 set privacy state=disabled | Out-Null
            & netsh interface ipv6 set global randomizeidentifiers=disabled store=persistent | Out-Null
            Write-Ok '已通过 netsh 设置（重启后生效）'
        } catch {
            Write-Warn "netsh IPv6 设置也失败: $($_.Exception.Message)"
        }
    }
}

# ---------- 5. 低权账户 ----------
Write-Step "确认低权账户 $RdpUser"
$user = Get-LocalUser -Name $RdpUser -ErrorAction SilentlyContinue
if (-not $user) {
    Write-Warn "账户不存在，将创建 $RdpUser"
    do {
        $secure1 = Read-Host -AsSecureString "为 $RdpUser 设置强密码（至少 16 位，建议随机生成）"
        $secure2 = Read-Host -AsSecureString '再次输入密码'
        $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure1)
        $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure2)
        try {
            $p1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
            $p2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
        }
        if ($p1 -ne $p2) { Write-Warn '两次输入不一致，请重试' }
        elseif ($p1.Length -lt 16) { Write-Warn '密码少于 16 位，请重试' }
    } while ($p1 -ne $p2 -or $p1.Length -lt 16)

    New-LocalUser -Name $RdpUser -Password $secure1 -PasswordNeverExpires -AccountNeverExpires `
        -Description 'RDP gateway low-privilege account' | Out-Null
    Write-Ok "已创建 $RdpUser"
} else {
    Write-Ok "$RdpUser 已存在，保留原密码"
}

$user = Get-LocalUser -Name $RdpUser
try {
    if (-not $user.Enabled) {
        Enable-LocalUser -Name $RdpUser
        Write-Ok '账户原来被禁用，已启用'
    }
    Set-LocalUser -Name $RdpUser -PasswordNeverExpires $true -AccountNeverExpires $true
} catch {
    Write-Warn "设置账户过期策略失败: $($_.Exception.Message)"
}

$rdpGroup = Get-LocalGroup -SID 'S-1-5-32-555'   # Remote Desktop Users
$usersGroup = Get-LocalGroup -SID 'S-1-5-32-545' # Users
$adminGroup = Get-LocalGroup -SID 'S-1-5-32-544' # Administrators
try { Add-LocalGroupMember -Group $rdpGroup -Member $RdpUser -ErrorAction Stop } catch {}
try { Add-LocalGroupMember -Group $usersGroup -Member $RdpUser -ErrorAction Stop } catch {}
$isAdmin = Get-LocalGroupMember -Group $adminGroup -Member $RdpUser -ErrorAction SilentlyContinue
if ($isAdmin) {
    Write-Warn "$RdpUser 在 Administrators 组，请手动移除！"
} else {
    Write-Ok "$RdpUser 已加入 Remote Desktop Users / Users，且不在 Administrators"
}

# ---------- 6. 启用 RDP + NLA + 账户锁定 ----------
Write-Step '启用 RDP、强制 NLA、账户锁定'
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' `
    -Name fDenyTSConnections -Value 0 -Type DWord
$rdpTcp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
Set-ItemProperty $rdpTcp -Name UserAuthentication -Value 1 -Type DWord
try {
    $setting = Get-CimInstance -Namespace 'root/cimv2/terminalservices' `
        -ClassName Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'" -ErrorAction Stop
    $null = Invoke-CimMethod -InputObject $setting -MethodName SetUserAuthenticationRequired `
        -Arguments @{ UserAuthenticationRequired = 1 } -ErrorAction Stop
    Write-Ok 'NLA 已强制启用'
} catch {
    Write-Warn "WMI 设置 NLA 失败，已写入注册表 UserAuthentication=1: $($_.Exception.Message)"
}

Set-Service -Name TermService -StartupType Automatic
Start-Service TermService
Get-Service -Name UmRdpService -ErrorAction SilentlyContinue | Start-Service -ErrorAction SilentlyContinue

& net accounts /lockoutthreshold:5 /lockoutwindow:15 /lockoutduration:15 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok '账户锁定：5 次失败锁 15 分钟'
} else {
    Write-Warn 'net accounts 设置失败，请手动执行'
}

# ---------- 7. RDP 传输 / 画质策略 ----------
Write-Step '设置 RDP TCP-only + KeepAlive + 自动重连'
$ts = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $ts)) { New-Item -Path $ts -Force | Out-Null }
Set-ItemProperty $ts -Name SelectTransport -Value 1 -Type DWord
Set-ItemProperty $ts -Name KeepAliveEnable -Value 1 -Type DWord
Set-ItemProperty $ts -Name KeepAliveInterval -Value 1 -Type DWord
Set-ItemProperty $ts -Name fDisableAutoReconnect -Value 0 -Type DWord
Write-Ok 'SelectTransport=1（仅 TCP）、KeepAlive=1min、自动重连已启用'

if (-not $SkipGpu) {
    Write-Step '启用 GPU 硬件 H.264（AVC420）与 ~60fps'
    Set-ItemProperty $ts -Name AVCHardwareEncodePreferred -Value 1 -Type DWord
    Set-ItemProperty $ts -Name bEnumerateHWBeforeSW -Value 1 -Type DWord
    Set-ItemProperty $ts -Name AVC444ModePreferred -Value 0 -Type DWord
    if (Test-Path $rdpTcp) {
        Set-ItemProperty $rdpTcp -Name DWMFRAMEINTERVAL -Value 15 -Type DWord
    }
    Write-Ok 'GPU 硬编（AVC420）+ 优先物理 GPU + DWMFRAMEINTERVAL=15'
}

# ---------- 8. 防火墙 ----------
Write-Step '启用 RDP 防火墙规则'
$rdpFwGroup = Get-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction SilentlyContinue
$ruleName = 'RDP-Win11-TCP-3389'

# 先确保自定义规则存在并启用，再决定是否禁用内置规则，避免中途失败把自己关在门外
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $rule) {
    $params = @{
        DisplayName = $ruleName
        Direction   = 'Inbound'
        Action      = 'Allow'
        Protocol    = 'TCP'
        LocalPort   = 3389
        Profile     = 'Any'
        Enabled     = 'True'
    }
    if ($RestrictFirewall) {
        $params.RemoteAddress = @('192.168.7.0/24', '2000::/3')
    }
    New-NetFirewallRule @params | Out-Null
    Write-Ok "已创建 $ruleName"
} else {
    $rule | Enable-NetFirewallRule
    if ($RestrictFirewall) {
        Set-NetFirewallRule -DisplayName $ruleName -RemoteAddress @('192.168.7.0/24', '2000::/3')
    }
    Write-Ok "$ruleName 已启用"
}

if ($RestrictFirewall) {
    if ($rdpFwGroup) {
        $rdpFwGroup | Disable-NetFirewallRule
        Write-Warn '已禁用内置 Remote Desktop 规则，仅保留收紧后的自定义规则'
    } else {
        Write-Warn '未找到内置 Remote Desktop 规则组，仅依赖自定义收紧规则'
    }
} elseif ($rdpFwGroup) {
    $rdpFwGroup | Enable-NetFirewallRule
    Write-Ok '已启用内置 Remote Desktop 规则'
} else {
    Write-Warn '未找到内置 Remote Desktop 规则组，依赖自定义规则'
}

# ---------- 9. 刷新最终状态 ----------
Start-Sleep -Seconds 1
$ipv4Info = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
$v6 = @(Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notmatch '^(fe80|::1)' -and
        $_.IPAddress -notmatch '^(fc|fd)'
    } |
    Select-Object -ExpandProperty IPAddress)
$rdpListener = Get-NetTCPConnection -State Listen -LocalPort 3389 -ErrorAction SilentlyContinue

$report = [ordered]@{
    WIN11_HOST    = $env:COMPUTERNAME
    WIN11_EDITION = $edition
    WIN11_ADAPTER = $adapter.Name
    WIN11_MAC     = $mac
    WIN11_IPV4    = $ipv4Info.IPAddress
    WIN11_PREFIX  = $ipv4Info.PrefixLength
    WIN11_GATEWAY = $(if ($currentGateway) { $currentGateway } else { $Gateway })
    WIN11_IPV6    = ($v6 -join ',')
    RDP_USER      = $RdpUser
    RDP_LISTEN    = $(if ($rdpListener) { 'yes' } else { 'no' })
}

Write-Host "`n================ 复制下面这段给控制节点 ================" -ForegroundColor Yellow
$report.GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value }
Write-Host '========================================================' -ForegroundColor Yellow

$reportPath = 'C:\rdp-win11-report.txt'
$report.GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value } |
    Set-Content -Path $reportPath -Encoding UTF8
Write-Host "`n报告已保存: $reportPath"

Write-Host @'

下一步：
  1) 优先在 iStoreOS 给上面 WIN11_MAC 保留原地址 192.168.7.129（hostid=129）。
     保留成功则 txhk / istoreos 的现有配置都不用改。
  2) 如果只能用新 IPv4：在控制节点更新
       txhk:     /etc/rdp-gateway.env 的 GW_TARGET
       istoreos: /etc/nftables.d/90-rdp4-dnat.nft 的目标地址
  3) 如果 MAC 也变了：更新 istoreos /etc/init.d/rdp6-agent 的 RDP6_WIN10_MAC。
  4) 重启 Win11，然后从 txhk 测 3389，再从 https://rdp.singll.net 测三条通路。
'@ -ForegroundColor Gray
