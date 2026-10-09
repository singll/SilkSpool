#!/usr/bin/env python3
"""Generate the shared browser's forwarding-only xray webscan configuration."""
import argparse
import copy
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

import yaml


def build_config(source, upstream):
    url = urlsplit(upstream)
    if (url.scheme != "http" or url.hostname != "127.0.0.1"
            or not url.port or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("a loopback HTTP upstream is required; direct is forbidden")
    if not isinstance(source, dict) or source.get("version") != 4.0:
        raise ValueError("expected xray webscan config version 4.0")
    result = copy.deepcopy(source)
    plugins = result.get("plugins")
    if not isinstance(plugins, dict) or not plugins:
        raise ValueError("missing plugin configuration; refusing xray defaults")
    for name, settings in plugins.items():
        if not isinstance(settings, dict):
            raise ValueError(f"invalid plugin configuration: {name}")
        settings["enabled"] = False
    # webscan reads this configuration, not the unrelated module.xray.yaml.
    result["http"]["proxy"] = upstream
    result["http"]["proxy_rule"] = []
    result["http"]["fail_retries"] = 0
    result["http"]["max_qps"] = 5
    result["http"]["passive_mode"] = True
    result["mitm"]["upstream_proxy"] = upstream
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--upstream", default="http://127.0.0.1:8899")
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("output must preserve the original source")
    config = build_config(yaml.safe_load(args.source.read_text()), args.upstream)
    fd, temporary = tempfile.mkstemp(prefix=".xray-forward-", dir=args.output.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            yaml.safe_dump(config, stream, allow_unicode=True, sort_keys=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, args.output)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
