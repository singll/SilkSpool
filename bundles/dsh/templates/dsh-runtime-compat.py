#!/usr/bin/env python3
"""为已验证的 DSH 版本安装可重复的 Web 配置兼容项，不启动服务。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import yaml

BEGIN = "# silksec rc.2 RPC compatibility begin"
END = "# silksec rc.2 RPC compatibility end"
SETTINGS_SHA = "479002d654490d19cbc89ed4582198603eddf2a62e3d233bbd30748f1bc0d862"
SETTINGS_PATCHED_SHA = "9341c012e6959dd089844f122eed9ff525fb2cfb1969f233870dae0734dd2548"
# 0.1.7 起 settings 不再由 settings.yaml 热更新：模型/provider/默认模型/preset 默认
# 显式落到双 profile 的 cordis.patch.yml 受管区块，settings.yaml 只在首启被上游导入一次。
PROFILE_BEGIN = "# silksec-managed-profile-settings BEGIN"
PROFILE_END = "# silksec-managed-profile-settings END"
SETTINGS_SECTIONS = ("llm-pi-ai", "agent-default-model", "agent-presets", "agent-preset-registry", "ui-onboarding", "locale")
SETTINGS_ROW_IDS = ("llm-pi-ai", "agent-default-model", "agent-preset-registry", "ui-settings-general", "locale")
MANAGED_PRESET_IDS = ("recon", "vuln-hunt", "biz-logic", "code-audit", "intranet", "review", "orchestrator")
PROFILES = ("web", "headless")


class JsSafeLoader(yaml.SafeLoader):
    """profile patch 可含上游 !!js 表达式；读取只取 id/config，绝不执行表达式。"""


JsSafeLoader.add_constructor("tag:yaml.org,2002:js", lambda loader, node: loader.construct_scalar(node))


def replace_managed_block(text, begin, end, body):
    """标记区原地替换（首次则追加）；不搬动区块位置，重复运行字节稳定。"""
    block = begin + "\n" + body.rstrip("\n") + "\n" + end
    if begin in text or end in text:
        if text.count(begin) != 1 or text.count(end) != 1:
            raise RuntimeError("受管区块标记不完整或重复")
        head, rest = text.split(begin, 1)
        _, tail = rest.split(end, 1)
        return head + block + tail
    separator = "" if not text or text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
    return text + separator + block + "\n"


def configure_local_feedback(base):
    begin = "# silksec rc.2 local feedback policy begin"
    end = "# silksec rc.2 local feedback policy end"
    policy = [{"id": "session-telemetry-otel", "config": {"mode": "DISABLED"}},
              {"id": "session-log-deepseek", "config": {"enabled": False}},
              {"id": "plugin-package-inventory-deepseek", "config": {"enabled": False}}]
    results = {}
    for profile in PROFILES:
        filename = base / "data/profiles" / profile / "cordis.patch.yml"
        original = filename.read_text()
        result = replace_managed_block(original, begin, end, yaml.safe_dump(policy, sort_keys=False))
        if result != original:
            replace_preserving_metadata(filename, result)
        results[profile] = {"changed": result != original, "otel_mode": "DISABLED", "session_log": False, "inventory": False}
    return results


def patch_billing(base):
    # rc.2 的 turnTail 是首个 select 胜出的 chain。dsh-bill 0.13.1 对每个
    # closed turn 都占位，甚至成本为空时也遮住官方交付卡片。费用移到现有
    # additive assistant-actions list，并按最终 messageId 关联原 billTurns。
    changes = [
        ("var wanted = props.matched && props.matched.turn",
         "var wanted = props.useChat(function (snapshot) {\n"
         "        if (!snapshot) return undefined\n"
         "        for (var turn of snapshot.timeline.turns.values()) {\n"
         "          var tail = turn.data.get('turn-tail')\n"
         "          if (tail && tail.closing && tail.closing.finalNode.messageId === props.messageId) return turn.turn\n"
         "        }\n"
         "        return undefined\n"
         "      })"),
        ("slots.inject('conversation.chat.turnTail', function () {",
         "slots.inject('conversation.chat.assistant-actions', function () {"),
        ("name: 'conversation.chat.turnTail',\n"
         "            select: function (owner) {\n"
         "              var turn = owner && owner.turn\n"
         "              if (!turn || turn.status !== 'closed') return null\n"
         "              return { turn: turn.turn }\n"
         "            },",
         "name: 'conversation.chat.assistant-actions',\n            id: 'bill-turn-cost',\n            order: 20,"),
        ("return el('div', { style: turnCostRow, title: title }, items)",
         "return el('div', { style: turnCostRow, title: title, 'data-silksec-turn-cost': wanted }, items)"),
    ]
    files = {p.resolve(strict=True) for p in (base / "data/profiles").glob("*/node_modules/dsh-bill/lib/client.js")}
    if not files:
        raise RuntimeError("未找到已锁定的 dsh-bill 客户端")
    prepared = []
    for filename in sorted(files):
        if not filename.is_relative_to(base):
            raise RuntimeError("计费客户端解析到候选目录外")
        original = filename.read_text()
        pristine = original
        for old, new in reversed(changes):
            pristine = pristine.replace(new, old)
        version = json.loads((filename.parent.parent / "package.json").read_text())["version"]
        if version != "0.13.1" or hashlib.sha256(pristine.encode()).hexdigest() != "6d1dd42dc5c3e130ddf994dcb2cfeadc810d9f74666e460d927944813397aa90":
            raise RuntimeError("计费兼容补丁版本/摘要未知")
        result = pristine
        for old, new in changes:
            if result.count(old) != 1:
                raise RuntimeError("计费兼容补丁锚点不唯一")
            result = result.replace(old, new)
        prepared.append((filename, result, original != result))
    for filename, result, changed in prepared:
        if changed:
            replace_preserving_metadata(filename, result)
    return {"instances": len(prepared), "changed": sum(changed for _, _, changed in prepared),
            "sha256": hashlib.sha256(prepared[0][1].encode()).hexdigest(), "projection": patch_billing_projection(base)}


def patch_billing_0181(base):
    """dsh-bill 0.18.1：turnTail 已是 list 形态，原生支持 0.1.7；只补
    `data-silksec-turn-cost` 标记（浏览器验收选择器）与投影持久化校验。
    0.13.1 的 chain→assistant-actions 补丁整体不再需要。"""
    anchor = "return el('div', { style: turnCostRow, title: title }, items)"
    replacement = "return el('div', { style: turnCostRow, title: title, 'data-silksec-turn-cost': wanted }, items)"
    files = {p.resolve(strict=True) for p in (base / "data/profiles").glob("*/node_modules/dsh-bill/lib/client.js")}
    if not files:
        raise RuntimeError("未找到已锁定的 dsh-bill 客户端")
    prepared = []
    for filename in sorted(files):
        if not filename.is_relative_to(base):
            raise RuntimeError("计费客户端解析到候选目录外")
        original = filename.read_text()
        pristine = original.replace(replacement, anchor)
        version = json.loads((filename.parent.parent / "package.json").read_text())["version"]
        if version != "0.18.1" or pristine.count(anchor) != 1 \
                or hashlib.sha256(pristine.encode()).hexdigest() != "7fa8d7aa667830b03d30ba8e0a44ebdb682f9f5e1aa3ef215c89448187e05399":
            raise RuntimeError("计费客户端兼容补丁版本/摘要未知")
        prepared.append((filename, pristine.replace(anchor, replacement), original != pristine.replace(anchor, replacement)))
    for filename, result, changed in prepared:
        if changed:
            replace_preserving_metadata(filename, result)
    return {"instances": len(prepared), "changed": sum(changed for _, _, changed in prepared),
            "sha256": hashlib.sha256(prepared[0][1].encode()).hexdigest(),
            "projection": patch_billing_projection(base, "0.18.1")}


def patch_billing_projection(base, version="0.13.1"):
    old = "  stateVersion: STATE_VERSION,\n  schema,\n  init,\n  apply,\n  view,"
    new = """  stateVersion: STATE_VERSION + 1,
  stateSchema: {
    parse(value) {
      const route = v => v === null || typeof v === 'string'
      const tokens = v => v && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .every(key => Number.isFinite(v[key]) && v[key] >= 0)
      const count = v => Number.isSafeInteger(v) && v >= 0
      if (!value || !route(value.model) || !route(value.provider) || !tokens(value.totals)
        || !count(value.totals.calls) || !Array.isArray(value.turns)
        || value.turns.some(row => !tokens(row) || !count(row.calls) || !Number.isSafeInteger(row.turn)
          || !Number.isFinite(row.time) || !route(row.model) || !route(row.provider))
        || (value.last !== null && (!value.last || !tokens(value.last.tokens)
          || !Number.isSafeInteger(value.last.turn) || !Number.isSafeInteger(value.last.step)))) {
        throw new TypeError('dsh-bill: invalid persisted billTurns state')
      }
      return value
    },
  },
  init,
  apply,
  wire: { viewSchema: schema, view },"""
    files = {p.resolve(strict=True) for p in (base / "data/profiles").glob("*/node_modules/dsh-bill/lib/projection.js")}
    if not files:
        raise RuntimeError("未找到计费投影运行产物")
    prepared = []
    for filename in sorted(files):
        if not filename.is_relative_to(base):
            raise RuntimeError("计费投影解析到候选目录外")
        original = filename.read_text()
        pristine = original.replace(new, old)
        if version not in ("0.13.1", "0.18.1") or hashlib.sha256(pristine.encode()).hexdigest() != "87aac868af0181081ef0909f3a13547eab74ded4f27fcdca217ff615f56170c6" or pristine.count(old) != 1:
            raise RuntimeError("计费投影兼容补丁摘要未知")
        prepared.append((filename, pristine.replace(old, new), pristine.replace(old, new) != original))
    for filename, result, changed in prepared:
        if changed:
            replace_preserving_metadata(filename, result)
    return {"instances": len(prepared), "changed": sum(changed for _, _, changed in prepared),
            "sha256": hashlib.sha256(prepared[0][1].encode()).hexdigest()}


def patch_theme(base, version="0.1.5-rc.2"):
    # 上游 0.1.7 的 adopt() 仍会无条件用 host section 覆盖 preference：
    # 丝之歌主题切换后，任何通用设置保存都会把主题拽回内置浅色。0.1.7 锚点逐字保留，
    # 仅换实例摘要。
    old = "if (section === void 0) return;\n\t\t\t\tif (this.preference === section.preference && this.fontSize === section.fontSize) return;\n\t\t\t\tthis.preference = section.preference;"
    new = ("if (section === void 0) return;\n\t\t\t\t"
           "const hostPreferenceChanged = this.silksecLastHostPreference !== void 0 && this.silksecLastHostPreference !== section.preference;\n\t\t\t\t"
           "this.silksecLastHostPreference = section.preference;\n\t\t\t\t"
           "if (this.preference === section.preference && this.fontSize === section.fontSize) return;\n\t\t\t\t"
           "if (isThemePreference(this.preference) || hostPreferenceChanged) this.preference = section.preference;")
    files = sorted((base / "app/node_modules/.pnpm").glob("@deepseek-ai+dsh-client-ui-theme@*/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"))
    if len(files) != 1:
        raise RuntimeError("主题运行产物实例数未知")
    filename = files[0]
    original = filename.read_text()
    # 幂等判定也反向还原并验证整文件摘要，不能只检查锚点存在。
    pristine = original.replace(new, old)
    installed = json.loads((filename.parent.parent / "package.json").read_text())["version"]
    digests = {"0.1.5-rc.2": "be765095ffe627d870945c3367c8f98f5bdae2cda44568003e38e9bdb6c9a331",
               "0.1.7-rc.2": "de57d7864e2f3cbd91a33a1a993b2a092f80ff0be11a50c2f02113d420304d17"}
    if version != installed or version not in digests or hashlib.sha256(pristine.encode()).hexdigest() != digests[version]:
        raise RuntimeError("主题兼容补丁版本/摘要未知")
    result = pristine.replace(old, new)
    if result != original:
        replace_preserving_metadata(filename, result)
    return {"changed": result != original, "sha256": hashlib.sha256(result.encode()).hexdigest()}


def replace_preserving_metadata(filename, content):
    metadata = filename.stat()
    with tempfile.NamedTemporaryFile(mode="w", dir=filename.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.chmod(temporary, metadata.st_mode & 0o7777)
        if os.geteuid() == 0:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        temporary.replace(filename)
    finally:
        temporary.unlink(missing_ok=True)


def patch_settings(base):
    files = set()
    for root in (base / "app", base / "data/profiles/web", base / "data/profiles/headless"):
        direct = root / "node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js"
        if direct.is_file():
            files.add(direct.resolve(strict=True))
        for filename in (root / "node_modules/.pnpm").glob("@deepseek-ai+dsh-client-ui-settings@*/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js"):
            files.add(filename.resolve(strict=True))
    if not files:
        raise RuntimeError("未找到需要验收的 settings 客户端")
    prepared = []
    for filename in sorted(files):
        if not filename.is_relative_to(base):
            raise RuntimeError("settings 客户端解析到候选目录外")
        version = json.loads((filename.parent.parent / "package.json").read_text())["version"]
        original = filename.read_text()
        digest = hashlib.sha256(original.encode()).hexdigest()
        if version != "0.1.5-rc.2" or digest not in (SETTINGS_SHA, SETTINGS_PATCHED_SHA):
            raise RuntimeError("settings 补丁版本/摘要未知，拒绝继续：" + str(filename))
        result = original.replace('ctx.remote.$host.isLoopback ? "host" : "memory"', '"host"')
        if hashlib.sha256(result.encode()).hexdigest() != SETTINGS_PATCHED_SHA:
            raise RuntimeError("settings 补丁输出摘要不符")
        prepared.append((filename, result, digest != SETTINGS_PATCHED_SHA))
    for filename, result, changed in prepared:
        if changed:
            replace_preserving_metadata(filename, result)
    return {"instances": len(prepared), "changed": sum(changed for _, _, changed in prepared), "sha256": SETTINGS_PATCHED_SHA}


def patch_row_ids(text, loader=JsSafeLoader):
    rows = yaml.load(text, Loader=loader) or []
    if not isinstance(rows, list):
        raise RuntimeError("profile patch 必须是有序列表")
    found = {}

    def visit(entries):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if isinstance(entry.get("id"), str):
                found[entry["id"]] = entry
            if isinstance(entry.get("insert"), list):
                visit(entry["insert"])
            if entry.get("group") and isinstance(entry.get("config"), list):
                visit(entry["config"])
    visit(rows)
    return found


def load_settings_source(base):
    override = os.environ.get("DSH_SETTINGS_SOURCE")
    candidates = [Path(override)] if override else [
        base / "data/settings.yaml", base / "data/settings.yaml.imported", base / "settings.yaml"]
    for filename in candidates:
        if filename.is_file():
            return yaml.load(filename.read_text(), Loader=JsSafeLoader), filename
    raise RuntimeError("未找到 settings 源（data/settings.yaml / .imported / DSH_SETTINGS_SOURCE）；拒绝静默生成默认路由")


def profile_settings_rows(profile, settings):
    unknown = sorted(set(settings) - set(SETTINGS_SECTIONS))
    if unknown:
        raise RuntimeError("settings 含未分类配置节，拒绝静默丢弃：" + ",".join(unknown))
    llm = settings.get("llm-pi-ai")
    default = settings.get("agent-default-model")
    if not isinstance(llm, dict) or not isinstance(llm.get("providers"), dict) or not llm["providers"]:
        raise RuntimeError("settings 缺少 llm-pi-ai.providers")
    if not isinstance(default, dict) or not isinstance(default.get("provider"), str) or not isinstance(default.get("model"), str):
        raise RuntimeError("settings 缺少 agent-default-model.provider/model")
    if default["provider"] not in llm["providers"]:
        raise RuntimeError("agent-default-model.provider 不在 llm-pi-ai.providers 中：" + default["provider"])
    rows = [{"id": "llm-pi-ai", "config": llm}, {"id": "agent-default-model", "config": default}]
    if profile == "web":
        # 受管 preset 只写 web profile：headless 拒绝带 preset 的 Session（已定决策）。
        registry = settings.get("agent-preset-registry")
        if registry is None and isinstance(settings.get("agent-presets"), dict):
            registry = {"default": settings["agent-presets"].get("default")}
        if registry is not None:
            if not isinstance(registry, dict) or not isinstance(registry.get("default"), str) or not registry["default"]:
                raise RuntimeError("agent-preset-registry 缺少 default")
            if registry["default"] not in MANAGED_PRESET_IDS and registry["default"] != "standard":
                raise RuntimeError("默认 preset 不在受管角色集合中，拒绝静默回落：" + registry["default"])
            rows.append({"id": "agent-preset-registry", "config": registry})
        if isinstance(settings.get("ui-onboarding"), dict):
            rows.append({"id": "ui-settings-general", "config": settings["ui-onboarding"]})
        if isinstance(settings.get("locale"), dict):
            rows.append({"id": "locale", "config": settings["locale"]})
    return rows


def apply_profile_settings(base, settings=None, force=False, profiles=PROFILES):
    source = None
    if settings is None:
        try:
            settings, source = load_settings_source(base)
        except RuntimeError:
            # 迁移已完成（settings.yaml 已导入并改名）时允许无源重跑：仅当双 profile
            # 已存在模型落点行才放行，否则仍 fail-closed。
            patches = {profile: patch_row_ids((base / "data/profiles" / profile / "cordis.patch.yml").read_text())
                       for profile in profiles}
            if all({"llm-pi-ai", "agent-default-model"} <= set(rows) for rows in patches.values()):
                return {"source": "profile-patch-only", "profiles": {
                    profile: {"changed": False, "written": [], "kept": sorted(set(rows) & set(SETTINGS_ROW_IDS))}
                    for profile, rows in patches.items()}}
            raise
    result = {"source": str(source) if source is not None else "in-memory", "profiles": {}}
    for profile in profiles:
        filename = base / "data/profiles" / profile / "cordis.patch.yml"
        if not filename.is_file():
            raise RuntimeError("profile patch 不存在：" + str(filename))
        original = filename.read_text()
        present = patch_row_ids(original)
        wanted = profile_settings_rows(profile, settings)
        kept = [row["id"] for row in wanted if not force and row["id"] in present]
        written = [row for row in wanted if force or row["id"] not in present]
        if written:
            body = yaml.safe_dump(written, sort_keys=False, allow_unicode=True, width=120)
            text = replace_managed_block(original, PROFILE_BEGIN, PROFILE_END, body)
            if text != original:
                replace_preserving_metadata(filename, text)
        result["profiles"][profile] = {"changed": bool(written), "written": [row["id"] for row in written], "kept": kept}
    return result


def patch_connection_inject(base):
    """0.1.7 的 client-connection 只为自身 /api 路由注入 webServer；`rpc.handle`
    经服务影子上下文 `this.ctx` 访问 `owner.webServer`（dsh-bill 0.18.1 注释实测
    同因），web profile 行必须显式携带 webServer，否则所有自定义 RPC 频道静默失败。
    上游行 inject 为 [webRuntime]，这里合并写回 [webRuntime, webServer]。"""
    filename = base / "data/profiles/web/cordis.patch.yml"
    original = filename.read_text()
    rows = yaml.load(original, Loader=yaml.BaseLoader)
    if not isinstance(rows, list):
        raise RuntimeError("Web patch 必须是有序列表")
    dependencies = ["webRuntime", "webServer"]
    for row in rows:
        if isinstance(row, dict) and row.get("id") == "connection" and "inject" in row:
            if not isinstance(row["inject"], list) or not all(isinstance(x, str) for x in row["inject"]):
                raise RuntimeError("connection.inject 形状未知，拒绝覆盖")
            dependencies.extend(row["inject"])
    dependencies = list(dict.fromkeys(dependencies))
    body = yaml.safe_dump([{"id": "connection", "inject": dependencies}], sort_keys=False)
    result = replace_managed_block(original, BEGIN, END, body)
    changed = result != original
    if changed:
        replace_preserving_metadata(filename, result)
    return {"changed": changed, "connection_inject": dependencies}


def dump_config(base, profile):
    import subprocess
    node = "/usr/local/node/bin/node"
    if not Path(node).is_file():
        node = "node"
    binary = base / "app/node_modules/@deepseek-ai/dsh/lib/bin.js"
    environment = {"PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "CI": "true",
                   "DSH_HOME": str(base / "data"), "HOME": str(Path(os.environ.get("HOME", "/tmp"))), "LANG": "C.UTF-8"}
    result = subprocess.run([node, str(binary), "--profile", profile, "--dump-config"],
                            cwd=base / "app", capture_output=True, text=True, timeout=120, env=environment)
    if result.returncode != 0:
        raise RuntimeError(f"{profile} 配置组合失败（--dump-config exit={result.returncode}）：" + result.stderr.strip()[:2000])
    # BaseLoader：dump 里保留的 !!js 表达式不能被 safe_load 拒绝；与 patch 侧同口径比较字符串。
    rows = yaml.load(result.stdout, Loader=yaml.BaseLoader) or []
    return {row["id"]: row for row in flatten_rows(rows)}


def flatten_rows(value):
    if isinstance(value, list):
        for row in value:
            yield from flatten_rows(row)
    elif isinstance(value, dict):
        if "id" in value:
            yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from flatten_rows(child)


def config_contains(actual, expected):
    """expected 是 patch 里的显式字段；dump-config 可能补 schema 默认值，只核对存在字段。"""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and config_contains(actual[key], value)
                                                for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) \
            and all(config_contains(left, right) for left, right in zip(actual, expected))
    return str(actual) == str(expected)


def validate_composition(base):
    base = Path(base).resolve(strict=True)
    version = json.loads((base / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    report = {"version": version, "profiles": {}}
    for profile in PROFILES:
        report["profiles"][profile] = {"rows": len(dump_config(base, profile))}
    if version == "0.1.7-rc.2":
        for profile in PROFILES:
            rows = dump_config(base, profile)
            patch = patch_row_ids((base / "data/profiles" / profile / "cordis.patch.yml").read_text(), yaml.BaseLoader)
            expected = {row_id: row for row_id, row in patch.items() if row_id in SETTINGS_ROW_IDS}
            if not {"llm-pi-ai", "agent-default-model"} <= set(expected):
                raise RuntimeError(f"{profile} patch 缺少模型落点行")
            for row_id, row in expected.items():
                if row_id not in rows:
                    raise RuntimeError(f"{profile} --dump-config 缺少 row {row_id}")
                if not config_contains(rows[row_id].get("config", {}), row.get("config", {})):
                    raise RuntimeError(f"{profile} row {row_id} 生效值不等于 profile patch 落点")
            report["profiles"][profile]["verified_rows"] = sorted(expected)
        registry = patch_row_ids((base / "data/profiles/web/cordis.patch.yml").read_text()).get("agent-preset-registry")
        if registry is not None:
            default = registry.get("config", {}).get("default")
            web = dump_config(base, "web")
            if default and default != "standard" and ("preset-silksec-" + str(default)) not in web:
                raise RuntimeError("默认 preset 未注册，拒绝静默回落：" + str(default))
    return report


def configure(base):
    base = Path(base).resolve(strict=True)
    version = json.loads((base / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if version == "0.1.2-rc.1":
        return {"version": version, "changed": False, "required": False}
    if version == "0.1.7-rc.2":
        connection = patch_connection_inject(base)
        settings = apply_profile_settings(base)
        theme = patch_theme(base, version)
        billing = patch_billing_0181(base)
        feedback = configure_local_feedback(base)
        changed = connection["changed"] or theme["changed"] or billing["changed"] \
            or any(item["changed"] for item in settings["profiles"].values()) \
            or any(item["changed"] for item in feedback.values())
        return {"version": version, "changed": changed, "required": True, "connection_inject": connection,
                "profile_settings": settings, "theme_sync": theme, "billing_turn_cost": billing, "local_feedback": feedback}
    # 0.1.5 链的最终确认版本；以下路径逐字保留，不得被 0.1.7 适配改写。
    if version != "0.1.5-rc.2":
        raise RuntimeError("尚未验证此 DSH 版本的 RPC 兼容配置：" + version)
    patch = base / "data/profiles/web/cordis.patch.yml"
    original = patch.read_text()
    text = original
    if BEGIN in text or END in text:
        if text.count(BEGIN) != 1 or text.count(END) != 1:
            raise RuntimeError("RPC 兼容配置标记不完整或重复")
        before, rest = text.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        text = before.rstrip() + "\n" + after.lstrip("\n")
    rows = yaml.load(text, Loader=yaml.BaseLoader)
    if not isinstance(rows, list):
        raise RuntimeError("Web patch 必须是有序列表")
    # webRuntime 是 shipped web-app 的启动依赖。Cordis 的 service shadow 从
    # connection 提供者解析 webServer；只给消费方加 inject 不能修复 rc.2。
    dependencies = ["webRuntime", "webServer"]
    for row in rows:
        if isinstance(row, dict) and row.get("id") == "connection" and "inject" in row:
            if not isinstance(row["inject"], list) or not all(isinstance(x, str) for x in row["inject"]):
                raise RuntimeError("connection.inject 形状未知，拒绝覆盖")
            dependencies.extend(row["inject"])
    dependencies = list(dict.fromkeys(dependencies))
    result = text.rstrip() + "\n\n" + BEGIN + "\n" + yaml.safe_dump(
        [{"id": "connection", "inject": dependencies}], sort_keys=False) + END + "\n"
    changed = result != original
    if changed:
        replace_preserving_metadata(patch, result)
    return {"version": version, "changed": changed, "required": True, "connection_inject": dependencies,
            "settings_mirror": patch_settings(base), "theme_sync": patch_theme(base), "billing_turn_cost": patch_billing(base),
            "local_feedback": configure_local_feedback(base)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-dir", default=os.environ.get("SEC_BASE_DIR", "{{BASE_DIR}}"))
    parser.add_argument("--settings-only", action="store_true")
    parser.add_argument("--validate-composition", action="store_true")
    args = parser.parse_args()
    base = Path(args.base_dir).resolve(strict=True)
    if args.settings_only:
        version = json.loads((base / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
        print(json.dumps(apply_profile_settings(base) if version == "0.1.7-rc.2" else patch_settings(base)))
    elif args.validate_composition:
        print(json.dumps(validate_composition(base)))
    else:
        print(json.dumps(configure(base)))
