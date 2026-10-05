#!/usr/bin/env python3
"""Build an isolated Mihomo pilot configuration; does not install or start it."""
import ipaddress
import json


def build_config(target_ips, port):
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("invalid listener port")
    addresses = sorted({str(ipaddress.IPv4Address(value)) for value in target_ips})
    if not addresses or len(addresses) > 8:
        raise ValueError("one to eight pinned IPv4 targets required")
    for value in addresses:
        ip = ipaddress.ip_address(value)
        if not ip.is_global or ip.is_multicast:
            raise ValueError("target must be public unicast")
    return {
        "port": port, "bind-address": "127.0.0.1", "allow-lan": False,
        "mode": "rule", "ipv6": False, "log-level": "warning",
        "external-controller": "", "profile": {"store-selected": False,
                                               "store-fake-ip": False},
        "sniffer": {"enable": False}, "dns": {"enable": False},
        "tun": {"enable": False}, "proxies": [], "proxy-groups": [],
        "rules": [
            f"AND,((NETWORK,TCP),(DST-PORT,443),(IP-CIDR,{ip}/32,no-resolve)),DIRECT"
            for ip in addresses
        ] + ["MATCH,REJECT"],
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-ip", action="append", required=True)
    parser.add_argument("--port", type=int, default=18899)
    args = parser.parse_args()
    print(json.dumps(build_config(args.target_ip, args.port), indent=2))
