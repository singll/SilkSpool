#!/usr/bin/env python3
"""0.1.7 Profile 落点/计费补丁的确定性契约；未知产物必须失败而不是静默跳过。"""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import yaml

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("compat", HERE / "dsh-runtime-compat.py")
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)

SETTINGS = {
    "llm-pi-ai": {"providers": {"bellkeeper": {"apiKeyEnv": "BELLKEEPER_LLM_API_KEY", "baseURL": "http://192.168.7.230:8090/api/llm/v1",
                                             "models": [{"id": "pool-secagent", "reasoningEfforts": {"off": "none"}}],
                                             "retryPolicy": {"mode": "normal", "maxRetries": 2}}}},
    "agent-default-model": {"provider": "bellkeeper", "model": "pool-secagent", "reasoningEffort": "max"},
    "agent-presets": {"default": "vuln-hunt"},
    "ui-onboarding": {"welcomeNoticeVersion": "2026-08-13.1"},
    "locale": {"preference": "zh"},
}
PRESET_BLOCK = ("# silksec-managed-agent-presets BEGIN\n"
                "# preset_version: 7\n"
                "- insert:\n"
                "  - id: preset-silksec-vuln-hunt\n"
                "    name: '@deepseek-ai/dsh-agent-preset'\n"
                "# silksec-managed-agent-presets END\n")
LEGACY_RPC = compat.BEGIN + "\n- id: connection\n  inject:\n  - webRuntime\n  - webServer\n" + compat.END + "\n"


class RuntimeCompatTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-compat-tests-")
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        for profile in ("web", "headless"):
            patch = self.base / "data/profiles" / profile / "cordis.patch.yml"
            patch.parent.mkdir(parents=True)
            patch.write_text("# fixture overlay\n" + (PRESET_BLOCK if profile == "web" else ""))
        (self.base / "data/settings.yaml").write_text(yaml.safe_dump(SETTINGS, allow_unicode=True, sort_keys=False))

    def result(self):
        return compat.apply_profile_settings(self.base)

    def test_profile_settings_land_in_both_profiles_and_keep_preset_block(self):
        result = self.result()
        self.assertEqual(result["profiles"]["web"]["written"], ["llm-pi-ai", "agent-default-model", "agent-preset-registry", "ui-settings-general", "locale"])
        self.assertEqual(result["profiles"]["headless"]["written"], ["llm-pi-ai", "agent-default-model"])
        web = (self.base / "data/profiles/web/cordis.patch.yml").read_text()
        headless = (self.base / "data/profiles/headless/cordis.patch.yml").read_text()
        self.assertIn("# silksec-managed-agent-presets BEGIN", web)
        self.assertIn("preset-silksec-vuln-hunt", web)
        self.assertIn(compat.PROFILE_BEGIN, web)
        self.assertIn(compat.PROFILE_BEGIN, headless)
        rows = compat.patch_row_ids(web)
        self.assertEqual(rows["agent-preset-registry"]["config"]["default"], "vuln-hunt")
        self.assertNotIn("agent-preset-registry", compat.patch_row_ids(headless))
        self.assertNotIn("locale", compat.patch_row_ids(headless))

    def test_existing_rows_are_not_overwritten_unless_forced(self):
        self.result()
        changed = dict(SETTINGS)
        changed["agent-default-model"] = {"provider": "bellkeeper", "model": "pool-secagent-lite"}
        kept = compat.apply_profile_settings(self.base, changed)
        self.assertEqual(kept["profiles"]["web"]["kept"], ["llm-pi-ai", "agent-default-model", "agent-preset-registry", "ui-settings-general", "locale"])
        rows = compat.patch_row_ids((self.base / "data/profiles/web/cordis.patch.yml").read_text())
        self.assertEqual(rows["agent-default-model"]["config"]["model"], "pool-secagent")
        compat.apply_profile_settings(self.base, changed, force=True)
        rows = compat.patch_row_ids((self.base / "data/profiles/web/cordis.patch.yml").read_text())
        self.assertEqual(rows["agent-default-model"]["config"]["model"], "pool-secagent-lite")
        self.assertIn("# silksec-managed-agent-presets BEGIN", (self.base / "data/profiles/web/cordis.patch.yml").read_text())

    def test_unknown_sections_and_unknown_presets_are_refused(self):
        (self.base / "data/settings.yaml").write_text(yaml.safe_dump({**SETTINGS, "mystery": {"x": 1}}, allow_unicode=True))
        with self.assertRaisesRegex(RuntimeError, "未分类配置节"):
            self.result()
        (self.base / "data/settings.yaml").write_text(yaml.safe_dump({**SETTINGS, "agent-presets": {"default": "user-role"}}, allow_unicode=True))
        with self.assertRaisesRegex(RuntimeError, "受管角色集合"):
            self.result()
        settings = dict(SETTINGS)
        settings["agent-preset-registry"] = {"default": "vuln-hunt"}
        del settings["agent-presets"]
        compat.apply_profile_settings(self.base, settings, force=True)
        rows = compat.patch_row_ids((self.base / "data/profiles/web/cordis.patch.yml").read_text())
        self.assertEqual(rows["agent-preset-registry"]["config"]["default"], "vuln-hunt")

    def test_settings_source_override_and_missing_source(self):
        custom = self.base / "override.yaml"
        custom.write_text(yaml.safe_dump(SETTINGS, allow_unicode=True))
        (self.base / "data/settings.yaml").unlink()
        with self.assertRaisesRegex(RuntimeError, "未找到 settings 源"):
            self.result()
        with mock.patch.dict(os.environ, {"DSH_SETTINGS_SOURCE": str(custom)}):
            result = self.result()
            self.assertEqual(result["source"], str(custom))
        # 迁移完成后（行已落盘）无源重跑是幂等 no-op，不得重新生成或清空。
        again = self.result()
        self.assertEqual(again["source"], "profile-patch-only")
        self.assertFalse(any(item["changed"] for item in again["profiles"].values()))

    def test_connection_inject_is_merged_and_idempotent(self):
        patch = self.base / "data/profiles/web/cordis.patch.yml"
        patch.write_text(patch.read_text() + LEGACY_RPC)
        first = compat.patch_connection_inject(self.base)
        self.assertFalse(first["changed"])
        self.assertEqual(first["connection_inject"], ["webRuntime", "webServer"])
        patch.write_text(patch.read_text().replace("- webServer\n", ""))
        second = compat.patch_connection_inject(self.base)
        self.assertTrue(second["changed"])
        self.assertEqual(second["connection_inject"], ["webRuntime", "webServer"])
        self.assertIn("fixture overlay", patch.read_text())
        self.assertFalse(compat.patch_connection_inject(self.base)["changed"])
        self.assertEqual(compat.patch_row_ids(patch.read_text())["connection"]["inject"], ["webRuntime", "webServer"])

    def test_connection_inject_keeps_other_rows_inject(self):
        patch = self.base / "data/profiles/web/cordis.patch.yml"
        patch.write_text(patch.read_text() + "- id: connection\n  inject:\n  - webRuntime\n  - customService\n")
        result = compat.patch_connection_inject(self.base)
        self.assertEqual(result["connection_inject"], ["webRuntime", "webServer", "customService"])

    def test_billing_patches_refuse_unknown_digests(self):
        for profile in ("web", "headless"):
            directory = self.base / "data/profiles" / profile / "node_modules/dsh-bill"
            (directory / "lib").mkdir(parents=True)
            (directory / "package.json").write_text('{"name": "dsh-bill", "version": "0.18.1"}')
            (directory / "lib/projection.js").write_text("  stateVersion: STATE_VERSION,\n  schema,\n  init,\n  apply,\n  view,\n")
            (directory / "lib/client.js").write_text("return el('div', { style: turnCostRow, title: title }, items)\n")
        with self.assertRaisesRegex(RuntimeError, "计费投影兼容补丁摘要未知"):
            compat.patch_billing_projection(self.base, "0.18.1")
        with self.assertRaisesRegex(RuntimeError, "计费客户端兼容补丁版本/摘要未知"):
            compat.patch_billing_0181(self.base)

    def test_model_failover_notice_is_logged_instead_of_appended(self):
        append = compat.FAILOVER_APPEND
        for profile in ("web", "headless"):
            plugin = self.base / "data/profiles" / profile / "node_modules/dsh-model-failover/lib/index.js"
            plugin.parent.mkdir(parents=True)
            plugin.write_text("function notifySwitch(ctx, agent, from, to, enabled) {\n    if (!enabled)\n        return;\n" + append + "\n")
        first = compat.patch_model_failover(self.base)
        self.assertTrue(first["changed"])
        self.assertEqual([row["changed"] for row in first["profiles"].values()], [True, True])
        for profile in ("web", "headless"):
            text = (self.base / "data/profiles" / profile / "node_modules/dsh-model-failover/lib/index.js").read_text()
            self.assertNotIn("agent.session.append", text)
            self.assertIn(compat.FAILOVER_NOTICE_MARKER, text)
        second = compat.patch_model_failover(self.base)
        self.assertFalse(second["changed"])
        # 锚点缺失必须失败而不是静默跳过
        broken = self.base / "data/profiles/web/node_modules/dsh-model-failover/lib/index.js"
        broken.write_text("function notifySwitch() {}\n")
        with self.assertRaisesRegex(RuntimeError, "通知锚点缺失"):
            compat.patch_model_failover(self.base)

    def test_theme_patch_refuses_unknown_instance(self):
        theme = self.base / "app/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-theme@0.1.7-rc.2/node_modules/@deepseek-ai/dsh-client-ui-theme/lib"
        theme.mkdir(parents=True)
        (theme / "client.js").write_text("fixture")
        (theme.parent / "package.json").write_text('{"name": "@deepseek-ai/dsh-client-ui-theme", "version": "0.1.7-rc.2"}')
        with self.assertRaisesRegex(RuntimeError, "主题兼容补丁版本/摘要未知"):
            compat.patch_theme(self.base, "0.1.7-rc.2")

    def settings_client_fixture(self, version, content):
        import hashlib
        relative = ("app/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-settings@%s"
                    "/node_modules/@deepseek-ai/dsh-client-ui-settings/lib" % version)
        lib = self.base / relative
        lib.mkdir(parents=True, exist_ok=True)
        (lib / "client.js").write_text(content)
        (lib.parent / "package.json").write_text('{"name": "@deepseek-ai/dsh-client-ui-settings", "version": "%s"}' % version)
        patched = content.replace('ctx.remote.$host.isLoopback ? "host" : "memory"', '"host"')
        return hashlib.sha256(content.encode()).hexdigest(), hashlib.sha256(patched.encode()).hexdigest(), patched

    def test_remote_settings_patch_covers_both_versions_and_is_idempotent(self):
        import shutil
        anchor = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n'
        for version, sha_attr, patched_attr in (("0.1.5-rc.2", "SETTINGS_SHA", "SETTINGS_PATCHED_SHA"),
                                                ("0.1.7-rc.2", "SETTINGS_017_SHA", "SETTINGS_017_PATCHED_SHA")):
            with self.subTest(version=version):
                shutil.rmtree(self.base / "app", ignore_errors=True)
                digest, patched_digest, patched = self.settings_client_fixture(version, anchor)
                with mock.patch.object(compat, sha_attr, digest), mock.patch.object(compat, patched_attr, patched_digest):
                    result = compat.patch_settings(self.base)
                    self.assertEqual(result["instances"], 1)
                    self.assertEqual(result["changed"], 1)
                    client = self.base / ("app/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-settings@%s"
                                          "/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js" % version)
                    self.assertEqual(client.read_text(), patched)
                    again = compat.patch_settings(self.base)
                    self.assertEqual(again["changed"], 0)

    def test_remote_settings_patch_refuses_unknown_digest(self):
        self.settings_client_fixture("0.1.7-rc.2", "fixture without anchor\n")
        with self.assertRaisesRegex(RuntimeError, "settings 补丁版本/摘要未知"):
            compat.patch_settings(self.base)


if __name__ == "__main__":
    unittest.main()
