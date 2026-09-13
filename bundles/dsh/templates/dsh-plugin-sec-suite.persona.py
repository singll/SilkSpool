#!/usr/bin/env python3
"""受管角色的结构化 YAML 读写；!!js 仅保留为数据，绝不执行。依赖系统 PyYAML。"""
import argparse
import copy
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import yaml


class JsExpression(str):
    pass


class Loader(yaml.SafeLoader):
    pass


class Dumper(yaml.SafeDumper):
    pass


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f"YAML 重复键: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


Loader.add_constructor("tag:yaml.org,2002:map", unique_mapping)
Loader.add_constructor("tag:yaml.org,2002:js", lambda loader, node: JsExpression(loader.construct_scalar(node)))
Dumper.add_representer(JsExpression, lambda dumper, value: dumper.represent_scalar("tag:yaml.org,2002:js", str(value)))


def read_yaml(filename):
    return yaml.load(Path(filename).read_text(encoding="utf-8"), Loader=Loader)


def dump_yaml(value):
    return yaml.dump(value, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=100)


def persona_row(rows):
    if not isinstance(rows, list):
        raise ValueError("agent.cordis.yml 必须是组合行数组")
    matches = [r for r in rows if isinstance(r, dict) and r.get("name") == "@deepseek-ai/dsh-persona"]
    if len(matches) != 1 or not isinstance(matches[0].get("config"), dict):
        raise ValueError("需要唯一的 persona 行及 config")
    return matches[0]


def persona_parts(rows):
    row = persona_row(rows)
    config = row["config"]
    if row.get("disabled") or config.get("complete", False) is not False or config.get("includeRuntimeContext", True) is not True:
        raise ValueError("受管角色必须启用并保留完整的授权、工具指导与运行上下文")
    if "prefix" in config:
        if "text" in config:
            raise ValueError("persona 同时含 text 和 prefix，格式有歧义")
        prefix, suffix, fmt = config["prefix"], config.get("suffix", ""), "prefix-suffix"
    elif "text" in config:
        if "suffix" in config:
            raise ValueError("legacy persona text 不能混用 suffix")
        prefix, suffix, fmt = config["text"], "", "text"
    else:
        raise ValueError("persona 缺少 prefix/text")
    if type(prefix) is not str or not prefix.strip() or type(suffix) is not str:
        raise ValueError("persona prefix/text 必须是非空字符串，suffix 必须是字符串")
    return {"prefix": prefix, "suffix": suffix, "format": fmt}


def resolve_standard(base_dir):
    # 从实际安装入口解析，不在 .pnpm 中 glob（多个旧版本共存会选错）。
    script = r"""
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const app = path.join(process.argv[1], 'app');
const dsh = fs.realpathSync(path.join(app, 'node_modules/@deepseek-ai/dsh/package.json'));
const fromDsh = createRequire(dsh), version = JSON.parse(fs.readFileSync(dsh)).version;
let standard, source;
try {
  const pkg = fromDsh.resolve('@deepseek-ai/dsh-agent-presets/package.json');
  standard = path.join(path.dirname(pkg), 'presets/standard');
  source = '@deepseek-ai/dsh-agent-presets@' + JSON.parse(fs.readFileSync(pkg)).version;
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !/^0\.1\.[0-4](?:\D|$)/.test(version)) throw e;
  standard = path.join(path.dirname(dsh), 'config/agent-presets/standard');
  source = '@deepseek-ai/dsh@' + version;
}
if (!fs.statSync(path.join(standard, 'agent.cordis.yml')).isFile()) throw Error('standard preset missing');
process.stdout.write(JSON.stringify({standard, source, dsh_version: version}));
"""
    return json.loads(subprocess.check_output(["node", "-e", script, str(base_dir)], text=True, stderr=subprocess.PIPE, timeout=15))


TOOL_ROWS = [
    {"id": "sec-suite-agent", "name": "@silksec/sec-suite", "config": {"sidecars": False}},
    {"id": "asset-graph-agent", "name": "@silksec/sec-suite/asset-graph"},
    {"id": "experience-agent", "name": "@silksec/sec-suite/experience"},
    {"id": "proxy-pool-agent", "name": "@silksec/dsh-proxy-pool"},
    {"id": "sec-domain-bus-agent", "name": "@silksec/sec-domain-bus", "config": {"sidecars": False}},
]
MANAGED_IDS = {"recon", "vuln-hunt", "biz-logic", "code-audit", "intranet", "review", "orchestrator"}


def exchange_directories(left, right):
    """Linux renameat2(RENAME_EXCHANGE)：读者始终看到完整目录，失败不触碰旧目录。"""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def seed_presets(base_dir, data_dir, definitions, version):
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    with open(Path(data_dir) / ".agent-presets-seed.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _seed_presets(base_dir, data_dir, definitions, version)


def _seed_presets(base_dir, data_dir, definitions, version):
    if len(definitions) != 7 or {d["id"] for d in definitions} != MANAGED_IDS:
        raise ValueError("受管角色必须恰好包含七个已知 ID")
    origin = resolve_standard(base_dir)
    standard = read_yaml(Path(origin["standard"]) / "agent.cordis.yml")
    standard_parts = persona_parts(standard)
    root = Path(data_dir) / ".agent-presets"
    root.parent.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise ValueError("preset 根目录为软链；必须先明确迁移目标")
    stage = Path(tempfile.mkdtemp(prefix=".agent-presets-stage-", dir=root.parent))
    backup = None
    preserve_stage = False
    try:
        if root.exists():
            shutil.copytree(root, stage, dirs_exist_ok=True, symlinks=True)
        changed = 0
        for definition in definitions:
            directory = stage / definition["id"]
            if directory.is_symlink():
                raise ValueError(f"受管角色目录不应为软链: {definition['id']}")
            directory.mkdir(exist_ok=True)
            rows = copy.deepcopy(standard)
            config = persona_row(rows)["config"]
            prefix = definition["persona"]
            suffix = standard_parts["suffix"] or "Your working directory is {{cwd}}."
            if "{{cwd}}" not in suffix:
                suffix += "\nYour working directory is {{cwd}}."
            if standard_parts["format"] == "prefix-suffix":
                config.pop("text", None)
                config.update(prefix=prefix, suffix=suffix, complete=False, includeRuntimeContext=True)
            else:
                config["text"] = prefix + "\n\n" + suffix
            rows.extend(copy.deepcopy(TOOL_ROWS))
            persona_parts(rows)  # 全部角色通过结构验证后才替换目录。
            meta_file = directory / "preset.yml"
            if meta_file.is_symlink():
                raise ValueError(f"受管角色 preset.yml 不应为软链: {definition['id']}")
            meta = read_yaml(meta_file) if meta_file.exists() else {}
            if not isinstance(meta, dict):
                raise ValueError(f"无效 preset.yml: {definition['id']}")
            meta.update(name=definition["name"], description=definition["description"],
                        order=meta.get("order", 10), persona_version=version,
                        persona_format=standard_parts["format"], standard_source=origin["source"])
            for filename, content in [(directory / "agent.cordis.yml", dump_yaml(rows)), (meta_file, dump_yaml(meta))]:
                if filename.is_symlink():
                    raise ValueError(f"受管角色文件不应为软链: {definition['id']}/{filename.name}")
                if not filename.exists() or filename.read_text(encoding="utf-8") != content:
                    filename.write_text(content, encoding="utf-8")
                    changed += 1
        if changed:
            # 交换目录一次发布七个角色；旧目录留下完整恢复副本，不依赖先删除/后重建。
            if root.exists():
                exchange_directories(stage, root)
                preserve_stage = True  # 此刻 stage 是完整旧目录，即使后续改名失败也不能删除。
                backup = stage.with_name(stage.name.replace("-stage-", "-before-", 1))
                try:
                    os.rename(stage, backup)
                except OSError:
                    backup = stage
            else:
                os.replace(stage, root)
        return {"roles": 7, "changed_files": changed, "persona_version": version,
                "format": standard_parts["format"], "standard_source": origin["source"],
                "backup": str(backup) if backup else None}
    finally:
        if stage.exists() and not preserve_stage:
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    read = commands.add_parser("read")
    read.add_argument("file")
    seed = commands.add_parser("seed")
    seed.add_argument("--base-dir", required=True)
    seed.add_argument("--data-dir", required=True)
    seed.add_argument("--definitions", required=True)
    seed.add_argument("--version", required=True, type=int)
    args = parser.parse_args()
    if args.command == "read":
        result = persona_parts(read_yaml(args.file))
    else:
        definitions = [json.loads(line) for line in Path(args.definitions).read_text(encoding="utf-8").splitlines() if line.strip()]
        result = seed_presets(Path(args.base_dir), Path(args.data_dir), definitions, args.version)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 不把配置正文或上游子进程 stderr（可能含动态配置）打印到日志。
        print(f"[persona] 失败: {type(error).__name__}: {error}" if isinstance(error, ValueError)
              else f"[persona] 失败: {type(error).__name__}；检查输入文件和已安装 standard", file=sys.stderr)
        sys.exit(1)
