# SPDX-License-Identifier: Apache-2.0
"""技能云端订阅源（studio/skill_cloud.py）离线单测。

订阅源的契约全在文件层：配置缺字段就是未配置、清单只收形状对得上的行、TTL 看缓存文件的 mtime、
拉取失败回落上次成功的清单、装进 skills/custom/ 前先验指纹、内置同名拒装、用户改过的技能要点名才覆盖。
网络在 `_http_get` 这一层被桩掉：没有真请求、没有等待。全程只在根 conftest.py 钉住的临时数据根里
读写，用例只删自己创建的那几份。
"""

import asyncio
import hashlib
import importlib
import io
import json
import shutil
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

skill = importlib.import_module("studio.skill")
skill_cloud = importlib.import_module("studio.skill_cloud")
plugin_paths = importlib.import_module("studio.plugin_paths")

CFG_FILE = skill_cloud.OSS_PRESETS_FILE
INDEX_FILE = skill_cloud.INDEX_CACHE_FILE
STAMP_FILE = skill_cloud.STAMP_FILE
SHIPPED_CFG = plugin_paths.PLUGIN_DIR / "configs" / "oss_presets.json"
SKILL_INDEX_URL = "https://cdn.example/neo/skills/index.json"


def cfg_payload(**overrides) -> dict:
    base = {"enabled": True, "index_url": "https://cdn.example/neo/presets/index.json",
            "skill_index_url": SKILL_INDEX_URL, "sync_interval_hours": 24}
    base.update(overrides)
    return base


def write_cfg(payload) -> None:
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def index_payload(rows, updated_at="2026-11-18T00:00:00Z") -> bytes:
    return json.dumps({"version": 1, "updated_at": updated_at, "skills": rows}).encode("utf-8")


def skill_zip(files: dict) -> bytes:
    """一份技能包 zip：{相对路径: 正文}，与 tools\\skills_deploy_oss.py 打的包同形。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for rel, body in files.items():
            zf.writestr(rel, body)
    return buf.getvalue()


def sha256_of(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def manifest_row(sid: str, version: str, zip_bytes: bytes) -> dict:
    return {"id": sid, "name": sid, "version": version, "description": "",
            "zip": f"{sid}/{version}.zip", "sha256": sha256_of(zip_bytes)}


def fake_request(query=None, body=None):
    """假请求：这两条 handler 只读 query 与 JSON body。"""
    async def read_json():
        if body is None:
            raise json.JSONDecodeError("no body", "", 0)
        return body
    return types.SimpleNamespace(query=query or {}, json=read_json)


def run(handler, req):
    return asyncio.run(handler(req))

class _CloudCase(unittest.TestCase):
    """用例只在自己钉的配置与缓存里跑：配置、清单缓存、戳记都是订阅源自己的可删文件。"""

    def setUp(self):
        self.created_skills = []
        CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
        INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        for path in self.created_skills:
            shutil.rmtree(path, ignore_errors=True)
        for path in (CFG_FILE, INDEX_FILE, STAMP_FILE):
            if path.exists():
                path.unlink()

    def take_custom_dir(self, sid: str) -> Path:
        self.created_skills.append(Path(skill.SKILL_CUSTOM_DIR) / sid)
        return Path(skill.SKILL_CUSTOM_DIR) / sid

    def mock_http(self, responses: dict):
        """把网络桩成 url → (body, status)；calls 记下请求顺序，用例据此看「有没有再拉」。"""
        calls = []

        async def fake_get(url):
            calls.append(url)
            return responses.get(url, (None, 0))

        return fake_get, calls

    def with_http(self, responses: dict):
        fake, calls = self.mock_http(responses)
        saved = skill_cloud._http_get
        skill_cloud._http_get = fake
        self.addCleanup(setattr, skill_cloud, "_http_get", saved)
        return calls


class ConfigSourceTests(_CloudCase):
    def test_missing_skill_index_url_is_not_configured(self):
        payload = cfg_payload()
        payload.pop("skill_index_url")
        write_cfg(payload)
        self.assertFalse(skill_cloud.source_urls()["enabled"])
        resp = json.loads(run(skill_cloud.rs_prompts_skill_sources, fake_request()).text)
        self.assertFalse(resp["enabled"])
        self.assertEqual(resp["source"], "none")
        self.assertEqual(resp["skills"], [])
        self.assertIn("skill_index_url", resp["hint"])   # 未配置要讲清去哪儿配

    def test_cloud_switch_off_closes_the_skill_source_too(self):
        write_cfg(cfg_payload(enabled=False))
        self.assertFalse(skill_cloud.source_urls()["enabled"])

    def test_unreadable_config_file_reads_as_unconfigured(self):
        CFG_FILE.write_text("{ not json", encoding="utf-8")
        self.assertEqual(skill_cloud.presets_config(), {})
        resp = json.loads(run(skill_cloud.rs_prompts_skill_sources, fake_request()).text)
        self.assertFalse(resp["enabled"])   # 面板不报错，只是没有源

    def test_seed_add_keys_fills_only_the_missing_key(self):
        # 老数据根那份：用户自己填过 bucket，地址三行都在，就是没有这一版新加的 skill_index_url
        tmp_dir = Path(tempfile.mkdtemp(prefix="neo_seed_case_"))
        self.addCleanup(shutil.rmtree, tmp_dir, ignore_errors=True)
        user = tmp_dir / "oss_presets.json"
        user.write_text(json.dumps({
            "enabled": True, "index_url": "https://mine.example/presets/index.json",
            "base_url": "https://mine.example/presets/",
            "pose_index_url": "https://mine.example/pose/index.json",
            "sync_interval_hours": 6, "cache_dir": "D:/mine"}, ensure_ascii=False), encoding="utf-8")
        self.assertIn("configs/oss_presets.json", plugin_paths.SEED_ADD_KEYS)
        shipped = json.loads(SHIPPED_CFG.read_text(encoding="utf-8"))
        self.assertTrue(plugin_paths._fill_missing_keys(SHIPPED_CFG, user))
        filled = json.loads(user.read_text(encoding="utf-8"))
        self.assertEqual(filled["skill_index_url"], shipped["skill_index_url"])
        self.assertEqual(filled["index_url"], "https://mine.example/presets/index.json")
        self.assertEqual(filled["sync_interval_hours"], 6)
        self.assertEqual(filled["cache_dir"], "D:/mine")
        # 补过就没有第二次：出厂再变也不吃用户的键值
        self.assertFalse(plugin_paths._fill_missing_keys(SHIPPED_CFG, user))

    def test_shipped_preset_carries_the_skill_index_field(self):
        shipped = json.loads(SHIPPED_CFG.read_text(encoding="utf-8"))
        self.assertTrue(str(shipped.get("skill_index_url") or "").startswith("https://"))
        self.assertTrue(shipped["skill_index_url"].endswith("/neo/skills/index.json"))



class IndexFetchTests(_CloudCase):
    def setUp(self):
        super().setUp()
        write_cfg(cfg_payload())

    def test_rows_keep_shape_and_drop_bad_rows(self):
        good = manifest_row("story_board", "1.0.0", skill_zip({"story_board/skill.md": "x"}))
        bad_id = dict(good, id="bad id/../x")
        no_sha = {k: v for k, v in good.items() if k != "sha256"}
        escape = dict(good, zip="../../evil.zip")
        absolute = dict(good, id="other_skill", zip="https://cdn.example/other_skill/1.zip")
        index = json.loads(index_payload([good, bad_id, no_sha, escape, absolute]).decode("utf-8"))
        rows = skill_cloud.index_rows(index)
        self.assertEqual([r["id"] for r in rows], ["story_board", "other_skill"])
        self.assertEqual(rows[0]["zip_url"], "https://cdn.example/neo/skills/story_board/1.0.0.zip")
        self.assertEqual(rows[1]["zip_url"], "https://cdn.example/other_skill/1.zip")

    def test_fetch_caches_index_and_ttl_reads_the_cache_mtime(self):
        blob = index_payload([manifest_row("sb", "1.0.0", skill_zip({"skill.md": "x"}))])
        calls = self.with_http({SKILL_INDEX_URL: (blob, 200)})
        index, source, reason = asyncio.run(skill_cloud.load_index())
        self.assertEqual((source, reason), ("cloud", "ok"))
        self.assertTrue(INDEX_FILE.is_file())
        _, source2, _ = asyncio.run(skill_cloud.load_index())
        self.assertEqual(source2, "cache")
        self.assertEqual(calls, [SKILL_INDEX_URL])   # TTL 内不再拉
        _, source3, _ = asyncio.run(skill_cloud.load_index(force=True))
        self.assertEqual(source3, "cloud")           # 面板上那枚刷新是唯一一次强拉
        self.assertEqual(len(calls), 2)

    def test_fetch_failure_keeps_the_last_index_usable(self):
        blob = index_payload([manifest_row("sb", "1.0.0", skill_zip({"skill.md": "x"}))])
        self.with_http({SKILL_INDEX_URL: (blob, 200)})
        asyncio.run(skill_cloud.load_index())
        self.with_http({SKILL_INDEX_URL: (None, 0)})
        index, source, reason = asyncio.run(skill_cloud.load_index(force=True))
        self.assertEqual((source, reason), ("cache", "fetch_failed"))
        self.assertEqual([r["id"] for r in skill_cloud.index_rows(index)], ["sb"])
        catalog = skill_cloud.catalog(index, source, reason)
        self.assertEqual(catalog["reason"], "fetch_failed")
        self.assertIsNotNone(catalog["age_hours"])   # 最近成功时间要显示得出来

    def test_index_that_is_not_json_never_lands_in_cache(self):
        self.with_http({SKILL_INDEX_URL: (b"<html>nope", 200)})
        index, source, reason = asyncio.run(skill_cloud.load_index())
        self.assertIsNone(index)
        self.assertEqual((source, reason), ("none", "bad_index"))
        self.assertFalse(INDEX_FILE.exists())   # 坏清单不进缓存：下一次拉取照发


class InstallTests(_CloudCase):
    def setUp(self):
        super().setUp()
        write_cfg(cfg_payload())

    def put_index(self, rows) -> None:
        skill_cloud._write_atomic(INDEX_FILE, index_payload(rows))

    def test_install_lands_in_custom_and_records_stamp(self):
        zip_bytes = skill_zip({"sb/skill.md": "---\nname: sb\n---\n正文\n", "sb/refs.txt": "引用"})
        self.take_custom_dir("sb")
        self.put_index([manifest_row("sb", "1.0.0", zip_bytes)])
        row = skill_cloud.index_rows({"skills": [manifest_row("sb", "1.0.0", zip_bytes)]})[0]
        result = skill_cloud.install_row(row, zip_bytes, False)
        self.assertTrue(result["success"], result)
        d = Path(skill.SKILL_CUSTOM_DIR) / "sb"
        self.assertTrue((d / "skill.md").is_file())
        self.assertEqual((d / "refs.txt").read_text(encoding="utf-8"), "引用")
        stamp = skill_cloud._stamps()["sb"]
        self.assertEqual(stamp["version"], "1.0.0")
        self.assertEqual(stamp["dir_digest"], skill_cloud.dir_digest(str(d)))
        self.assertEqual(skill_cloud.skill_state(row, skill_cloud._stamps()), "installed")

    def test_fingerprint_mismatch_installs_nothing(self):
        zip_bytes = skill_zip({"sb/skill.md": "正文"})
        row = dict(manifest_row("sb", "1.0.0", skill_zip({"sb/skill.md": "另一份内容"})))
        result = skill_cloud.install_row(row, zip_bytes, False)
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], 409)
        self.assertEqual(result["code"], "fingerprint_mismatch")
        self.assertIn("指纹", result["message"])
        self.assertFalse((Path(skill.SKILL_CUSTOM_DIR) / "sb").exists())

    def test_preset_name_collision_refuses_install(self):
        preset = Path(skill.SKILL_PRESETS_DIR) / "sb"
        preset.mkdir(parents=True, exist_ok=True)
        (preset / "skill.md").write_text("---\nname: sb\n---\n预设\n", encoding="utf-8")
        self.created_skills.append(preset)
        result = skill_cloud.install_row(manifest_row("sb", "1.0.0", skill_zip({"skill.md": "x"})),
                                         skill_zip({"skill.md": "x"}), False)
        self.assertEqual(result["status"], 409)
        self.assertEqual(result["code"], "preset_conflict")
        self.assertIn("内置", result["message"])
        self.assertEqual((preset / "skill.md").read_text(encoding="utf-8"), "---\nname: sb\n---\n预设\n")
        self.assertFalse((Path(skill.SKILL_CUSTOM_DIR) / "sb").exists())



    def test_newer_cloud_version_shows_upgrade_not_installed(self):
        zip_v1 = skill_zip({"skill.md": "---\nname: sb\n---\nv1\n"})
        row_v1 = manifest_row("sb", "1.0.0", zip_v1)
        self.take_custom_dir("sb")
        skill_cloud.install_row(manifest_row("sb", "1.0.0", zip_v1), zip_v1, False)
        zip_v2 = skill_zip({"skill.md": "---\nname: sb\n---\nv2\n"})
        stamps = skill_cloud._stamps()
        self.assertEqual(skill_cloud.skill_state(manifest_row("sb", "1.0.0", zip_v1), stamps), "installed")
        self.assertEqual(skill_cloud.skill_state(manifest_row("sb", "1.1.0", zip_v2), stamps), "upgrade")

    def test_local_edit_requires_confirm_before_overwrite(self):
        zip_v1 = skill_zip({"skill.md": "---\nname: sb\n---\nv1\n"})
        self.take_custom_dir("sb")
        skill_cloud.install_row(manifest_row("sb", "1.0.0", zip_v1), zip_v1, False)
        d = Path(skill.SKILL_CUSTOM_DIR) / "sb"
        (d / "skill.md").write_text("---\nname: sb\n---\n我自己改的\n", encoding="utf-8")
        zip_v2 = skill_zip({"skill.md": "---\nname: sb\n---\nv2\n"})
        row_v2 = skill_cloud.index_rows({"skills": [manifest_row("sb", "1.1.0", zip_v2)]})[0]
        self.assertEqual(skill_cloud.skill_state(row_v2, skill_cloud._stamps()), "local_modified")
        refused = skill_cloud.install_row(row_v2, zip_v2, False)
        self.assertEqual(refused["code"], "local_modified")
        self.assertEqual((d / "skill.md").read_text(encoding="utf-8"), "---\nname: sb\n---\n我自己改的\n")
        self.assertTrue(skill_cloud.install_row(row_v2, zip_v2, True)["success"])
        self.assertEqual((d / "skill.md").read_text(encoding="utf-8"), "---\nname: sb\n---\nv2\n")
        self.assertEqual(skill_cloud.skill_state(row_v2, skill_cloud._stamps()), "installed")

    def test_skill_built_by_hand_is_never_touched_by_the_source(self):
        hand = Path(skill.SKILL_CUSTOM_DIR) / "sb"   # 用户自己建的同名技能：没有戳记可对照
        self.take_custom_dir("sb")
        hand.mkdir(parents=True, exist_ok=True)
        (hand / "skill.md").write_text("---\nname: sb\n---\n自建的\n", encoding="utf-8")
        zip_v1 = skill_zip({"skill.md": "---\nname: sb\n---\nv1\n"})
        row = manifest_row("sb", "1.0.0", zip_v1)
        self.assertEqual(skill_cloud.skill_state(row, skill_cloud._stamps()), "local_modified")
        self.assertEqual(skill_cloud.install_row(row, zip_v1, False)["code"], "local_modified")
        self.assertEqual((hand / "skill.md").read_text(encoding="utf-8"), "---\nname: sb\n---\n自建的\n")

    def test_deleted_cache_and_stamp_keep_the_reader_working(self):
        zip_v1 = skill_zip({"skill.md": "---\nname: sb\n---\nv1\n"})
        self.take_custom_dir("sb")
        self.put_index([manifest_row("sb", "1.0.0", zip_v1)])
        skill_cloud.install_row(manifest_row("sb", "1.0.0", zip_v1), zip_v1, False)
        STAMP_FILE.unlink()
        INDEX_FILE.unlink()
        catalog = skill_cloud.catalog({"skills": [manifest_row("sb", "1.0.0", zip_v1)]}, "none", "fetch_failed")
        self.assertEqual(catalog["skills"][0]["state"], "local_modified")   # 戳记没了只退化成「本地已修改」
        self.assertEqual(catalog["skills"][0]["installed_version"], "")
        self.assertEqual(catalog["skills"][0]["version"], "1.0.0")          # 清单行本身照旧展示
        listed = [s for s in skill.scan_skills() if s["id"] == "sb"]
        self.assertEqual([s["source"] for s in listed], ["custom"])         # 已装的技能照常读得到
        resp = run(skill_cloud.rs_prompts_install_skill_source, fake_request(body={"id": "sb"}))
        self.assertEqual(resp.status, 409)                                  # 清单缓存删了：先刷新，不动文件
        self.assertEqual(json.loads(resp.text)["code"], "index_missing")


class RouteTests(_CloudCase):
    def setUp(self):
        super().setUp()
        write_cfg(cfg_payload())

    def test_get_route_lists_rows_with_local_state(self):
        zip_sb = skill_zip({"skill.md": "x"})
        rows = [manifest_row("sb", "1.0.0", zip_sb), manifest_row("other", "2.0.0", skill_zip({"skill.md": "y"}))]
        skill_cloud._write_atomic(INDEX_FILE, index_payload(rows))
        resp = json.loads(run(skill_cloud.rs_prompts_skill_sources, fake_request()).text)
        self.assertTrue(resp["enabled"])
        self.assertEqual(resp["source"], "cache")
        self.assertEqual(resp["updated_at"], "2026-11-18T00:00:00Z")
        self.assertEqual([r["state"] for r in resp["skills"]], ["not_installed", "not_installed"])
        self.assertNotIn("zip_url", resp["skills"][0])   # 面板不直连 zip：安装由后端按 id 去取
        self.assertNotIn("sha256", resp["skills"][0])

    def test_post_route_installs_the_zip_behind_the_cached_row(self):
        zip_sb = skill_zip({"sb/skill.md": "---\nname: sb\n---\n云端正文\n"})
        skill_cloud._write_atomic(INDEX_FILE, index_payload([manifest_row("sb", "1.0.0", zip_sb)]))
        self.take_custom_dir("sb")
        row = skill_cloud.index_rows({"skills": [manifest_row("sb", "1.0.0", zip_sb)]})[0]
        self.with_http({row["zip_url"]: (zip_sb, 200)})
        resp = run(skill_cloud.rs_prompts_install_skill_source, fake_request(body={"id": "sb"}))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.text)["version"], "1.0.0")
        self.assertTrue((Path(skill.SKILL_CUSTOM_DIR) / "sb" / "skill.md").is_file())

    def test_post_route_rejects_a_body_that_is_not_json(self):
        resp = run(skill_cloud.rs_prompts_install_skill_source, fake_request(body=None))
        self.assertEqual(resp.status, 400)

    def test_post_route_refuses_an_id_the_index_does_not_carry(self):
        skill_cloud._write_atomic(INDEX_FILE, index_payload([manifest_row("sb", "1.0.0", skill_zip({"skill.md": "x"}))]))
        resp = run(skill_cloud.rs_prompts_install_skill_source, fake_request(body={"id": "not_in_index"}))
        self.assertEqual(resp.status, 404)
        self.assertEqual(json.loads(resp.text)["code"], "not_in_index")



