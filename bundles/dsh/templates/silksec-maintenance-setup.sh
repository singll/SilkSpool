#!/usr/bin/env bash
# Install only maintenance units; never run DSH setup or restart the application.
set -euo pipefail
BASE_DIR="${DSH_BASE_DIR:-{{BASE_DIR}}}"
[ "$(id -u)" = 0 ] || { echo 'run through spool exec with sudo'; exit 1; }
command -v restic >/dev/null
[ -s /etc/silksec-maintenance.json ] || { echo 'configure /etc/silksec-maintenance.json first'; exit 1; }
install -d -o silkspool -g silkspool -m 0700 /var/lib/silksec-maintenance
for spec in 'backup|backup|*-*-* 00/6:17:00' 'check|check|Sun *-*-* 03:17:00' 'drill|drill|Sun *-*-* 04:17:00' 'prune|prune|Sun *-*-* 05:17:00' 'cleanup|cleanup --apply|*-*-* 05:30:00' 'health|status|*:0/15'; do
    IFS='|' read -r name action calendar <<< "$spec"
    unit="silksec-maintenance-$name"
    cat > "/etc/systemd/system/$unit.service" <<EOF
[Unit]
Description=SilkSecAgent maintenance $name
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
SuccessExitStatus=75
User=root
UMask=0077
ExecStart=/usr/bin/python3 $BASE_DIR/dsh-maintenance.py $action
TimeoutStartSec=2h
Nice=15
IOSchedulingClass=idle
CPUQuota=50%
MemoryMax=1G
NoNewPrivileges=true
PrivateTmp=true
EOF
    cat > "/etc/systemd/system/$unit.timer" <<EOF
[Unit]
Description=SilkSecAgent scheduled $name
[Timer]
OnCalendar=$calendar
Persistent=true
RandomizedDelaySec=120
[Install]
WantedBy=timers.target
EOF
done
# Stop the competing legacy backup/retention timers; the old retention deletes evidence by age.
systemctl disable --now silksec-backup.timer silksec-retention.timer
systemctl daemon-reload
for name in backup check drill prune cleanup health; do systemctl enable --now "silksec-maintenance-$name.timer"; done
