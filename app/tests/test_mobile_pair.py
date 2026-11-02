# SPDX-License-Identifier: Apache-2.0
"""手机扫码连接（app/mobile_pair.py）单测：配对令牌、局域网判定与二维码正文。

配对页是个免登录入口，令牌的寿命/刷新即失效与「主机头必须落在本机网段」是全部的门槛，
这两条都在这里验；HTTP 侧的门控在 test_studio_server.py 的真服务用例里验。
"""

import os
import sys
import time
import unittest
from pathlib import Path

APP_DIR = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, str(APP_DIR))

import mobile_pair as pair


class TokenTests(unittest.TestCase):
    def test_ensure_token_reuses_live_token_and_rotates_expired(self):
        cfg = {}
        now = 1_000_000.0
        token = pair.ensure_token(cfg, now)
        self.assertEqual(token, cfg["pair_token"])
        self.assertEqual(cfg["pair_expires_at"], now + pair.PAIR_TTL_SECONDS)
        self.assertTrue(cfg["pair_dirty"], "生成令牌要标 dirty，服务侧据此落盘")
        self.assertEqual(token, pair.ensure_token(cfg, now + 10), "寿命内的码不能换")
        rotated = pair.ensure_token(cfg, now + pair.PAIR_TTL_SECONDS + 1)
        self.assertNotEqual(token, rotated, "过期后要换新码")

    def test_rotate_token_is_immediate_and_invalidates_the_old_one(self):
        cfg = {}
        now = 1_000_000.0
        old = pair.ensure_token(cfg, now)
        new = pair.rotate_token(cfg, now + 5)
        self.assertNotEqual(old, new)
        self.assertFalse(pair.token_ok(cfg, old, now + 5), "旧码在刷新当场失效")
        self.assertTrue(pair.token_ok(cfg, new, now + 5))

    def test_token_ok_rejects_expired_and_mismatched(self):
        cfg = {}
        now = 1_000_000.0
        token = pair.ensure_token(cfg, now)
        self.assertTrue(pair.token_ok(cfg, token, now + pair.PAIR_TTL_SECONDS - 1))
        self.assertFalse(pair.token_ok(cfg, token, now + pair.PAIR_TTL_SECONDS), "到期那一刻就无效")
        self.assertFalse(pair.token_ok(cfg, token + "x", now))
        self.assertFalse(pair.token_ok(cfg, "", now))
        self.assertFalse(pair.token_ok({}, token, now), "没有令牌的配置一律无效")

    def test_seconds_left_counts_down_and_floors_at_zero(self):
        cfg = {}
        now = 1_000_000.0
        pair.ensure_token(cfg, now)
        self.assertEqual(pair.seconds_left(cfg, now), pair.PAIR_TTL_SECONDS)
        self.assertEqual(pair.seconds_left(cfg, now + 120), pair.PAIR_TTL_SECONDS - 120)
        self.assertEqual(pair.seconds_left(cfg, now + pair.PAIR_TTL_SECONDS + 9), 0)
        self.assertEqual(pair.seconds_left({}, now), 0, "空配置没有剩余寿命可言")

    def test_token_is_url_safe_base64url(self):
        token = pair.new_token()
        for ch in "+/=":
            self.assertNotIn(ch, token, "令牌要直接进查询串，不能带需要转义的字符")
        self.assertGreaterEqual(len(token), 20, "128 bit 的 base64url 至少 21 字符")


class LanHostTests(unittest.TestCase):
    def test_lan_prefixes_takes_the_first_two_ipv4_octets(self):
        self.assertEqual(pair.lan_prefixes(["192.168.0.165", "10.1.2.3"]), ["192.168.0", "10.1.2"])
        self.assertEqual(pair.lan_prefixes(["fe80::1", "not-an-ip", "1.2.3"]), [])
        self.assertEqual(pair.lan_prefixes([]), [])

    def test_lan_host_accepts_same_subnet_and_rejects_loopback_public(self):
        prefixes = pair.lan_prefixes(["192.168.0.165"])
        self.assertEqual(pair.lan_host("192.168.0.9:43130", prefixes), "192.168.0.9")
        self.assertEqual(pair.lan_host("192.168.0.9", prefixes), "192.168.0.9",
                         "旧版浏览器直连 ComfyUI 端口时主机头没有端口")
        for host in ("127.0.0.1:43130", "localhost:8188", "[::1]:43130", "104.20.1.7:43130", ""):
            self.assertEqual(pair.lan_host(host, prefixes), "", f"{host} 不算局域网请求")

    def test_lan_host_needs_a_matching_subnet(self):
        prefixes = pair.lan_prefixes(["192.168.0.165"])
        self.assertEqual(pair.lan_host("192.168.1.9:43130", prefixes), "",
                         "跨网段扫开也连不上，不能出码")
        self.assertEqual(pair.lan_host("192.168.01.9:43130", []), "", "空前缀不认任何地址")


class PayloadTests(unittest.TestCase):
    def test_pair_payload_builds_url_and_marks_host(self):
        cfg = {}
        now = 1_000_000.0
        info = pair.pair_payload(cfg, "192.168.0.165", 43130, now)
        self.assertTrue(info["success"])
        self.assertEqual(info["host"], "192.168.0.165")
        self.assertEqual(cfg["pair_host"], "192.168.0.165", "主机地址要留在配置里给下一次用")
        self.assertTrue(info["url"].startswith("http://192.168.0.165:43130/neo-studio/pair?token="))
        self.assertIn(info["token"], info["url"])
        self.assertEqual(info["seconds_left"], pair.PAIR_TTL_SECONDS)

    def test_pair_payload_reuses_persisted_host_for_loopback_page(self):
        cfg = {"pair_host": "192.168.0.165"}
        info = pair.pair_payload(cfg, "", 43130, time.time())
        self.assertEqual(info["host"], "192.168.0.165",
                         "桌面端窗口自己就是回环，出码要用上次落盘的主机地址")
        self.assertIn("192.168.0.165", info["url"])

    def test_pair_payload_without_any_host_ships_empty_url(self):
        info = pair.pair_payload({}, "", 43130, time.time())
        self.assertEqual(info["url"], "")
        self.assertEqual(info["token"], "")
        self.assertTrue(info["success"], "没有地址不是错误，页面自己给出「先连 WiFi」的提示")

    def test_pair_payload_reports_listen_closed(self):
        info = pair.pair_payload({}, "192.168.0.165", 43130, time.time(), lan_open=False)
        self.assertFalse(info["lan_open"], "监听没放开时要把不可用说出来，前端不摆只会失败的码")

    def test_pair_url_is_the_pairing_page_with_token(self):
        url = pair.pair_url("10.0.0.9", 8191, "AbCdEf")
        self.assertEqual(url, "http://10.0.0.9:8191/neo-studio/pair?token=AbCdEf")


class PersistenceMergeTests(unittest.TestCase):
    """配对状态单独落盘：只合入自己的三项，不抹掉设置页写的 root/python/port/listen。"""

    def setUp(self):
        import studio_app as sa
        self.sa = sa
        self.tmp = Path(APP_DIR) / "tmp" / "pair_config"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.saved = sa.CONFIG_FILE
        sa.CONFIG_FILE = self.tmp / "launcher_config.json"

    def tearDown(self):
        self.sa.CONFIG_FILE = self.saved
        for f in self.tmp.glob("*.json"):
            f.unlink(missing_ok=True)

    def test_persist_pair_state_merges_and_drops_dirty(self):
        sa = self.sa
        sa.write_config({"version": sa.CONFIG_VERSION, "root": "F:/ComfyUI", "python": "p",
                         "port": 8188, "listen": "192.168.0.165", "remote": ""})
        cfg = {"pair_token": "tok", "pair_expires_at": 123.0, "pair_host": "192.168.0.165",
               "pair_dirty": True}
        self.assertTrue(sa.persist_pair_state(cfg))
        disk = sa.load_config()
        self.assertEqual(disk["pair_token"], "tok")
        self.assertEqual(disk["pair_host"], "192.168.0.165")
        self.assertNotIn("pair_dirty", disk)
        self.assertNotIn("pair_dirty", cfg)
        self.assertEqual(disk["root"], "F:/ComfyUI", "设置页写的字段不能被这次落盘抹掉")
        self.assertEqual(disk["listen"], "192.168.0.165")

    def test_save_config_carries_pair_fields_from_launcher(self):
        sa = self.sa
        self.assertTrue(sa.save_config(Path("F:/ComfyUI"), "p", 8188,
                                       {"listen": "0.0.0.0", "pair_token": "tok2",
                                        "pair_expires_at": 55.0, "pair_host": "10.0.0.9"}))
        disk = sa.load_config()
        self.assertEqual(disk["pair_token"], "tok2", "「保存并重启」不能把手机连接刚生成的码洗掉")
        self.assertEqual(disk["pair_host"], "10.0.0.9")


if __name__ == "__main__":
    unittest.main()

