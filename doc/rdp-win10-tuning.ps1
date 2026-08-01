<#
  rdp-win10-tuning.ps1 —— 只修「本次 RDP 连接问题」的精简脚本（从 rdp-win10-hardening.ps1 分离）
  仅含四类：① TCP-only 传输 ② 服务端 KeepAlive/自动重连 ③ GPU 硬件 H.264/AVC444/优先物理GPU ④ ~60fps。

  【不含】低权账户创建 / 强制 NLA / 账户锁定 / 防火墙规则 —— 那些是「安全加固」（见
  rdp-win10-hardening.ps1），与本次「翻页快断连 + 画质/NVENC」问题无关，且纯远程误配有把自己
  关在 RDP 外面的风险，故全部剔除。本脚本改的都是「传输/编码」类键，零锁死风险，可安全一次性运行。

  背景（已实测）：断连根因是家宽 PPPoE 出口 MTU=1492 对 UDP 的 PMTUD 黑洞——fw4 只对 TCP 做 MSS
  钳制（→~1452 自动塞进 1492）、UDP 不受保护；RDP-UDP 大包带 DF 被丢 + ICMP 常被过滤 → 翻页大帧
  批量静默丢 → UDP 传输超时断连。非带宽（上行~70M 富余）非显卡（GTX1650 有 NVENC）。故强制
  TCP-only 根治断连，再让 GPU 做硬件 H.264 把富余带宽变成清晰度与帧率。

  用法（管理员 PowerShell）：  powershell -ExecutionPolicy Bypass -File .\rdp-win10-tuning.ps1
  运行后：★必须彻底断开 RDP 再重连（或重启一次）才生效★
#>

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Write-Host "== RDP 连接问题修复（TCP-only + 保活 + GPU 硬编 + 60fps）==" -ForegroundColor Cyan

$ts = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $ts)) { New-Item -Path $ts -Force | Out-Null }

# 1) 强制 RDP TCP-only —— 根治 PPPoE-1492 对 UDP 的黑洞断连（与网络层 istoreos v4 DNAT TCP-only 呼应）
Set-ItemProperty $ts -Name SelectTransport -Value 1 -Type DWord   # 0=TCP+UDP(默认) 1=仅TCP 2=任一
Write-Host "  [1/4] 传输强制 TCP-only（SelectTransport=1）✓"

# 2) 服务端 KeepAlive + 允许断线自动重连（短暂丢包不掉线、掉了能自动回来）
Set-ItemProperty $ts -Name KeepAliveEnable       -Value 1 -Type DWord
Set-ItemProperty $ts -Name KeepAliveInterval     -Value 1 -Type DWord   # 每 1 分钟发保活 PDU
Set-ItemProperty $ts -Name fDisableAutoReconnect -Value 0 -Type DWord   # 允许客户端自动重连
Write-Host "  [2/4] KeepAlive(1min) + 自动重连 ✓"

# 3) 用满 GTX 1650：GPU 硬件 H.264/AVC 编码 + 优先物理 GPU（NVENC 把富余带宽变清晰度）
Set-ItemProperty $ts -Name AVCHardwareEncodePreferred -Value 1 -Type DWord   # NVENC 硬编总开关（不设则恒软编）
Set-ItemProperty $ts -Name bEnumerateHWBeforeSW       -Value 1 -Type DWord   # 优先物理 GPU（直通关键）
# AVC444（全 4:4:4）默认关闭：实测 NVENC + AVC444 在高对比突变（选中文字反色等）时会间歇整帧品红/紫块花屏。
# 硬件 AVC420（上面 AVCHardwareEncodePreferred=1 即是）已够锐利且稳定；想要 4:4:4 请先升级 NVIDIA 驱动再改回 1。
Set-ItemProperty $ts -Name AVC444ModePreferred        -Value 0 -Type DWord   # 0=更稳的 AVC420(推荐)；1=全4:4:4(NVENC 下可能花屏)
Write-Host "  [3/4] GPU 硬件 H.264（AVC420，稳定）+ 优先物理 GPU ✓"

# 4) 解 RDP 30fps 上限 → ~60fps（注意是 WinStations 键，非上面的策略键）
$rdpTcp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
if (Test-Path $rdpTcp) { Set-ItemProperty $rdpTcp -Name DWMFRAMEINTERVAL -Value 15 -Type DWord }  # 15 → ~60fps
Write-Host "  [4/4] 帧率上限 → ~60fps（DWMFRAMEINTERVAL=15）✓"

# 回读确认
Write-Host "`n当前生效值：" -ForegroundColor Yellow
Get-ItemProperty $ts | Select-Object SelectTransport,KeepAliveEnable,KeepAliveInterval,`
  fDisableAutoReconnect,AVCHardwareEncodePreferred,bEnumerateHWBeforeSW,AVC444ModePreferred | Format-List
if (Test-Path $rdpTcp) {
  "DWMFRAMEINTERVAL = " + (Get-ItemProperty $rdpTcp -Name DWMFRAMEINTERVAL -EA SilentlyContinue).DWMFRAMEINTERVAL | Write-Host
}

Write-Host "`n== 完成 ==" -ForegroundColor Green
Write-Host "★ 现在彻底断开 RDP 再重连（或重启一次 Win10）才生效。" -ForegroundColor Green
Write-Host "  验证：任务管理器 → 性能 → GPU(GTX 1650) → 'Video Encode' 滚动时有波动 = NVENC 生效。"
Write-Host "  仍为 0 → 是 GPU 缺显示上下文（VDD 未设为主显 / 未插 dummy plug），见 RDP-GUARD.md v3.7.1。"
