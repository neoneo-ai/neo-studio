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


class LanAddressTests(unittest.TestCase):
    """出码地址的选卡（参考 dsh-desktop 的 preferredLanAddress / isPrivateAddress）：
    Hyper-WSL 虚拟网卡在主机名解析里排第一的机器上，扫开的码必须是手机连得到的那块。"""

    ADAPTERS = [("vEthernet (Default Switch)", "172.24.80.1"),
                ("以太网", "192.168.0.165"),
                ("WLAN", "169.254.92.11"),
                ("以太网 2", "10.1.2.3")]

    def setUp(self):
        self._adapters = pair._adapter_ips
        pair._adapter_ips = lambda: list(self.ADAPTERS)

    def tearDown(self):
        pair._adapter_ips = self._adapters

    def test_rank_orders_the_private_spaces(self):
        self.assertEqual(pair.lan_rank("192.168.0.165"), 0)
        self.assertEqual(pair.lan_rank("10.1.2.3"), 1)
        self.assertEqual(pair.lan_rank("172.24.80.1"), 2)
        self.assertIsNone(pair.lan_rank("169.254.92.11"), "链路本地地址：手机不会从这一面连进来")
        self.assertIsNone(pair.lan_rank("8.8.8.8"))
        self.assertIsNone(pair.lan_rank(""))

    def test_private_addrs_puts_the_virtual_nic_last(self):
        self.assertEqual(pair.private_addrs(), ["192.168.0.165", "10.1.2.3", "172.24.80.1"])
        self.assertEqual(pair.private_addrs(virtual=False), ["192.168.0.165", "10.1.2.3"])

    def test_pick_lan_host_prefers_the_listen_nic(self):
        # 用户在「启动设置 → 局域网监听」挑给手机连的那块，谁也不能替它
        self.assertEqual(pair.pick_lan_host("", "127.0.0.1,10.1.2.3"), "10.1.2.3")

    def test_pick_lan_host_keeps_a_real_persisted_host(self):
        self.assertEqual(pair.pick_lan_host("10.1.2.3", "127.0.0.1,0.0.0.0"), "10.1.2.3")

    def test_pick_lan_host_drops_a_persisted_virtual_host(self):
        # 现场：面板上的码是上次扫的 vEthernet 地址，手机扫开是一张连不上的码
        self.assertEqual(pair.pick_lan_host("172.24.80.1", "127.0.0.1,0.0.0.0"), "192.168.0.165")

    def test_payload_codes_the_picked_host(self):
        cfg = {}
        host = pair.pick_lan_host("", "127.0.0.1,0.0.0.0")
        out = pair.pair_payload(cfg, host, 8191, time.time(), lan_open=True)
        self.assertEqual(out["url"], f"http://{host}:8191{pair.PAIR_PATH}?token={out['token']}")
        self.assertEqual(cfg["pair_host"], "192.168.0.165")


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

class PairBridgeTests(unittest.TestCase):
    """窗口里 js_api 注入晚于页面脚本，桥与 HTTP 那条 /neo-studio/pair/info 同语义：出码用落盘的
    pair_host，端口是桌面端服务当前那个，令牌当场生成并落盘。页面钉在桌面端口上，桥是刷新晚到
    时的那条补路，两份读数必须一模一样。"""

    def setUp(self):
        import studio_app as sa
        self.sa = sa
        self.tmp = Path(APP_DIR) / "tmp" / "pair_bridge"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.saved = sa.CONFIG_FILE
        sa.CONFIG_FILE = self.tmp / "launcher_config.json"

    def tearDown(self):
        self.sa.CONFIG_FILE = self.saved
        for f in self.tmp.glob("*.json"):
            f.unlink(missing_ok=True)

    def test_pair_info_answers_the_panel_with_the_live_desktop_port(self):
        sa = self.sa
        desktop = sa.StudioDesktop(None, 8188, Path("root"), desktop_port=43130,
                                   launcher={"listen": "192.168.0.165", "pair_host": "192.168.0.165"})
        info = desktop.pair_info()
        self.assertTrue(info["lan_open"])
        self.assertEqual(info["port"], 43130, "出码端口是桌面端服务当前那个，不是 ComfyUI 的 8188")
        self.assertEqual(info["url"],
                         f"http://192.168.0.165:43130/neo-studio/pair?token={info['token']}")

    def test_pair_info_picks_the_listening_nic_when_no_host_is_persisted(self):
        """第一次用这功能时 pair_host 还没落盘过：出码地址取「局域网监听」选定的那块网卡，
        认出来的地址随后落盘，下次出码与手机扫到的必须是同一个。"""
        sa = self.sa
        desktop = sa.StudioDesktop(None, 8188, Path("root"), desktop_port=43130,
                                   launcher={"listen": "192.168.0.165"})
        info = desktop.pair_info()
        self.assertEqual(info["host"], "192.168.0.165")
        self.assertEqual(info["url"],
                         f"http://192.168.0.165:43130/neo-studio/pair?token={info['token']}")
        self.assertEqual(sa.load_config()["pair_host"], "192.168.0.165", "认出来的地址要落盘")


    def test_pair_info_persists_the_token_it_mints(self):
        sa = self.sa
        desktop = sa.StudioDesktop(None, 8188, Path("root"), desktop_port=43130,
                                   launcher={"listen": "192.168.0.165", "pair_host": "192.168.0.165"})
        info = desktop.pair_info()
        self.assertEqual(sa.load_config()["pair_token"], info["token"],
                         "桥这条路与服务那条一样，生成令牌要触发落盘")
        self.assertNotIn("pair_dirty", desktop.launcher)

    def test_pair_info_says_lan_closed_without_a_qr(self):
        desktop = self.sa.StudioDesktop(None, 8188, Path("root"), desktop_port=43130,
                                        launcher={"listen": ""})
        info = desktop.pair_info()
        self.assertFalse(info["lan_open"])
        self.assertEqual(info["url"], "", "监听没放开就不出码，面板直接说明去启动设置放开")



if __name__ == "__main__":
    unittest.main()

