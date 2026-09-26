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
# 0.1.7 运行产物与 0.1.5 不同，补丁锚点/摘要必须重写；P2 只做版本解放，显式失败不静默跳过。
PENDING_017 = "0.1.7-rc.2 兼容补丁待 P4 按新运行产物重写（P2 仅完成版本解放）"


def configure_local_feedback(base):
    begin = "# silksec rc.2 local feedback policy begin"
    end = "# silksec rc.2 local feedback policy end"
    policy = [{"id": "session-telemetry-otel", "config": {"mode": "DISABLED"}},
              {"id": "session-log-deepseek", "config": {"enabled": False}},
              {"id": "plugin-package-inventory-deepseek", "config": {"enabled": False}}]
    results = {}
    for profile in ("web", "headless"):
        filename = base / "data/profiles" / profile / "cordis.patch.yml"
        original = filename.read_text()
        text = original
        if begin in text or end in text:
            if text.count(begin) != 1 or text.count(end) != 1:
                raise RuntimeError("本地反馈配置标记不完整或重复")
            before, rest = text.split(begin, 1)
            _, after = rest.split(end, 1)
            text = before.rstrip() + "\n" + after.lstrip("\n")
        result = text.rstrip() + "\n\n" + begin + "\n" + yaml.safe_dump(policy, sort_keys=False) + end + "\n"
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


def patch_billing_projection(base):
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
        if hashlib.sha256(pristine.encode()).hexdigest() != "87aac868af0181081ef0909f3a13547eab74ded4f27fcdca217ff615f56170c6" or pristine.count(old) != 1:
            raise RuntimeError("计费投影兼容补丁摘要未知")
        prepared.append((filename, pristine.replace(old, new), pristine.replace(old, new) != original))
    for filename, result, changed in prepared:
        if changed:
            replace_preserving_metadata(filename, result)
    return {"instances": len(prepared), "changed": sum(changed for _, _, changed in prepared),
            "sha256": hashlib.sha256(prepared[0][1].encode()).hexdigest()}


def patch_theme(base):
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
    version = json.loads((filename.parent.parent / "package.json").read_text())["version"]
    if version == "0.1.7-rc.2":
        raise RuntimeError("主题兼容补丁：" + PENDING_017)
    if version != "0.1.5-rc.2" or hashlib.sha256(pristine.encode()).hexdigest() != "be765095ffe627d870945c3367c8f98f5bdae2cda44568003e38e9bdb6c9a331":
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
        if version == "0.1.7-rc.2":
            raise RuntimeError("settings 兼容补丁：" + PENDING_017)
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


def configure(base):
    base = Path(base).resolve(strict=True)
    version = json.loads((base / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if version == "0.1.2-rc.1":
        return {"version": version, "changed": False, "required": False}
    if version == "0.1.7-rc.2":
        raise RuntimeError("RPC 兼容配置：" + PENDING_017)
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
    args = parser.parse_args()
    print(json.dumps(patch_settings(Path(args.base_dir).resolve(strict=True)) if args.settings_only else configure(args.base_dir)))
