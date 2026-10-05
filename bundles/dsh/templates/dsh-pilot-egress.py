#!/usr/bin/env python3
"""Build an isolated Mihomo pilot configuration; does not install or start it."""
import ipaddress
import json
from urllib.parse import urlsplit


def build_config(target_ips, port, *, upstream_proxy=None):
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("invalid listener port")
    addresses = sorted({str(ipaddress.IPv4Address(value)) for value in target_ips})
    if not addresses or len(addresses) > 8:
        raise ValueError("one to eight pinned IPv4 targets required")
    for value in addresses:
        ip = ipaddress.ip_address(value)
        if not ip.is_global or ip.is_multicast:
            raise ValueError("target must be public unicast")
    proxies = []
    outbound = "DIRECT"
    if upstream_proxy is not None:
        parsed = urlsplit(upstream_proxy)
        if (parsed.scheme != "http" or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query
                or parsed.fragment or parsed.port is None):
            raise ValueError("anonymous numeric HTTP upstream required")
        upstream_ip = ipaddress.IPv4Address(parsed.hostname)
        if not upstream_ip.is_global or upstream_ip.is_multicast:
            raise ValueError("upstream must be public unicast")
        outbound = "pilot-bound-upstream"
        proxies = [{"name": outbound, "type": "http",
                    "server": str(upstream_ip), "port": parsed.port}]
    return {
        "port": port, "bind-address": "127.0.0.1", "allow-lan": False,
        "mode": "rule", "ipv6": False, "log-level": "warning",
        "external-controller": "", "profile": {"store-selected": False,
                                               "store-fake-ip": False},
        "sniffer": {"enable": False}, "dns": {"enable": False},
        "tun": {"enable": False}, "proxies": proxies, "proxy-groups": [],
        "rules": [
            f"AND,((NETWORK,TCP),(DST-PORT,443),(IP-CIDR,{ip}/32,no-resolve)),{outbound}"
            for ip in addresses
        ] + ["MATCH,REJECT"],
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-ip", action="append", required=True)
    parser.add_argument("--port", type=int, default=18899)
    parser.add_argument("--upstream-proxy", help="Explicit bound anonymous HTTP pool route")
    args = parser.parse_args()
    print(json.dumps(build_config(args.target_ip, args.port,
                                  upstream_proxy=args.upstream_proxy), indent=2))
