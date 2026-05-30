#!/usr/bin/env python3
"""Scan raw/ directory for URL-based duplicate articles."""
import os
import re
from collections import defaultdict

ROOT = '/mnt/NAS/data/knowledge/raw'

url_re = re.compile(r"^url:\s*[\"'](.+?)[\"']", re.MULTILINE)
title_re = re.compile(r"^title:\s*[\"'](.+?)[\"']", re.MULTILINE)

url_groups = defaultdict(list)

for dirpath, dirnames, filenames in os.walk(ROOT):
    for fn in sorted(filenames):
        if not fn.endswith('.md'):
            continue
        fp = os.path.join(dirpath, fn)
        try:
            size = os.path.getsize(fp)
        except OSError:
            continue
        try:
            with open(fp, 'r', errors='replace') as f:
                content = f.read(2000)
            url_m = url_re.search(content)
            title_m = title_re.search(content)
            url = url_m.group(1) if url_m else 'NO_URL'
            title = title_m.group(1) if title_m else fn
            url_groups[url].append({'path': fp, 'size': size, 'title': title})
        except Exception as e:
            print(f'Error reading {fp}: {e}')

dup_urls = {u: files for u, files in url_groups.items() if len(files) > 1}

print(f'Total unique URLs: {len(url_groups)}')
print(f'Total files in raw/: {sum(len(v) for v in url_groups.values())}')
print(f'URLs with duplicates: {len(dup_urls)}')
print(f'Total extra copies: {sum(len(v) - 1 for v in dup_urls.values())}')
print()

# Show all duplicate groups
sorted_dups = sorted(dup_urls.items(), key=lambda x: len(x[1]), reverse=True)
for i, (url, files) in enumerate(sorted_dups):
    print(f'--- URL: {url} ({len(files)} copies) ---')
    for f in files:
        tag = 'REAL' if f['size'] > 500 else 'EMPTY'
        print(f'  [{tag}] size={f["size"]:>6}  {f["path"]}')
    print()
