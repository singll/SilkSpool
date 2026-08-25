#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent tools.d 种子清单（幂等：只补缺失，不覆盖已有）
# 由 sec-suite-plugin-setup.sh 调用
# ==============================================================================
set -euo pipefail

DATA_DIR="${DSH_HOME:-{{BASE_DIR}}/data}"
TOOLS_DIR="$DATA_DIR/tools.d"
mkdir -p "$TOOLS_DIR"

log() { echo "[seed-manifests] $*"; }

# seed <name> <<'YAML' ... —— 已存在则跳过
seed() {
    local name="$1"
    if [ -f "$TOOLS_DIR/$name.yaml" ]; then
        log "$name 已存在，跳过"
        return
    fi
    cat > "$TOOLS_DIR/$name.yaml"
    log "$name 已写入"
}

# ---------- 资产收集 ----------
seed subfinder <<'EOF'
name: subfinder
binary: /usr/local/bin/subfinder
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [domains]
produces: [subdomains]
args_template: "-d {{target}} -silent -o {{outdir}}/subfinder.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed dnsx <<'EOF'
name: dnsx
binary: /usr/local/bin/dnsx
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [subdomains]
produces: [resolved_dns]
args_template: "-d {{target}} -silent -a -resp"
env_proxy: false
parser: lines
summarize: head
store: asset-graph
EOF

seed naabu <<'EOF'
name: naabu
binary: /usr/local/bin/naabu
stage: recon
risk: active
timeout: 600
target_param: target
requires: [resolved_dns]
produces: [open_ports]
args_template: "-host {{target}} -silent -top-ports {{ports|1000}}"
env_proxy: false
parser: lines
summarize: head
store: asset-graph
EOF

seed httpx <<'EOF'
name: httpx
binary: /usr/local/bin/httpx
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [subdomains]
produces: [live_hosts, fingerprints]
args_template: "-u {{target}} -json -silent -duc"
env_proxy: true
parser: jsonl
summarize: head
store: asset-graph
EOF

seed tlsx <<'EOF'
name: tlsx
binary: /usr/local/bin/tlsx
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [domains]
produces: [cert_domains]
args_template: "-u {{target}} -silent -json"
env_proxy: true
parser: jsonl
summarize: head
store: asset-graph
EOF

seed katana <<'EOF'
name: katana
binary: /usr/local/bin/katana
stage: recon
risk: passive
timeout: 600
target_param: target
requires: [live_hosts]
produces: [urls]
args_template: "-u {{target}} -silent -d {{depth|2}} -o {{outdir}}/katana.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed gau <<'EOF'
name: gau
binary: /usr/local/bin/gau
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [domains]
produces: [history_urls]
args_template: "{{target}} --o {{outdir}}/gau.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed waybackurls <<'EOF'
name: waybackurls
binary: /bin/sh
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [domains]
produces: [history_urls]
args_template: "-c 'echo {{target}} | /usr/local/bin/waybackurls > {{outdir}}/wayback.txt'"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed ffuf <<'EOF'
name: ffuf
binary: /usr/local/bin/ffuf
stage: recon
risk: active
timeout: 900
target_param: target
requires: [live_hosts]
produces: [endpoints]
args_template: "-u https://{{target}}/FUZZ -w {{wordlist|/usr/share/wordlists/dirb/common.txt}} -of csv -o {{outdir}}/ffuf.csv -t {{threads|20}}"
env_proxy: true
parser: csv
summarize: head
store: asset-graph
EOF

seed observer_ward <<'EOF'
name: observer_ward
binary: /usr/local/bin/observer_ward
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [live_hosts]
produces: [fingerprints]
args_template: "-t {{target}}"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

# ---------- 漏洞挖掘 ----------
seed nuclei <<'EOF'
name: nuclei
binary: /usr/local/bin/nuclei
stage: vuln
risk: active
timeout: 1800
target_param: target
requires: [live_hosts]
produces: [findings]
args_template: "-u {{target}} -jsonl -silent -rl {{rate|50}} -o {{outdir}}/nuclei.jsonl"
env_proxy: true
parser: jsonl
summarize: head
store: asset-graph
EOF

seed afrog <<'EOF'
name: afrog
binary: /usr/local/bin/afrog
stage: vuln
risk: active
timeout: 1800
target_param: target
requires: [live_hosts]
produces: [findings]
args_template: "-t {{target}} -o {{outdir}}/afrog.html"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed afrog-keyword <<'EOF'
name: afrog-keyword
binary: /usr/local/bin/afrog
stage: vuln
risk: active
timeout: 900
target_param: target
requires: [live_hosts]
produces: [findings]
args_template: "-t {{target}} -s {{keyword}} -o {{outdir}}/afrog.html"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed arjun <<'EOF'
name: arjun
binary: /usr/local/bin/arjun
stage: vuln
risk: active
timeout: 600
target_param: target
requires: [urls]
produces: [params]
args_template: "-u {{target}} --stable -q -oT {{outdir}}/arjun.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed graphql-cop <<'EOF'
name: graphql-cop
binary: /usr/local/bin/graphql-cop
stage: vuln
risk: active
timeout: 300
target_param: target
requires: [urls]
produces: [graphql_findings]
args_template: "-t {{target}} -o json"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed dalfox <<'EOF'
name: dalfox
binary: /usr/local/bin/dalfox
stage: vuln
risk: active
timeout: 600
target_param: target
requires: [urls]
produces: [xss_findings]
args_template: "url {{target}} --silence --no-color"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

seed crlfuzz <<'EOF'
name: crlfuzz
binary: /usr/local/bin/crlfuzz
stage: vuln
risk: active
timeout: 600
target_param: target
requires: [urls]
produces: [crlf_findings]
args_template: "-u {{target}} -s"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF

# ---------- 代码审计 / 供应链（本地路径，无 scope 校验） ----------
seed gitleaks <<'EOF'
name: gitleaks
binary: /usr/local/bin/gitleaks
stage: audit
risk: passive
timeout: 600
requires: [local_path]
produces: [secret_findings]
args_template: "dir {{path}} --report-path {{outdir}}/gitleaks.json --no-color"
env_proxy: false
parser: json
summarize: head
store: none
EOF

seed trufflehog <<'EOF'
name: trufflehog
binary: /usr/local/bin/trufflehog
stage: audit
risk: passive
timeout: 600
requires: [local_path]
produces: [secret_findings]
args_template: "filesystem {{path}} --json --no-update"
env_proxy: false
parser: jsonl
summarize: head
store: none
EOF

seed osv-scanner <<'EOF'
name: osv-scanner
binary: /usr/local/bin/osv-scanner
stage: audit
risk: passive
timeout: 600
requires: [local_path]
produces: [supplychain_findings]
args_template: "scan source {{path}} --format json --output {{outdir}}/osv.json"
env_proxy: false
parser: json
summarize: head
store: none
EOF

seed semgrep <<'EOF'
name: semgrep
binary: /usr/local/bin/semgrep
stage: audit
risk: passive
timeout: 900
requires: [local_path]
produces: [sast_findings]
args_template: "scan {{path}} --config {{rules|auto}} --json -o {{outdir}}/semgrep.json --quiet"
env_proxy: false
parser: json
summarize: head
store: none
EOF

seed codeql <<'EOF'
name: codeql
binary: /usr/local/bin/codeql
stage: audit
risk: passive
timeout: 1800
requires: [local_path]
produces: [dataflow_findings]
args_template: "{{subcmd|pack list}} {{args|}}"
env_proxy: false
parser: lines
summarize: head
store: none
EOF

seed sqlmap <<'EOF'
name: sqlmap
binary: /usr/bin/sqlmap
stage: vuln
risk: active
timeout: 1800
target_param: target
requires: [urls]
produces: [sqli_findings]
args_template: "-u {{target}} --batch --random-agent --level {{level|1}} --risk {{risk|1}} --output-dir {{outdir}}"
env_proxy: true
parser: lines
summarize: head
store: none
EOF

seed wafw00f <<'EOF'
name: wafw00f
binary: /usr/local/bin/wafw00f
stage: recon
risk: passive
timeout: 120
target_param: target
requires: [live_hosts]
produces: [waf_fingerprint]
args_template: "{{target}}"
env_proxy: true
parser: lines
summarize: head
store: none
EOF

# ---------- 自检测试 ----------
seed echo-test <<'EOF'
name: echo-test
binary: /bin/echo
stage: recon
risk: passive
timeout: 10
target_param: target
requires: []
produces: [selftest]
args_template: "selftest ok target={{target}} run={{run_id}}"
env_proxy: false
parser: lines
summarize: head
store: none
EOF

log "种子清单完成"
