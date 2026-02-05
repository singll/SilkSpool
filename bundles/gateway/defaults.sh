#!/bin/bash
# ==============================================================================
#  Gateway Bundle - Default Configuration Sources
#  描述: 定义配置文件的远程获取源，支持从官方仓库动态下载最新默认配置
#  用法: 由 runner.sh 的 init_defaults 函数调用
# ==============================================================================

declare -a CONFIG_DEFAULTS=(
    # Homepage 配置模板 (本地生成)
    "homepage/settings.yaml|LOCAL_TEMPLATE|template"
    "homepage/services.yaml|LOCAL_TEMPLATE|template"
)

# 配置文件说明
declare -A CONFIG_HINTS
CONFIG_HINTS["homepage/settings.yaml"]="Homepage basic settings - customize title, theme, etc."
CONFIG_HINTS["homepage/services.yaml"]="Homepage service list - add your service entries"

# ==============================================================================
#  特殊处理: 生成本地模板
# ==============================================================================
generate_local_template() {
    local target_path=$1
    local local_path=$2

    case "$local_path" in
        "homepage/settings.yaml")
            cat > "$target_path" << 'EOF'
---
# Homepage Settings File
# Reference: https://gethomepage.dev/configs/settings/

title: My Dashboard
favicon: https://example.com/favicon.ico

# Theme: dark, light
theme: dark
color: slate

# Layout settings
layout:
  - Services:
      style: row
      columns: 4
  - Infrastructure:
      style: row
      columns: 3

# Header style
headerStyle: boxed

# Hide version number
hideVersion: true
EOF
            return 0
            ;;

        "homepage/services.yaml")
            cat > "$target_path" << 'EOF'
---
# Homepage Services Configuration
# Reference: https://gethomepage.dev/configs/services/

- Services:
    - Example App:
        icon: mdi-application
        href: https://app.example.com
        description: Example application description
        # widget configuration example
        # widget:
        #   type: xxx
        #   url: http://xxx:8080

- Infrastructure:
    - Router:
        icon: mdi-router-wireless
        href: https://router.example.com
        description: Gateway management
EOF
            return 0
            ;;
    esac
    return 1
}
