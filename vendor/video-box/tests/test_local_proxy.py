from __future__ import annotations

import configparser
import asyncio
import json
import tempfile
import threading
import time
import unittest
import sys
from types import MethodType
from types import ModuleType
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError
from urllib.request import Request
from urllib.parse import quote

import requests

import local_proxy.server as server_module
import local_proxy.stop_server as stop_server_module
from local_proxy.server import (
    LocalProxyHandler,
    ProxySettings,
    ResolveResult,
    build_bilibili_stream_info_from_play_data,
    choose_stream,
    enrich_douyin_stream_info,
    find_ffmpeg,
    get_ffmpeg_command,
    get_platform_resolver,
    resolve_platform_stream_async,
    rewrite_hls_playlist,
    save_settings,
    load_settings,
    should_close_transcode_response,
    start_ffmpeg_process,
    strip_flv_header,
)


_TEST_DATA_DIR = tempfile.TemporaryDirectory()


def setUpModule() -> None:
    server_module.configure_data_dir(_TEST_DATA_DIR.name)
    server_module.STATE.settings = server_module.load_settings()


def tearDownModule() -> None:
    _TEST_DATA_DIR.cleanup()


class StreamSelectionTests(unittest.TestCase):
    def test_defaults_do_not_include_a_room_or_cookie(self) -> None:
        settings = ProxySettings()

        self.assertEqual("", settings.room_url)
        self.assertEqual("", settings.cookie)

    def test_status_snapshot_identifies_the_relay_protocol(self) -> None:
        snapshot = server_module.ProxyState().snapshot()

        self.assertEqual("oba-video-relay", snapshot["service_id"])
        self.assertEqual(1, snapshot["protocol_version"])

    def test_data_dir_rehomes_persistent_proxy_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            previous = (
                server_module.PROJECT_ROOT,
                server_module.CONFIG_DIR,
                server_module.CONFIG_FILE,
                server_module.INSTANCE_LOCK_FILE,
                server_module.INSTANCE_INFO_FILE,
            )
            try:
                server_module.configure_data_dir(directory)
                self.assertEqual(Path(directory).resolve() / "config", server_module.CONFIG_DIR)
                self.assertEqual(server_module.CONFIG_DIR / "local_proxy.ini", server_module.CONFIG_FILE)
                self.assertEqual(server_module.CONFIG_DIR / "instance.json", server_module.INSTANCE_INFO_FILE)
            finally:
                (
                    server_module.PROJECT_ROOT,
                    server_module.CONFIG_DIR,
                    server_module.CONFIG_FILE,
                    server_module.INSTANCE_LOCK_FILE,
                    server_module.INSTANCE_INFO_FILE,
                ) = previous

    def test_default_settings_path_follows_configured_data_dir(self) -> None:
        previous = (
            server_module.PROJECT_ROOT,
            server_module.CONFIG_DIR,
            server_module.CONFIG_FILE,
            server_module.INSTANCE_LOCK_FILE,
            server_module.INSTANCE_INFO_FILE,
        )
        with tempfile.TemporaryDirectory() as original_dir, tempfile.TemporaryDirectory() as data_dir:
            try:
                server_module.configure_data_dir(original_dir)
                original_config = server_module.CONFIG_FILE
                server_module.configure_data_dir(data_dir)
                settings = ProxySettings(room_url="https://live.example.test/room", cookie="cookie")

                save_settings(settings)

                self.assertTrue(server_module.CONFIG_FILE.exists())
                self.assertFalse(original_config.exists())
                self.assertEqual(settings.room_url, load_settings().room_url)
                self.assertEqual(settings.cookie, load_settings().cookie)
            finally:
                (
                    server_module.PROJECT_ROOT,
                    server_module.CONFIG_DIR,
                    server_module.CONFIG_FILE,
                    server_module.INSTANCE_LOCK_FILE,
                    server_module.INSTANCE_INFO_FILE,
                ) = previous

    def test_runtime_verification_reports_the_bundled_node_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            original_loader = server_module.load_recorder_modules
            original_output = server_module.subprocess.check_output
            original_root = server_module.PROJECT_ROOT
            original_src = sys.modules.get("src")
            try:
                script_directory = Path(directory) / "javascript"
                script_directory.mkdir()
                (script_directory / "x-bogus.js").write_text("function sign(){ return 'ok'; }", encoding="utf-8")
                async def get_xbogus(*args: object) -> str:
                    return "signature"
                fake_src = ModuleType("src")
                fake_src.JS_SCRIPT_PATH = script_directory
                fake_src.room = type("Room", (), {"get_xbogus": get_xbogus})
                sys.modules["src"] = fake_src
                server_module.configure_data_dir(directory)
                server_module.load_recorder_modules = lambda: (object(), object(), object())
                server_module.subprocess.check_output = lambda *args, **kwargs: "v24.19.0\n"
                self.assertEqual(0, server_module.verify_runtime())
                report = json.loads((Path(directory) / "runtime-check.json").read_text(encoding="utf-8"))
                self.assertEqual({"ok": True, "nodeVersion": "v24.19.0"}, report)
            finally:
                server_module.load_recorder_modules = original_loader
                server_module.subprocess.check_output = original_output
                server_module.configure_data_dir(str(original_root))
                if original_src is None:
                    del sys.modules["src"]
                else:
                    sys.modules["src"] = original_src
    def test_auto_prefers_flv_when_codec_is_not_hevc(self) -> None:
        result = choose_stream(
            {
                "is_live": True,
                "flv_url": "https://example.test/live.flv?codec=h264",
                "m3u8_url": "https://example.test/live.m3u8",
            },
            "auto",
        )

        self.assertTrue(result.ok)
        self.assertEqual("flv", result.selected_type)
        self.assertEqual("https://example.test/live.flv?codec=h264", result.selected_url)
        self.assertFalse(result.hevc)

    def test_auto_falls_back_to_hls_for_hevc_flv(self) -> None:
        result = choose_stream(
            {
                "is_live": True,
                "flv_url": "https://example.test/live.flv?codec=h265",
                "m3u8_url": "https://example.test/live.m3u8",
            },
            "auto",
        )

        self.assertTrue(result.ok)
        self.assertEqual("hls", result.selected_type)
        self.assertEqual("https://example.test/live.m3u8", result.selected_url)
        self.assertTrue(result.hevc)

    def test_transcode_uses_best_available_upstream(self) -> None:
        result = choose_stream(
            {
                "is_live": True,
                "flv_url": "https://example.test/live.flv?codec=h265",
                "m3u8_url": "https://example.test/live.m3u8",
            },
            "transcode",
        )

        self.assertTrue(result.ok)
        self.assertEqual("transcode", result.selected_type)
        self.assertEqual("https://example.test/live.flv?codec=h265", result.selected_url)

    def test_transcode_source_change_closes_response_for_stable_reconnect(self) -> None:
        latest_result = ResolveResult(
            ok=True,
            is_live=True,
            selected_url="https://example.test/new.flv",
            selected_type="transcode",
        )

        self.assertTrue(
            should_close_transcode_response(
                "https://example.test/old.flv",
                1,
                2,
                latest_result,
            )
        )

    def test_transcode_same_source_does_not_close_response(self) -> None:
        latest_result = ResolveResult(
            ok=True,
            is_live=True,
            selected_url="https://example.test/live.flv",
            selected_type="transcode",
        )

        self.assertFalse(
            should_close_transcode_response(
                "https://example.test/live.flv",
                1,
                2,
                latest_result,
            )
        )

    def test_missing_upstream_is_not_ok(self) -> None:
        result = choose_stream({"is_live": False}, "auto")

        self.assertFalse(result.ok)
        self.assertIn("没有解析到可播放", result.error)

    def test_codec_can_be_enriched_from_douyin_sdk_params(self) -> None:
        stream_info = {
            "is_live": True,
            "flv_url": "https://example.test/live.flv",
            "m3u8_url": "https://example.test/live.m3u8",
        }
        json_data = {
            "stream_url": {
                "live_core_sdk_data": {
                    "pull_data": {
                        "stream_data": (
                            '{"data":{"origin":{"main":{"sdk_params":"'
                            '{\\"VCodec\\":\\"h264\\",\\"resolution\\":\\"1920x1080\\"}' 
                            '"}}}}'
                        )
                    }
                }
            }
        }

        enriched = enrich_douyin_stream_info(stream_info, json_data, "OD")
        result = choose_stream(enriched, "auto")

        self.assertEqual("h264", result.codec)
        self.assertEqual("flv", result.selected_type)

    def test_non_douyin_platform_can_be_detected(self) -> None:
        resolver = get_platform_resolver("https://live.bilibili.com/21593109")

        self.assertIsNotNone(resolver)
        self.assertEqual("B站直播", resolver.name if resolver else "")

    def test_non_douyin_platform_can_be_resolved(self) -> None:
        class FakeSpider:
            async def get_bilibili_room_info(self, url: str, proxy_addr: str | None = None, cookies: str | None = None) -> dict:
                return {"anchor_name": "测试主播", "live_status": True, "room_url": url, "title": "测试直播"}

        class FakeStream:
            async def get_bilibili_stream_url(
                self,
                json_data: dict,
                video_quality: str,
                proxy_addr: str | None,
                cookies: str,
            ) -> dict:
                return {
                    "anchor_name": json_data["anchor_name"],
                    "is_live": True,
                    "title": json_data["title"],
                    "quality": video_quality,
                    "record_url": "https://example.test/bilibili.m3u8",
                }

        original_load_modules = server_module.load_recorder_modules
        original_handle_proxy = server_module.handle_proxy_addr
        server_module.load_recorder_modules = lambda: (FakeSpider(), FakeStream(), object())
        server_module.handle_proxy_addr = lambda _proxy: None
        try:
            result = asyncio.run(
                resolve_platform_stream_async(
                    ProxySettings(room_url="https://live.bilibili.com/21593109", quality="HD", output_mode="auto")
                )
            )
        finally:
            server_module.load_recorder_modules = original_load_modules
            server_module.handle_proxy_addr = original_handle_proxy

        self.assertTrue(result.ok)
        self.assertEqual("B站直播", result.platform)
        self.assertEqual("hls", result.selected_type)
        self.assertEqual("https://example.test/bilibili.m3u8", result.selected_url)

    def test_direct_stream_url_is_supported(self) -> None:
        result = asyncio.run(
            resolve_platform_stream_async(
                ProxySettings(room_url="https://pull.example.test/live.flv?token=1", output_mode="auto")
            )
        )

        self.assertTrue(result.ok)
        self.assertEqual("自定义直播源", result.platform)
        self.assertEqual("flv", result.selected_type)

    def test_unknown_platform_is_rejected_after_recorder_mapping_check(self) -> None:
        original_load_modules = server_module.load_recorder_modules
        original_handle_proxy = server_module.handle_proxy_addr
        server_module.load_recorder_modules = lambda: (object(), object(), object())
        server_module.handle_proxy_addr = lambda _proxy: None
        try:
            result = asyncio.run(
                resolve_platform_stream_async(
                    ProxySettings(room_url="https://unsupported.example.test/live")
                )
            )
        finally:
            server_module.load_recorder_modules = original_load_modules
            server_module.handle_proxy_addr = original_handle_proxy

        self.assertFalse(result.ok)
        self.assertIn("暂未识别", result.error)

    def test_bilibili_play_info_prefers_avc_flv(self) -> None:
        stream_info = build_bilibili_stream_info_from_play_data(
            {
                "playurl_info": {
                    "playurl": {
                        "stream": [
                            {
                                "protocol_name": "http_stream",
                                "format": [
                                    {
                                        "format_name": "flv",
                                        "codec": [
                                            {
                                                "codec_name": "hevc",
                                                "base_url": "/live_hevc.flv",
                                                "url_info": [{"host": "https://example.test", "extra": "?token=1"}],
                                            },
                                            {
                                                "codec_name": "avc",
                                                "base_url": "/live_avc.flv",
                                                "url_info": [{"host": "https://example.test", "extra": "?token=2"}],
                                            },
                                        ],
                                    }
                                ],
                            },
                            {
                                "protocol_name": "http_hls",
                                "format": [
                                    {
                                        "format_name": "fmp4",
                                        "codec": [
                                            {
                                                "codec_name": "avc",
                                                "base_url": "/index.m3u8",
                                                "url_info": [{"host": "https://example.test", "extra": "?token=3"}],
                                            }
                                        ],
                                    }
                                ],
                            },
                        ]
                    }
                }
            }
        )

        self.assertEqual("https://example.test/live_avc.flv?token=2", stream_info["flv_url"])
        self.assertEqual("https://example.test/index.m3u8?token=3", stream_info["m3u8_url"])


class HlsRewriteTests(unittest.TestCase):
    def test_rewrites_playlist_segments_nested_playlists_and_keys(self) -> None:
        playlist = "\n".join(
            [
                "#EXTM3U",
                '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
                "#EXTINF:4.0,",
                "segment-1.ts?token=abc",
                "#EXT-X-STREAM-INF:BANDWIDTH=800000",
                "child/index.m3u8",
            ]
        )

        rewritten = rewrite_hls_playlist(
            playlist,
            "https://pull.example.test/live/master.m3u8?token=root",
            "http://127.0.0.1:5000",
        )

        self.assertIn("/hls/segment?url=https%3A%2F%2Fpull.example.test%2Flive%2Fkey.bin", rewritten)
        self.assertIn("/hls/segment?url=https%3A%2F%2Fpull.example.test%2Flive%2Fsegment-1.ts%3Ftoken%3Dabc", rewritten)
        self.assertIn("/hls/playlist?url=https%3A%2F%2Fpull.example.test%2Flive%2Fchild%2Findex.m3u8", rewritten)

    def test_strip_flv_header_removes_header_once(self) -> None:
        self.assertEqual(b"payload", strip_flv_header(b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00payload"))
        self.assertEqual(b"payload", strip_flv_header(b"payload"))


class ConfigTests(unittest.TestCase):
    def test_settings_round_trip_preserves_percent_cookie(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "local_proxy.ini"
            settings = ProxySettings(
                room_url="https://live.douyin.com/16014303469?camera_id=0",
                quality="HD",
                output_mode="transcode",
                cookie="msToken=abc%2Bdef; ttwid=one%7Ctwo",
                upstream_proxy="127.0.0.1:7890",
            )

            save_settings(settings, path)
            loaded = load_settings(path)

            self.assertEqual(settings.room_url, loaded.room_url)
            self.assertEqual("HD", loaded.quality)
            self.assertEqual("transcode", loaded.output_mode)
            self.assertEqual(settings.cookie, loaded.cookie)
            self.assertEqual(settings.upstream_proxy, loaded.upstream_proxy)

            parser = configparser.ConfigParser()
            parser.read(path, encoding="utf-8-sig")
            self.assertTrue(parser.has_section("local_proxy"))

    def test_find_ffmpeg_prefers_workspace_vendor_binary(self) -> None:
        original_project_root = server_module.PROJECT_ROOT
        original_bundle_root = server_module.BUNDLE_ROOT
        original_recorder_root = server_module.RECORDER_ROOT
        original_which = server_module.shutil.which

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vendored = root / "vendor" / "ffmpeg" / "bin" / "ffmpeg.exe"
            vendored.parent.mkdir(parents=True)
            vendored.write_bytes(b"test")
            server_module.PROJECT_ROOT = root
            server_module.BUNDLE_ROOT = root / "_internal"
            server_module.RECORDER_ROOT = root / "DouyinLiveRecorder"
            server_module.shutil.which = lambda name: "C:\\Windows\\ffmpeg.exe"

            try:
                self.assertEqual(str(vendored), find_ffmpeg())
            finally:
                server_module.PROJECT_ROOT = original_project_root
                server_module.BUNDLE_ROOT = original_bundle_root
                server_module.RECORDER_ROOT = original_recorder_root
                server_module.shutil.which = original_which

    def test_frozen_ffmpeg_requires_the_bundled_binary(self) -> None:
        original_bundle_root = server_module.BUNDLE_ROOT
        original_frozen = getattr(server_module.sys, "frozen", None)
        original_which = server_module.shutil.which
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            server_module.BUNDLE_ROOT = root / "_internal"
            server_module.sys.frozen = True
            server_module.shutil.which = lambda name: "C:\\Windows\\ffmpeg.exe"
            try:
                with self.assertRaisesRegex(RuntimeError, "冻结版缺少"):
                    find_ffmpeg()

                bundled = server_module.BUNDLE_ROOT / server_module.VENDORED_FFMPEG
                bundled.parent.mkdir(parents=True)
                bundled.write_bytes(b"ffmpeg")
                self.assertEqual(str(bundled), find_ffmpeg())
            finally:
                server_module.BUNDLE_ROOT = original_bundle_root
                server_module.shutil.which = original_which
                if original_frozen is None:
                    delattr(server_module.sys, "frozen")
                else:
                    server_module.sys.frozen = original_frozen

    def test_start_ffmpeg_process_hides_window_on_windows(self) -> None:
        original_platform = server_module.sys.platform
        original_popen = server_module.subprocess.Popen
        captured: dict[str, object] = {}

        class FakeProcess:
            pass

        def fake_popen(command: list[str], **kwargs: object) -> FakeProcess:
            captured["command"] = command
            captured.update(kwargs)
            return FakeProcess()

        server_module.sys.platform = "win32"
        server_module.subprocess.Popen = fake_popen  # type: ignore[assignment]
        try:
            process = start_ffmpeg_process(["ffmpeg", "-version"])
        finally:
            server_module.sys.platform = original_platform
            server_module.subprocess.Popen = original_popen

        self.assertIsInstance(process, FakeProcess)
        self.assertEqual(["ffmpeg", "-version"], captured["command"])
        self.assertEqual(server_module.subprocess.PIPE, captured["stdout"])
        self.assertEqual(server_module.subprocess.DEVNULL, captured["stderr"])
        self.assertEqual(getattr(server_module.subprocess, "CREATE_NO_WINDOW", 0), captured["creationflags"])
        self.assertIsNotNone(captured["startupinfo"])

    def test_ffmpeg_command_sends_browser_headers_before_input(self) -> None:
        original_find_ffmpeg = server_module.find_ffmpeg
        server_module.find_ffmpeg = lambda: "ffmpeg"
        try:
            command = get_ffmpeg_command("https://example.test/live.flv", ProxySettings())
        finally:
            server_module.find_ffmpeg = original_find_ffmpeg

        input_index = command.index("-i")
        self.assertIn("-user_agent", command[:input_index])
        self.assertIn("-headers", command[:input_index])
        self.assertIn("Referer: https://live.bilibili.com/", command[command.index("-headers") + 1])


class MockUpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path.startswith("/master.m3u8"):
            body = "#EXTM3U\n#EXTINF:1.0,\nseg.ts?token=1\n"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
        elif self.path.startswith("/seg.ts"):
            body = b"TS-DATA"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(HTTPStatus.NOT_FOUND)
            self.end_headers()


class MockFlvSwitchHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        marker = b"A" if self.path.startswith("/a.flv") else b"B"
        body = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00" + marker * 200000
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "video/x-flv")
        self.end_headers()
        try:
            for index in range(0, len(body), 128):
                self.wfile.write(body[index:index + 128])
                self.wfile.flush()
                time.sleep(0.01)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return


class MockFlvReconnectHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path.startswith("/a.flv"):
            body = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00" + b"A" * 1024
        else:
            body = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00" + b"B" * 200000
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "video/x-flv")
        self.end_headers()
        try:
            for index in range(0, len(body), 128):
                self.wfile.write(body[index:index + 128])
                self.wfile.flush()
                time.sleep(0.005)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return


class MockStatusHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path.startswith("/api/status"):
            body = b'{"service_id":"oba-video-relay","protocol_version":1,"obs_url":"http://127.0.0.1:5000/live","settings":{}}'
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(HTTPStatus.NOT_FOUND)
            self.end_headers()


def start_server(handler: type[BaseHTTPRequestHandler]) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server._test_thread = thread  # type: ignore[attr-defined]
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def proxy_thread_is_alive(server: ThreadingHTTPServer) -> bool:
    return bool(getattr(server, "_test_thread").is_alive())


class ProxyIntegrationTests(unittest.TestCase):
    def test_run_existing_instance_opens_browser_and_exits(self) -> None:
        existing, existing_base = start_server(MockStatusHandler)
        opened: list[str] = []
        original_open = server_module.webbrowser.open
        port = int(existing_base.rsplit(":", 1)[1])
        try:
            server_module.webbrowser.open = lambda url: opened.append(url) or True

            server_module.run(host="127.0.0.1", port=port)

            self.assertEqual([f"http://127.0.0.1:{port}/"], opened)
        finally:
            server_module.webbrowser.open = original_open
            existing.shutdown()
            existing.server_close()


class RemoteControlSurfaceTests(unittest.TestCase):
    def test_remote_control_pages_are_forbidden_before_status_resolution(self) -> None:
        for path in ("/", "/api/status?resolve=1"):
            responses: list[tuple[dict[str, str], HTTPStatus]] = []
            request = type("RemoteRequest", (), {})()
            request.path = path
            request.client_address = ("192.0.2.50", 54321)
            request.send_json = lambda data, status: responses.append((data, status))
            request.require_local_control = MethodType(LocalProxyHandler.require_local_control, request)
            request.handle_status = MethodType(LocalProxyHandler.handle_status, request)

            LocalProxyHandler.do_GET(request)

            self.assertEqual([({"error": "控制接口仅允许本机访问。"}, HTTPStatus.FORBIDDEN)], responses)

    def test_status_resolve_query_is_not_a_get_operation(self) -> None:
        responses: list[tuple[dict[str, str], HTTPStatus]] = []
        request = type("LocalRequest", (), {})()
        request.path = "/api/status?resolve=1"
        request.client_address = ("127.0.0.1", 54321)
        request.server = type("Server", (), {"server_address": ("127.0.0.1", 5000)})()
        request.headers = {"Host": "127.0.0.1:5000"}
        request.send_json = lambda data, status: responses.append((data, status))
        request.is_local_control_origin = LocalProxyHandler.is_local_control_origin
        request.require_local_control = MethodType(LocalProxyHandler.require_local_control, request)

        LocalProxyHandler.do_GET(request)

        self.assertEqual(HTTPStatus.METHOD_NOT_ALLOWED, responses[0][1])

    def test_local_control_rejects_foreign_origin_host_and_non_json_posts(self) -> None:
        for headers, expected in (
            ({"Host": "example.test:5000"}, "Host"),
            ({"Host": "127.0.0.1:5000", "Origin": "https://example.test"}, "跨域"),
        ):
            responses: list[tuple[dict[str, str], HTTPStatus]] = []
            request = type("LocalRequest", (), {})()
            request.client_address = ("127.0.0.1", 54321)
            request.server = type("Server", (), {"server_address": ("127.0.0.1", 5000)})()
            request.headers = headers
            request.send_json = lambda data, status: responses.append((data, status))
            request.is_local_control_origin = LocalProxyHandler.is_local_control_origin

            self.assertFalse(LocalProxyHandler.require_local_control(request))
            self.assertEqual(HTTPStatus.FORBIDDEN, responses[0][1])
            self.assertIn(expected, responses[0][0]["error"])

        responses = []
        request = type("LocalRequest", (), {})()
        request.client_address = ("127.0.0.1", 54321)
        request.server = type("Server", (), {"server_address": ("127.0.0.1", 5000)})()
        request.headers = {"Host": "127.0.0.1:5000", "Content-Type": "text/plain"}
        request.send_json = lambda data, status: responses.append((data, status))
        request.is_local_control_origin = LocalProxyHandler.is_local_control_origin
        request.require_local_control = MethodType(LocalProxyHandler.require_local_control, request)
        request.require_json_content_type = MethodType(LocalProxyHandler.require_json_content_type, request)

        LocalProxyHandler.handle_control(request)

        self.assertEqual(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, responses[0][1])

    def test_remote_media_routes_do_not_require_local_control(self) -> None:
        events: list[tuple[str, bool | None]] = []
        live_request = type("RemoteMediaRequest", (), {})()
        live_request.path = "/live"
        live_request.handle_live = lambda: events.append(("live", None))
        live_request.require_local_control = lambda: (_ for _ in ()).throw(AssertionError("media must remain LAN-accessible"))
        LocalProxyHandler.do_GET(live_request)

        hls_request = type("RemoteMediaRequest", (), {})()
        hls_request.path = "/hls/playlist?url=https%3A%2F%2Fexample.test%2Flive.m3u8"
        hls_request.handle_hls_proxy = lambda parsed, playlist: events.append((parsed.path, playlist))
        hls_request.require_local_control = lambda: (_ for _ in ()).throw(AssertionError("media must remain LAN-accessible"))
        LocalProxyHandler.do_GET(hls_request)

        self.assertEqual([("live", None), ("/hls/playlist", True)], events)

    def test_hls_playlist_proxy_rewrites_mock_upstream(self) -> None:
        upstream, upstream_base = start_server(MockUpstreamHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            with server_module.STATE.lock:
                server_module.STATE.last_result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/master.m3u8",
                    selected_type="hls",
                    m3u8_url=f"{upstream_base}/master.m3u8",
                )
            url = f"{proxy_base}/hls/playlist?url={upstream_base}/master.m3u8"
            with urlopen(url, timeout=5) as response:
                body = response.read().decode("utf-8")

            self.assertEqual(HTTPStatus.OK, response.status)
            self.assertIn("/hls/segment?url=", body)
            self.assertIn("seg.ts%3Ftoken%3D1", body)

            segment_url = f"{proxy_base}/hls/segment?url={quote(upstream_base + '/seg.ts?token=1', safe='')}"
            with urlopen(segment_url, timeout=5) as segment_response:
                self.assertEqual(b"TS-DATA", segment_response.read())
        finally:
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_hls_segment_proxy_rejects_unrelated_hosts(self) -> None:
        upstream, upstream_base = start_server(MockUpstreamHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            with server_module.STATE.lock:
                server_module.STATE.last_result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/master.m3u8",
                    selected_type="hls",
                    m3u8_url=f"{upstream_base}/master.m3u8",
                )
            url = f"{proxy_base}/hls/segment?url={quote('http://example.invalid/seg.ts', safe='')}"
            with self.assertRaises(HTTPError) as rejected:
                urlopen(url, timeout=5)
            self.assertEqual(HTTPStatus.FORBIDDEN, rejected.exception.status)
            rejected.exception.close()
        finally:
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_hls_segment_proxy_rejects_unregistered_url_on_same_host(self) -> None:
        upstream, upstream_base = start_server(MockUpstreamHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            with server_module.STATE.lock:
                server_module.STATE.allowed_hls_urls.clear()
                server_module.STATE.last_result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/master.m3u8",
                    selected_type="hls",
                    m3u8_url=f"{upstream_base}/master.m3u8",
                )
            url = f"{proxy_base}/hls/segment?url={quote(upstream_base + '/unregistered.ts', safe='')}"
            with self.assertRaises(HTTPError) as rejected:
                urlopen(url, timeout=5)
            self.assertEqual(HTTPStatus.FORBIDDEN, rejected.exception.status)
            rejected.exception.close()
        finally:
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_live_response_closes_when_source_changes_so_obs_can_open_a_new_flv_session(self) -> None:
        upstream, upstream_base = start_server(MockFlvSwitchHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        original_resolver = server_module.resolve_douyin_stream
        try:
            with server_module.STATE.lock:
                server_module.STATE.stream_enabled = True
                server_module.STATE.stream_generation = 0
                server_module.STATE.source_version = 1
                server_module.STATE.settings.chunk_size = 128
                server_module.STATE.last_result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/a.flv",
                    selected_type="flv",
                    codec="h264",
                )

            def fake_resolver(settings: ProxySettings, force: bool = True) -> ResolveResult:
                assert server_module.STATE.last_result is not None
                return server_module.STATE.last_result

            server_module.resolve_douyin_stream = fake_resolver
            response = requests.get(f"{proxy_base}/live", stream=True, timeout=(5, 10))
            try:
                chunks = response.iter_content(chunk_size=64)
                first_bytes = b"".join(next(chunks) for _ in range(8))
                self.assertIn(b"A", first_bytes)

                with server_module.STATE.lock:
                    server_module.STATE.last_result = ResolveResult(
                        ok=True,
                        is_live=True,
                        selected_url=f"{upstream_base}/b.flv",
                        selected_type="flv",
                        codec="h264",
                    )
                server_module.STATE.mark_source_changed()

                remaining = b"".join(chunks)
                self.assertNotIn(b"B", remaining)
                self.assertEqual(HTTPStatus.OK, response.status_code)
            finally:
                response.close()
        finally:
            server_module.resolve_douyin_stream = original_resolver
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_live_response_closes_after_upstream_eof_without_splicing_the_next_flv_source(self) -> None:
        upstream, upstream_base = start_server(MockFlvReconnectHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        original_resolver = server_module.resolve_douyin_stream
        calls = {"count": 0}
        try:
            with server_module.STATE.lock:
                server_module.STATE.stream_enabled = True
                server_module.STATE.stream_generation = 0
                server_module.STATE.source_version = 1
                server_module.STATE.last_result = None
                server_module.STATE.settings.chunk_size = 128

            def fake_resolver(settings: ProxySettings, force: bool = True) -> ResolveResult:
                calls["count"] += 1
                suffix = "a.flv" if calls["count"] == 1 else "b.flv"
                result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/{suffix}",
                    selected_type="flv",
                    flv_url=f"{upstream_base}/{suffix}",
                    codec="h264",
                )
                with server_module.STATE.lock:
                    server_module.STATE.last_result = result
                return result

            server_module.resolve_douyin_stream = fake_resolver
            response = requests.get(f"{proxy_base}/live", stream=True, timeout=(5, 15))
            try:
                chunks = response.iter_content(chunk_size=64)
                first_bytes = b"".join(next(chunks) for _ in range(8))
                self.assertIn(b"A", first_bytes)

                remaining = b"".join(chunks)
                self.assertNotIn(b"B", remaining)
                self.assertEqual(1, calls["count"])
            finally:
                response.close()
        finally:
            server_module.resolve_douyin_stream = original_resolver
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_active_clients_tracks_open_live_responses_only(self) -> None:
        upstream, upstream_base = start_server(MockFlvSwitchHandler)
        proxy, proxy_base = start_server(LocalProxyHandler)
        original_resolver = server_module.resolve_douyin_stream
        try:
            with server_module.STATE.lock:
                server_module.STATE.stream_enabled = True
                server_module.STATE.stream_generation = 0
                server_module.STATE.active_clients.clear()
                server_module.STATE.last_result = ResolveResult(
                    ok=True,
                    is_live=True,
                    selected_url=f"{upstream_base}/a.flv",
                    selected_type="flv",
                    codec="h264",
                )

            def fake_resolver(settings: ProxySettings, force: bool = True) -> ResolveResult:
                assert server_module.STATE.last_result is not None
                return server_module.STATE.last_result

            server_module.resolve_douyin_stream = fake_resolver
            first = requests.get(f"{proxy_base}/live", stream=True, timeout=(5, 10))
            second = requests.get(f"{proxy_base}/live", stream=True, timeout=(5, 10))
            try:
                next(first.iter_content(chunk_size=64))
                next(second.iter_content(chunk_size=64))
                self.assertEqual(2, server_module.STATE.snapshot()["active_clients"])

                first.close()
                mark_one_client_stale()
                self.assertEqual(2, server_module.STATE.snapshot()["active_clients"])
            finally:
                second.close()
                first.close()
            deadline = time.time() + 5
            while time.time() < deadline and server_module.STATE.snapshot()["active_clients"]:
                time.sleep(0.05)
            self.assertEqual(0, server_module.STATE.snapshot()["active_clients"])
        finally:
            server_module.resolve_douyin_stream = original_resolver
            proxy.shutdown()
            proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            upstream.shutdown()
            upstream.server_close()

    def test_control_stop_blocks_live_and_start_reenables_output(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            post_json(f"{proxy_base}/api/control", {"action": "stop"})
            with self.assertRaises(HTTPError) as stopped:
                urlopen(f"{proxy_base}/live", timeout=5)
            self.assertEqual(HTTPStatus.SERVICE_UNAVAILABLE, stopped.exception.status)
            stopped.exception.close()

            started = post_json(f"{proxy_base}/api/control", {"action": "start", "resolve": False})
            self.assertTrue(started["stream_enabled"])
        finally:
            post_json(f"{proxy_base}/api/control", {"action": "start", "resolve": False})
            proxy.shutdown()
            proxy.server_close()

    def test_shutdown_endpoint_stops_local_server(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        response = post_json(f"{proxy_base}/api/shutdown", {})

        self.assertTrue(response["ok"])
        deadline = time.time() + 5
        while time.time() < deadline and proxy_thread_is_alive(proxy):
            time.sleep(0.05)
        proxy.server_close()
        self.assertFalse(proxy_thread_is_alive(proxy))

    def test_stop_server_posts_shutdown_to_recorded_port(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        original_project_root = stop_server_module.PROJECT_ROOT
        original_config_dir = stop_server_module.CONFIG_DIR
        original_config_file = stop_server_module.CONFIG_FILE
        original_instance_info = stop_server_module.INSTANCE_INFO_FILE
        port = int(proxy_base.rsplit(":", 1)[1])
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                config_dir = root / "config"
                config_dir.mkdir()
                (config_dir / "instance.json").write_text(json.dumps({"port": port}), encoding="utf-8")
                stop_server_module.PROJECT_ROOT = root
                stop_server_module.CONFIG_DIR = config_dir
                stop_server_module.CONFIG_FILE = config_dir / "local_proxy.ini"
                stop_server_module.INSTANCE_INFO_FILE = config_dir / "instance.json"

                self.assertEqual(0, stop_server_module.main())
                deadline = time.time() + 5
                while time.time() < deadline and proxy_thread_is_alive(proxy):
                    time.sleep(0.05)
        finally:
            stop_server_module.PROJECT_ROOT = original_project_root
            stop_server_module.CONFIG_DIR = original_config_dir
            stop_server_module.CONFIG_FILE = original_config_file
            stop_server_module.INSTANCE_INFO_FILE = original_instance_info
            proxy.server_close()

    def test_settings_enable_stream_does_not_advance_generation(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        original_save_settings = server_module.save_settings
        try:
            server_module.save_settings = lambda settings: None
            stopped = post_json(f"{proxy_base}/api/control", {"action": "stop"})
            generation = stopped["stream_generation"]

            switched = post_json(
                f"{proxy_base}/api/settings",
                {
                    "room_url": "https://live.douyin.com/example",
                    "resolve": False,
                    "enable_stream": True,
                },
            )

            self.assertTrue(switched["stream_enabled"])
            self.assertEqual(generation, switched["stream_generation"])
        finally:
            server_module.save_settings = original_save_settings
            post_json(f"{proxy_base}/api/control", {"action": "start", "resolve": False})
            proxy.shutdown()
            proxy.server_close()

    def test_settings_rejects_oversized_body(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            body = b"{" + b'"x":"' + (b"a" * (server_module.MAX_API_BODY_BYTES + 1)) + b'"}'
            request = Request(
                f"{proxy_base}/api/settings",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(HTTPError) as rejected:
                urlopen(request, timeout=10)
            self.assertEqual(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, rejected.exception.status)
            rejected.exception.close()
        finally:
            proxy.shutdown()
            proxy.server_close()

    def test_settings_and_control_reject_non_object_json(self) -> None:
        proxy, proxy_base = start_server(LocalProxyHandler)
        try:
            for endpoint in ("/api/settings", "/api/control"):
                request = Request(
                    f"{proxy_base}{endpoint}",
                    data=b"[]",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(request, timeout=10)
                self.assertEqual(HTTPStatus.BAD_REQUEST, rejected.exception.status)
                rejected.exception.close()
        finally:
            proxy.shutdown()
            proxy.server_close()


def post_json(url: str, payload: dict[str, object]) -> dict[str, object]:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def mark_one_client_stale() -> None:
    with server_module.STATE.lock:
        for client_id in list(server_module.STATE.active_clients.keys())[:1]:
            server_module.STATE.active_clients[client_id] = time.time() - 10


def mark_all_clients_stale() -> None:
    with server_module.STATE.lock:
        for client_id in list(server_module.STATE.active_clients.keys()):
            server_module.STATE.active_clients[client_id] = time.time() - 10


if __name__ == "__main__":
    unittest.main()
