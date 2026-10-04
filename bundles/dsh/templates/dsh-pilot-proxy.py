#!/usr/bin/env python3
"""Select one anonymous pilot CONNECT route, read-only; never probe or rotate."""
import hashlib
import ipaddress
import json
import math
from pathlib import Path


def select_route(pool_dir):
    root = Path(pool_dir)
    raw = {name: (root / name).read_bytes() for name in ('pool.json', 'live.txt', 'blocklist.txt')}
    live = set(raw['live.txt'].decode().splitlines())
    blocked = {line.split('#', 1)[0].strip() for line in raw['blocklist.txt'].decode().splitlines()}
    choices = []
    for row in json.loads(raw['pool.json']):
        try:
            host = str(ipaddress.IPv4Address(row['host']))
            ip = ipaddress.ip_address(host)
            port = row['port']
            latency = row['timeout']
            if (not ip.is_global or ip.is_multicast or isinstance(port, bool)
                    or not isinstance(port, int) or not 1 <= port <= 65535
                    or isinstance(latency, bool) or not isinstance(latency, (int, float))
                    or not math.isfinite(latency) or latency <= 0):
                continue
            if row.get('protocol') != 'http' or row.get('grade') not in ('elite', 'anonymous'):
                continue
            if row.get('username') or row.get('password'):
                continue
            address = f'{host}:{port}'
            url = 'http://' + address
            if url not in live or address in blocked or url in blocked:
                continue
            choices.append((latency, url))
        except (KeyError, TypeError, ValueError):
            continue
    if not choices:
        raise ValueError('no eligible anonymous HTTP CONNECT route')
    # Bind once. Pool changes must reject continuation, never select a replacement.
    chosen = min(choices)[1]
    return {'proxy': chosen, 'proxy_sha256': hashlib.sha256(chosen.encode()).hexdigest(),
            'source_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in raw.items()},
            'eligible_routes': len(set(url for _, url in choices)),
            'fixed_route_only': True, 'exit_ip_proven': False,
            'tls_transparency_proven': False, 'retries': 0}
