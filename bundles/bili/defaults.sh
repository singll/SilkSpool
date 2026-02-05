#!/bin/bash
# ==============================================================================
#  Bili Bundle - Default Configuration Sources
#  描述: 定义配置文件的远程获取源，支持从官方仓库动态下载最新默认配置
#  用法: 由 runner.sh 的 init_defaults 函数调用
# ==============================================================================

# CONFIG_DEFAULTS 数组格式:
#   "本地相对路径|远程URL|处理方式"
#
# 处理方式 (可选):
#   - download: 直接下载 (默认)
#   - template: 下载后作为模板，用户需修改关键参数
#
# 注意:
#   1. URL 使用官方 GitHub raw 地址，确保获取最新版本
#   2. 使用 jsdelivr/ghproxy 等 CDN 加速国内访问
#   3. 本地路径相对于 hosts/<host>/ 目录

declare -a CONFIG_DEFAULTS=(
    # 弹幕机器人配置 (必须修改 RoomId)
    "robot/config/bilidanmaku-api.yaml|https://raw.githubusercontent.com/xbclub/BilibiliDanmuRobot/master/etc/bilidanmaku-api.yaml|template"
)

# 配置文件说明 (用于 init 时提示用户)
declare -A CONFIG_HINTS
CONFIG_HINTS["robot/config/bilidanmaku-api.yaml"]="[!] MUST MODIFY: RoomId (room number), RobotName (bot name)"

# 录播姬说明: 录播姬的配置是运行时通过 Web UI 创建的，不需要预置
# 参考: https://rec.danmuji.org/
