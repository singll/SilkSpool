#!/usr/bin/env python3
"""python3 bundles/dsh/templates/dsh-plugin-sec-suite.persona.test.py（全部使用临时目录）。"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


persona = load_module("persona_tested", HERE / "dsh-plugin-sec-suite.persona.py")
audit_file = HERE / "data-seed/scripts/discipline-audit.py"
if not audit_file.is_file():
    audit_file = HERE / "scripts/pipeline/discipline-audit.py"
audit = load_module("discipline_tested", audit_file)


class PersonaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="silksec-seed-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.data = self.base / "data"
        self.root = self.data / ".agent-presets"
        self.root.mkdir(parents=True)
        self.defs = [dict(id=id, name=id, description="fixture", persona="授权角色 " + id + " {{model}}") for id in sorted(persona.MANAGED_IDS)]

    def install_standard(self, version="0.1.5-rc.2", config=None):
        dsh = self.base / "app/node_modules/@deepseek-ai/dsh"
        dsh.mkdir(parents=True, exist_ok=True)
        (dsh / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh", "version": version}))
        config = config or "{prefix: original, suffix: 'cwd={{cwd}}', complete: false, includeRuntimeContext: true}"
        if version == "0.1.5-rc.2":
            package = dsh.parent / "dsh-agent-presets"
            package.mkdir(exist_ok=True)
            (package / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh-agent-presets", "version": version}))
            standard = package / "presets/standard"
            standard.mkdir(parents=True, exist_ok=True)
            (standard / "agent.cordis.yml").write_text("- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config: " + config + "\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'\n")
            return standard
        if not version.startswith("0.1.7"):
            standard = dsh / "config/agent-presets/standard"
            standard.mkdir(parents=True, exist_ok=True)
            (standard / "agent.cordis.yml").write_text("- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config: {text: original}\n")
            return standard
        web = dsh.parent / "dsh-web-app"
        web.mkdir(exist_ok=True)
        (web / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh-web-app", "version": version}))
        preset = web / "presets"
        preset.mkdir(exist_ok=True)
        (preset / "standard.patch.yml").write_text(
            "# shipped standard preset\n- insert:\n    - id: preset-standard\n      name: '@deepseek-ai/dsh-agent-preset'\n"
            "      config:\n        id: standard\n        order: 1\n        plugins:\n"
            "          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n            config: " + config + "\n"
            "          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n"
            "            disabled: !!js process.platform === 'win32'\n")
        return preset / "standard.patch.yml"

    def seed(self, definitions=None, version=6, preset_version=7):
        return persona.seed_presets(self.base, self.data, self.defs if definitions is None else definitions, version, preset_version)

    def web_patch(self):
        return self.data / "profiles/web/cordis.patch.yml"

    def test_seven_roles_preserve_standard_guidance_tags_and_custom_files(self):
        self.install_standard()
        custom = self.root / "custom"
        custom.mkdir()
        (custom / "keep.yml").write_text("unchanged")
        (self.root / "recon").mkdir()
        (self.root / "recon/extra.txt").write_text("user attachment")
        result = self.seed()
        self.assertEqual(result["format"], "prefix-suffix")
        self.assertEqual(result["changed_files"], 14)
        self.assertTrue(Path(result["backup"]).is_dir())
        self.assertEqual((custom / "keep.yml").read_text(), "unchanged")
        self.assertEqual((self.root / "recon/extra.txt").read_text(), "user attachment")
        for id in persona.MANAGED_IDS:
            rows = persona.read_yaml(self.root / id / "agent.cordis.yml")
            self.assertEqual(persona.persona_parts(rows)["suffix"], "cwd={{cwd}}")
            self.assertIsInstance(rows[1]["disabled"], persona.JsExpression)
            self.assertEqual(sum(r.get("id") == "sec-domain-bus-agent" for r in rows), 1)
            self.assertFalse(rows[-1]["config"]["sidecars"])
            self.assertEqual(persona.read_yaml(self.root / id / "preset.yml")["persona_version"], 6)
        previous = (self.root / "recon/agent.cordis.yml").stat().st_mtime_ns
        self.assertEqual(self.seed()["changed_files"], 0)
        self.assertEqual((self.root / "recon/agent.cordis.yml").stat().st_mtime_ns, previous)

    def test_legacy_standard_uses_text_until_actual_runtime_upgrade(self):
        self.install_standard("0.1.2-rc.1")
        result = self.seed()
        self.assertEqual(result["format"], "text")
        rows = persona.read_yaml(self.root / "recon/agent.cordis.yml")
        self.assertNotIn("prefix", persona.persona_row(rows)["config"])
        self.assertIn("{{cwd}}", persona.persona_parts(rows)["prefix"])

    def test_bad_last_role_cannot_partially_replace_working_presets(self):
        self.install_standard()
        self.seed()
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        broken = copy.deepcopy(self.defs)
        broken[-1]["persona"] = ""
        with self.assertRaises(ValueError):
            self.seed(broken)
        after = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(list(self.data.glob(".agent-presets-stage-*")))

    def test_unknown_ids_and_managed_symlinks_are_rejected(self):
        self.install_standard()
        with self.assertRaises(ValueError):
            self.seed(self.defs[:-1])
        external = self.base / "external"
        external.mkdir()
        (external / "keep").write_text("safe")
        (self.root / "recon").symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.seed()
        self.assertTrue((self.root / "recon").is_symlink())
        self.assertEqual(list(external.iterdir()), [external / "keep"])

    def test_atomic_publication_failure_preserves_all_old_roles(self):
        self.install_standard()
        self.seed()
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        updated = copy.deepcopy(self.defs)
        updated[0]["persona"] += " updated"
        with patch.object(persona, "exchange_directories", side_effect=OSError("fixture publication failure")):
            with self.assertRaises(OSError):
                self.seed(updated)
        after = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(list(self.data.glob(".agent-presets-stage-*")))

    def test_broken_target_standard_does_not_fall_back_to_stale_package(self):
        standard = self.install_standard()
        (standard / "agent.cordis.yml").unlink()
        with self.assertRaises(Exception):
            self.seed()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_yaml_duplicate_fields_and_executable_prefix_are_rejected(self):
        file = self.base / "bad.yml"
        file.write_text("- name: '@deepseek-ai/dsh-persona'\n  config: {prefix: one, prefix: two}\n")
        with self.assertRaises(ValueError):
            persona.read_yaml(file)
        file.write_text("- name: '@deepseek-ai/dsh-persona'\n  config: {prefix: !!js 'process.exit(99)'}\n")
        with self.assertRaises(ValueError):
            persona.persona_parts(persona.read_yaml(file))

    # ---------------------------------------------------------------- 0.1.7 preset 行

    def test_patch_layout_generates_seven_preset_rows_with_persona_and_tools(self):
        self.install_standard("0.1.7-rc.2")
        (self.data / "profiles/web").mkdir(parents=True)
        (self.data / "profiles/web/cordis.patch.yml").write_text("# local overlay\n- id: connection\n  config: {cookieMaxAgeDays: 365}\n")
        result = self.seed()
        self.assertEqual(result["layout"], "patch")
        self.assertEqual(result["changed_files"], 1)
        self.assertEqual(result["preset_version"], 7)
        self.assertTrue(result["standard_source"].startswith("@deepseek-ai/dsh-web-app@0.1.7-rc.2"))
        text = self.web_patch().read_text()
        self.assertIn("# local overlay", text, "受管区之外的本地覆盖必须保留")
        self.assertIn(f"# preset_version: 7", text)
        presets = persona.read_presets(self.web_patch())
        self.assertEqual(set(presets) & persona.MANAGED_IDS, persona.MANAGED_IDS)
        for id in persona.MANAGED_IDS:
            row = presets[id]
            self.assertEqual(row["name"], "@deepseek-ai/dsh-agent-preset")
            self.assertEqual(row["config"]["id"], id)
            self.assertTrue(row["config"]["name"] and row["config"]["description"])
            plugins = row["config"]["plugins"]
            parts = persona.persona_parts(plugins)
            self.assertEqual(parts["format"], "prefix-suffix")
            self.assertIn("授权角色 " + id, parts["prefix"])
            self.assertNotIn("text", persona.persona_row(plugins)["config"])
            self.assertTrue(persona.persona_row(plugins)["config"]["complete"] is False)
            self.assertTrue(persona.persona_row(plugins)["config"]["includeRuntimeContext"] is True)
            self.assertEqual(parts["suffix"], "cwd={{cwd}}")
            self.assertIn("tool-bash", [r.get("id") for r in plugins], "必须保留 shipped standard 工具行")
            bus = [r for r in plugins if r.get("id") == "sec-domain-bus-agent"]
            self.assertEqual(len(bus), 1)
            self.assertFalse(bus[0]["config"]["sidecars"])
            for tool in ("sec-suite-agent", "asset-graph-agent", "experience-agent", "proxy-pool-agent"):
                self.assertEqual(sum(r.get("id") == tool for r in plugins), 1)
        before = self.web_patch().stat().st_mtime_ns
        self.assertEqual(self.seed()["changed_files"], 0)
        self.assertEqual(self.web_patch().stat().st_mtime_ns, before)

    def test_patch_layout_read_preset_and_cli_return_role_parts(self):
        self.install_standard("0.1.7-rc.2")
        (self.data / "profiles/web").mkdir(parents=True)
        self.seed()
        presets = persona.read_presets(self.web_patch())
        parts = persona.persona_parts(presets["vuln-hunt"]["config"]["plugins"])
        self.assertIn("授权角色 vuln-hunt", parts["prefix"])
        self.assertEqual(parts["suffix"], "cwd={{cwd}}")
        import subprocess, sys
        output = subprocess.check_output([sys.executable, str(HERE / "dsh-plugin-sec-suite.persona.py"), "read-preset",
                                          "--patch", str(self.web_patch()), "--preset", "review"], text=True)
        self.assertEqual(json.loads(output)["format"], "prefix-suffix")
        failed = subprocess.run([sys.executable, str(HERE / "dsh-plugin-sec-suite.persona.py"), "read-preset",
                                 "--patch", str(self.web_patch()), "--preset", "not-managed"], capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("未找到 preset", failed.stderr)

    def test_patch_layout_unknown_roles_and_broken_standard_are_rejected_without_writes(self):
        self.install_standard("0.1.7-rc.2")
        (self.data / "profiles/web").mkdir(parents=True)
        with self.assertRaises(ValueError):
            self.seed(self.defs[:-1])
        self.assertFalse(self.web_patch().exists())
        (self.data / "profiles/web").rmdir()
        standard = self.install_standard("0.1.7-rc.2")
        (standard).unlink()
        with self.assertRaises(Exception):
            self.seed()

    def test_patch_layout_atomic_failure_and_partial_markers_are_refused(self):
        self.install_standard("0.1.7-rc.2")
        (self.data / "profiles/web").mkdir(parents=True)
        self.seed()
        before = self.web_patch().read_bytes()
        updated = copy.deepcopy(self.defs)
        updated[0]["persona"] += " updated"
        with patch.object(persona.os, "replace", side_effect=OSError("fixture publication failure")):
            with self.assertRaises(OSError):
                self.seed(updated)
        self.assertEqual(self.web_patch().read_bytes(), before)
        for malformed in (before.decode() + persona.PRESET_BEGIN + "\n",
                          "# keep\n" + persona.PRESET_BEGIN + "\n",
                          "# keep\n" + persona.PRESET_END + "\n"):
            with self.assertRaises(ValueError):
                persona.replace_managed_block(malformed, "block")
        text = persona.replace_managed_block("# keep\n", persona.PRESET_BEGIN + "\nblock\n" + persona.PRESET_END + "\n")
        self.assertTrue(text.startswith("# keep\n"))
        self.assertEqual(text.count(persona.PRESET_BEGIN), 1)
        self.assertEqual(text.count(persona.PRESET_END), 1)

    def test_audit_covers_both_persona_fields_runtime_and_final_prompt(self):
        self.install_standard()
        self.seed()
        (self.base / "dsh-plugin-sec-suite.host-compat.js").write_bytes((HERE / "dsh-plugin-sec-suite.host-compat.js").read_bytes())
        final = self.base / "final.txt"
        final.write_text("实际组装 prompt 包含 finding_add 与 vuln_typo_probe")
        errors = []
        items = dict(audit.collect_prompt_texts(str(self.data), str(self.base), errors, [final]))
        self.assertEqual(errors, [])
        self.assertIn("{{cwd}}", items[".agent-presets/recon/agent.cordis.yml"])
        self.assertIn("vuln_register_signal", items["runtime/scheduled-prompt"])
        self.assertEqual(audit.scan_tool_refs(items["rendered/final.txt"], {"finding_add"}), {"vuln_typo_probe"})
        self.assertEqual(audit.scan_tool_refs("finding_add", set()), {"finding_add"})
        (self.root / "recon/agent.cordis.yml").write_text("- invalid: true\n")
        audit.collect_prompt_texts(str(self.data), str(self.base), errors)
        self.assertEqual(errors[0]["file"], ".agent-presets/recon/agent.cordis.yml")

    def test_audit_reads_preset_rows_for_017_and_reports_missing(self):
        self.install_standard("0.1.7-rc.2")
        (self.data / "profiles/web").mkdir(parents=True)
        self.seed()
        (self.base / "dsh-plugin-sec-suite.host-compat.js").write_bytes((HERE / "dsh-plugin-sec-suite.host-compat.js").read_bytes())
        errors = []
        items = dict(audit.collect_prompt_texts(str(self.data), str(self.base), errors))
        self.assertEqual(errors, [])
        self.assertIn("授权角色 vuln-hunt", items["profiles/web/cordis.patch.yml#vuln-hunt"])
        rows = persona.read_yaml(self.web_patch())
        for entry in rows:
            for row in entry.get("insert", []):
                if row.get("config", {}).get("id") == "review":
                    persona.persona_row(row["config"]["plugins"])["config"]["prefix"] = ""
        self.web_patch().write_text(persona.dump_yaml(rows))
        errors = []
        audit.collect_prompt_texts(str(self.data), str(self.base), errors)
        self.assertEqual(errors, [{"file": "profiles/web/cordis.patch.yml#review", "error": "ValueError"}])


if __name__ == "__main__":
    unittest.main()
