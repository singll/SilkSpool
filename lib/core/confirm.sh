#!/bin/bash
# ==============================================================================
#  共享确认 helper
# ==============================================================================

ss_require_yes() {
    local action=${1:-"write operation"}

    if [ "${FLAG_YES:-0}" != "1" ]; then
        log_err "$action requires --yes"
        exit 1
    fi
}

ss_print_action_summary() {
    local title=$1
    local resource=$2
    local method=$3
    local args_json=${4:-"[]"}

    log_step "$title"
    echo "  Host:     ${NAS_HOST:-unknown}"
    echo "  URL:      ${TRUENAS_API_URL:-unknown}"
    echo "  Resource: ${resource:-unknown}"
    echo "  Method:   ${method:-unknown}"
    echo "  Args:     $args_json"
}

ss_require_write_confirmation() {
    local action=$1
    local resource=$2

    ss_require_yes "$action on $resource"
}

ss_require_destructive_confirmation() {
    local resource_name=$1
    local action=${2:-"destructive operation"}

    ss_require_yes "$action on $resource_name"

    if [ -n "${FLAG_CONFIRM:-}" ]; then
        if [ "$FLAG_CONFIRM" != "$resource_name" ]; then
            log_err "--confirm must exactly match: $resource_name"
            exit 1
        fi
        return 0
    fi

    if [ -t 0 ] && [ -t 1 ]; then
        echo ""
        log_warn "$action is destructive."
        printf 'Type the full resource name to continue: %s\n> ' "$resource_name"
        read -r typed_name
        if [ "$typed_name" != "$resource_name" ]; then
            log_err "Confirmation mismatch; aborting"
            exit 1
        fi
        return 0
    fi

    log_err "$action requires --confirm $resource_name when stdin is not interactive"
    exit 1
}
