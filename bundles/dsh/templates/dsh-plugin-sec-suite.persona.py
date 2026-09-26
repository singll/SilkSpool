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
    # 0.1.5：@deepseek-ai/dsh-agent-presets 的 presets/standard 目录；
    # 0.1.7：@deepseek-ai/dsh-web-app 的 presets/standard.patch.yml（preset 行声明）。
    script = r"""
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const app = path.join(process.argv[1], 'app');
const dsh = fs.realpathSync(path.join(app, 'node_modules/@deepseek-ai/dsh/package.json'));
const fromDsh = createRequire(dsh), version = JSON.parse(fs.readFileSync(dsh)).version;
let standard, source, layout;
try {
  const pkg = fromDsh.resolve('@deepseek-ai/dsh-agent-presets/package.json');
  standard = path.join(path.dirname(pkg), 'presets/standard');
  source = '@deepseek-ai/dsh-agent-presets@' + JSON.parse(fs.readFileSync(pkg)).version;
  layout = 'directory';
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  if (/^0\.1\.[0-4](?:\D|$)/.test(version)) {
    standard = path.join(path.dirname(dsh), 'config/agent-presets/standard');
    source = '@deepseek-ai/dsh@' + version;
    layout = 'directory';
  } else {
    const web = fromDsh.resolve('@deepseek-ai/dsh-web-app/package.json');
    standard = path.join(path.dirname(web), 'presets/standard.patch.yml');
    source = '@deepseek-ai/dsh-web-app@' + JSON.parse(fs.readFileSync(web)).version;
    layout = 'patch';
  }
}
if (layout === 'directory' && !fs.statSync(path.join(standard, 'agent.cordis.yml')).isFile()) throw Error('standard preset missing');
if (layout === 'patch' && !fs.statSync(standard).isFile()) throw Error('standard preset patch missing');
process.stdout.write(JSON.stringify({standard, source, layout, dsh_version: version}));
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
MANAGED_ORDER = {"recon": 10, "vuln-hunt": 11, "biz-logic": 12, "code-audit": 13, "intranet": 14, "review": 15, "orchestrator": 16}
PRESET_ROW_NAME = "@deepseek-ai/dsh-agent-preset"
PRESET_BEGIN = "# silksec-managed-agent-presets BEGIN"
PRESET_END = "# silksec-managed-agent-presets END"
WEB_PATCH_RELATIVE = "profiles/web/cordis.patch.yml"
DEFAULT_SUFFIX = "Your working directory is {{cwd}}."


def preset_entries(value):
    """展平 patch 列表：insert 条目按顺序展开，其余条目原样保留。"""
    if not isinstance(value, list):
        raise ValueError("cordis.patch.yml 必须是 patch 条目数组")
    entries = []
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("patch 条目必须是映射")
        if "insert" in entry:
            inserted = entry["insert"]
            if not isinstance(inserted, list):
                raise ValueError("insert 必须是行数组")
            entries.extend(inserted)
        else:
            entries.append(entry)
    return entries


def read_presets(patch_file):
    """读取一个 cordis patch 文件声明的全部 @deepseek-ai/dsh-agent-preset 行。"""
    result = {}
    for entry in preset_entries(read_yaml(patch_file)):
        if not isinstance(entry, dict) or entry.get("name") != PRESET_ROW_NAME:
            continue
        config = entry.get("config")
        preset = config.get("id") if isinstance(config, dict) else None
        if not isinstance(preset, str) or not preset:
            raise ValueError("preset 行缺少非空 config.id")
        if preset in result:
            raise ValueError(f"重复的 preset id: {preset}")
        result[preset] = entry
    return result


def standard_definition(origin):
    """返回 shipped standard 组合行与 persona 结构（0.1.5 目录 / 0.1.7 patch）。"""
    if origin["layout"] == "directory":
        return read_yaml(Path(origin["standard"]) / "agent.cordis.yml")
    presets = read_presets(Path(origin["standard"]))
    row = presets.get("standard")
    if row is None:
        raise ValueError("shipped standard.patch.yml 缺少 standard preset 行")
    plugins = row["config"].get("plugins")
    if not isinstance(plugins, list) or not plugins:
        raise ValueError("shipped standard preset 缺少 plugins")
    return plugins


def build_preset_rows(rows, standard_parts, definitions):
    """按标准组合生成 7 个 preset 行：persona 文本替换，工具行原样追加。"""
    generated = []
    for definition in definitions:
        plugins = copy.deepcopy(rows)
        config = persona_row(plugins)["config"]
        prefix = definition["persona"]
        suffix = standard_parts["suffix"] or DEFAULT_SUFFIX
        if "{{cwd}}" not in suffix:
            suffix += "\n" + DEFAULT_SUFFIX
        config.pop("text", None)
        config.update(prefix=prefix, suffix=suffix, complete=False, includeRuntimeContext=True)
        plugins.extend(copy.deepcopy(TOOL_ROWS))
        persona_parts(plugins)  # 全部角色通过结构验证后才发布。
        generated.append({"id": "preset-silksec-" + definition["id"], "name": PRESET_ROW_NAME,
                          "config": {"id": definition["id"], "name": definition["name"],
                                     "description": definition["description"], "order": MANAGED_ORDER[definition["id"]],
                                     "plugins": plugins}})
    return generated


def replace_managed_block(text, block):
    """只替换标记区；标记缺失、重复或不完整时显式拒绝，其余内容原样保留。"""
    begins, ends = text.count(PRESET_BEGIN), text.count(PRESET_END)
    if begins != ends or begins > 1:
        raise ValueError("web patch 的 preset 标记重复或不完整；拒绝猜测重写范围")
    if begins == 0:
        separator = "" if not text or text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
        return text + separator + block
    begin, end = text.find(PRESET_BEGIN), text.find(PRESET_END)
    if end < begin:
        raise ValueError("web patch 的 preset 标记顺序错误")
    tail = text[end + len(PRESET_END):]
    tail = tail[1:] if tail.startswith("\n") else tail
    return text[:begin] + block + tail


def atomic_write_text(path, text):
    """同目录临时文件 + fsync + os.replace；失败保留旧文件。"""
    if path.is_symlink():
        raise ValueError(f"拒绝写入软链: {path}")
    meta = path.stat() if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if meta is not None:
            os.chmod(temporary, meta.st_mode & 0o7777)
            try:
                os.chown(temporary, meta.st_uid, meta.st_gid)
            except PermissionError:
                pass
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _seed_patch_presets(base_dir, data_dir, definitions, preset_version):
    if len(definitions) != 7 or {d["id"] for d in definitions} != MANAGED_IDS:
        raise ValueError("受管角色必须恰好包含七个已知 ID")
    origin = resolve_standard(base_dir)
    if origin["layout"] != "patch":
        raise ValueError("目标安装不是 0.1.7 preset 行布局")
    rows = standard_definition(origin)
    standard_parts = persona_parts(rows)
    patch_file = Path(data_dir) / WEB_PATCH_RELATIVE
    if not patch_file.parent.is_dir():
        raise ValueError(f"缺少 web profile 目录: {patch_file.parent}")
    before = patch_file.read_text(encoding="utf-8") if patch_file.exists() else \
        "# SilkSecAgent web profile patch（由 seed-presets.sh 管理受管 preset 区）\n"
    block = "\n".join([
        PRESET_BEGIN,
        f"# preset_version: {preset_version} (bundle patch 行机制；取代 persona_version=6 目录布局)",
        dump_yaml([{"insert": build_preset_rows(rows, standard_parts, definitions)}]).rstrip("\n"),
        PRESET_END, "",
    ])
    text = replace_managed_block(before, block)
    changed = text != before
    if changed:
        atomic_write_text(patch_file, text)
    managed = read_presets(patch_file)
    present = {preset for preset in MANAGED_IDS if preset in managed}
    if present != MANAGED_IDS:
        raise ValueError("发布后的 web patch 未包含全部受管 preset")
    return {"roles": 7, "changed_files": 1 if changed else 0, "preset_version": preset_version,
            "layout": "patch", "standard_source": origin["source"], "file": str(patch_file), "backup": None}


def exchange_directories(left, right):
    """Linux renameat2(RENAME_EXCHANGE)：读者始终看到完整目录，失败不触碰旧目录。"""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def seed_presets(base_dir, data_dir, definitions, version, preset_version=None):
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    layout = resolve_standard(base_dir)["layout"]
    if layout == "patch":
        return _seed_patch_presets(base_dir, data_dir, definitions, preset_version if preset_version is not None else version)
    with open(Path(data_dir) / ".agent-presets-seed.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _seed_directory_presets(base_dir, data_dir, definitions, version)


def _seed_directory_presets(base_dir, data_dir, definitions, version):
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
    read_preset = commands.add_parser("read-preset")
    read_preset.add_argument("--patch", required=True)
    read_preset.add_argument("--preset", required=True)
    seed = commands.add_parser("seed")
    seed.add_argument("--base-dir", required=True)
    seed.add_argument("--data-dir", required=True)
    seed.add_argument("--definitions", required=True)
    seed.add_argument("--version", required=True, type=int)
    seed.add_argument("--preset-version", type=int)
    args = parser.parse_args()
    if args.command == "read":
        result = persona_parts(read_yaml(args.file))
    elif args.command == "read-preset":
        presets = read_presets(Path(args.patch))
        row = presets.get(args.preset)
        if row is None:
            raise ValueError(f"未找到 preset: {args.preset}")
        result = persona_parts(row["config"]["plugins"])
    else:
        definitions = [json.loads(line) for line in Path(args.definitions).read_text(encoding="utf-8").splitlines() if line.strip()]
        result = seed_presets(Path(args.base_dir), Path(args.data_dir), definitions, args.version, args.preset_version)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 不把配置正文或上游子进程 stderr（可能含动态配置）打印到日志。
        print(f"[persona] 失败: {type(error).__name__}: {error}" if isinstance(error, ValueError)
              else f"[persona] 失败: {type(error).__name__}；检查输入文件和已安装 standard", file=sys.stderr)
        sys.exit(1)
