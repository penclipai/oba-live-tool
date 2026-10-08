from __future__ import annotations

import io
import queue
import threading
import unittest
import asyncio
from urllib.parse import quote

import requests
import local_proxy.server as server_module
from local_proxy.server import ProxyState, ResolveResult, rewrite_hls_playlist, should_close_transcode_response


class SourceTransitionTests(unittest.TestCase):
    def test_transcode_response_closes_when_output_mode_changes_to_hls(self) -> None:
        latest = ResolveResult(
            ok=True,
            is_live=True,
            selected_url="https://pull.example.test/live.m3u8",
            selected_type="hls",
        )
        self.assertTrue(
            should_close_transcode_response(
                "https://pull.example.test/live.flv", 4, 5, latest
            )
        )

    def test_flv_eof_closes_response_without_splicing_a_second_upstream_stream(self) -> None:
        request = _media_request()
        calls = {"get": 0, "refresh": 0}

        class Response:
            headers = {"Content-Type": "video/x-flv"}

            def raise_for_status(self) -> None:
                return

            def iter_content(self, chunk_size: int):
                yield b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00first-session"

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original_get = server_module.requests.get
        original_refresh = server_module.force_refresh_flv_source
        original_enabled = server_module.STATE.stream_enabled
        original_generation = server_module.STATE.stream_generation
        try:
            server_module.STATE.stream_enabled = True
            server_module.STATE.stream_generation = 0
            server_module.requests.get = lambda *args, **kwargs: calls.update(get=calls["get"] + 1) or Response()  # type: ignore[assignment]
            server_module.force_refresh_flv_source = lambda: calls.update(refresh=calls["refresh"] + 1)  # type: ignore[assignment]

            server_module.LocalProxyHandler.proxy_switchable_binary(
                request, "https://pull.example.test/first.flv", "video/x-flv", 0, 0, "test-client"
            )
        finally:
            server_module.requests.get = original_get
            server_module.force_refresh_flv_source = original_refresh
            server_module.STATE.stream_enabled = original_enabled
            server_module.STATE.stream_generation = original_generation

        self.assertEqual(1, calls["get"])
        self.assertEqual(0, calls["refresh"])

    def test_downstream_disconnect_does_not_refresh_the_upstream_source(self) -> None:
        request = _media_request(wfile=_BrokenWriter())
        calls = {"get": 0, "refresh": 0}

        class Response:
            headers = {"Content-Type": "video/x-flv"}

            def raise_for_status(self) -> None:
                return

            def iter_content(self, chunk_size: int):
                yield b"media"

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original_get = server_module.requests.get
        original_refresh = server_module.force_refresh_flv_source
        original_enabled = server_module.STATE.stream_enabled
        original_generation = server_module.STATE.stream_generation
        try:
            server_module.STATE.stream_enabled = True
            server_module.STATE.stream_generation = 0
            server_module.requests.get = lambda *args, **kwargs: calls.update(get=calls["get"] + 1) or Response()  # type: ignore[assignment]
            server_module.force_refresh_flv_source = lambda: calls.update(refresh=calls["refresh"] + 1)  # type: ignore[assignment]

            server_module.LocalProxyHandler.proxy_switchable_binary(
                request, "https://pull.example.test/live.flv", "video/x-flv", 0, 0, "test-client"
            )
        finally:
            server_module.requests.get = original_get
            server_module.force_refresh_flv_source = original_refresh
            server_module.STATE.stream_enabled = original_enabled
            server_module.STATE.stream_generation = original_generation

        self.assertEqual(1, calls["get"])
        self.assertEqual(0, calls["refresh"])

class ClientAccountingTests(unittest.TestCase):
    def test_active_client_count_keeps_connected_client_when_no_media_has_arrived_recently(self) -> None:
        state = ProxyState()
        client_id = state.register_client()
        with state.lock:
            state.active_clients[client_id] = 0.0

        self.assertEqual(1, state.active_client_count())
        self.assertIn(client_id, state.active_clients)


class HlsRewriteStabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.allowed_hls_urls.clear()

    def tearDown(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.allowed_hls_urls.clear()

    def _rewrite(self, line: str) -> str:
        return rewrite_hls_playlist(
            "#EXTM3U\n" + line,
            "https://pull.example.test/live/master.m3u8?token=root",
            "http://127.0.0.1:5000",
        )

    def test_rewrites_fmp4_initialization_uri(self) -> None:
        rewritten = self._rewrite('#EXT-X-MAP:URI="init.mp4"')

        self.assertIn("/hls/segment?url=https%3A%2F%2Fpull.example.test%2Flive%2Finit.mp4", rewritten)

    def test_rewrites_media_rendition_uri(self) -> None:
        rewritten = self._rewrite('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"')

        self.assertIn("/hls/playlist?url=https%3A%2F%2Fpull.example.test%2Flive%2Faudio%2Findex.m3u8", rewritten)

    def test_rewrites_partial_segment_uri(self) -> None:
        rewritten = self._rewrite('#EXT-X-PART:DURATION=0.333,URI="part-1.m4s"')

        self.assertIn("/hls/segment?url=https%3A%2F%2Fpull.example.test%2Flive%2Fpart-1.m4s", rewritten)

    def test_rewrites_preload_hint_uri(self) -> None:
        rewritten = self._rewrite('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next-part.m4s"')

        self.assertIn("/hls/segment?url=https%3A%2F%2Fpull.example.test%2Flive%2Fnext-part.m4s", rewritten)

    def test_hls_authorization_cache_stays_bounded_during_long_sliding_playlist(self) -> None:
        state = ProxyState()
        for index in range(5000):
            self.assertTrue(state.register_hls_url(f"https://pull.example.test/segment-{index}.ts"))

        self.assertLessEqual(len(state.allowed_hls_urls), 4096)
        self.assertTrue(state.is_registered_hls_url("https://pull.example.test/segment-4999.ts"))
        self.assertFalse(state.is_registered_hls_url("https://pull.example.test/segment-0.ts"))

    def test_hls_authorization_entries_expire_after_their_ttl(self) -> None:
        state = ProxyState()
        url = "https://pull.example.test/expired.ts"
        self.assertTrue(state.register_hls_url(url))
        with state.lock:
            state.allowed_hls_urls[url] = 0.0

        self.assertFalse(state.is_registered_hls_url(url))

    def test_expired_entry_is_rejected_even_when_an_older_entry_is_still_fresh(self) -> None:
        state = ProxyState()
        fresh = "https://pull.example.test/fresh.ts"
        expired = "https://pull.example.test/expired.ts"
        self.assertTrue(state.register_hls_url(fresh))
        self.assertTrue(state.register_hls_url(expired))
        with state.lock:
            state.allowed_hls_urls[fresh] = float("inf")
            state.allowed_hls_urls[expired] = 0.0

        self.assertFalse(state.is_registered_hls_url(expired))

    def test_rewrites_extensionless_media_rendition_to_playlist_proxy(self) -> None:
        rewritten = self._rewrite('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio"')

        self.assertIn("/hls/playlist?url=", rewritten)

    def test_rewrites_extensionless_iframe_rendition_to_playlist_proxy(self) -> None:
        rewritten = self._rewrite('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes"')

        self.assertIn("/hls/playlist?url=", rewritten)

    def test_rewrites_extensionless_plain_variant_uri_to_playlist_proxy(self) -> None:
        rewritten = rewrite_hls_playlist(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant\n",
            "https://pull.example.test/live/master.m3u8",
            "http://127.0.0.1:5000",
        )

        self.assertIn("/hls/playlist?url=", rewritten)

    def test_rejects_an_oversized_playlist_without_registering_a_partial_authorization_set(self) -> None:
        playlist = "\n".join(f"segment-{index}.ts" for index in range(4097))

        with self.assertRaises(server_module.HLSRegistryFull):
            rewrite_hls_playlist(
                playlist,
                "https://pull.example.test/live/index.m3u8",
                "http://127.0.0.1:5000",
            )

        self.assertEqual({}, dict(server_module.STATE.allowed_hls_urls))


class HlsRangeTests(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.STATE.lock:
            self.original_enabled = server_module.STATE.stream_enabled
            self.original_generation = server_module.STATE.stream_generation
            server_module.STATE.stream_enabled = True
            server_module.STATE.stream_generation = 0

    def tearDown(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.stream_enabled = self.original_enabled
            server_module.STATE.stream_generation = self.original_generation

    def test_proxy_binary_forwards_client_range_header(self) -> None:
        request = type("Request", (), {})()
        request.headers = {"Range": "bytes=128-255", "If-Range": "etag-1", "Cookie": "must-not-forward"}
        request.wfile = io.BytesIO()
        sent: dict[str, object] = {"headers": {}}
        request.send_response = lambda status: sent.update(status=status)
        request.send_header = lambda name, value: sent["headers"].update({name: value})
        request.end_headers = lambda: None
        request.set_media_write_timeout = lambda: None
        request.server = type("Server", (), {})()

        captured: dict[str, object] = {}

        class Response:
            headers = {"Content-Type": "video/mp4", "Content-Range": "bytes 128-255/1024"}
            status_code = 206

            def raise_for_status(self) -> None:
                return

            def iter_content(self, chunk_size: int):
                yield b"range-data"

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original_get = server_module.requests.get
        server_module.requests.get = lambda url, **kwargs: captured.update(kwargs) or Response()  # type: ignore[assignment]
        try:
            server_module.LocalProxyHandler.proxy_binary(
                request, "https://pull.example.test/init.mp4", "video/mp4", 0
            )
        finally:
            server_module.requests.get = original_get

        self.assertEqual("bytes=128-255", captured["headers"]["Range"])
        self.assertEqual("etag-1", captured["headers"]["If-Range"])
        self.assertEqual("identity", captured["headers"]["Accept-Encoding"])
        self.assertNotIn("Cookie", captured["headers"])
        self.assertEqual(206, sent["status"])
        self.assertEqual("bytes 128-255/1024", sent["headers"]["Content-Range"])
        self.assertEqual(b"range-data", request.wfile.getvalue())

    def test_proxy_binary_preserves_encoded_upstream_bytes_and_encoding_headers(self) -> None:
        request = _media_request()
        headers: dict[str, str] = {}
        request.send_header = lambda name, value: headers.update({name: value})
        encoded = b"\x1f\x8bcompressed-media"

        class Raw:
            def stream(self, chunk_size: int, decode_content: bool):
                self.chunk_size = chunk_size
                self.decode_content = decode_content
                yield encoded

        class Response:
            headers = {"Content-Type": "video/mp4", "Content-Encoding": "gzip", "Content-Length": str(len(encoded))}
            status_code = 200
            raw = Raw()

            def raise_for_status(self) -> None:
                return

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        captured: dict[str, object] = {}
        original_get = server_module.requests.get
        try:
            server_module.requests.get = lambda url, **kwargs: captured.update(kwargs) or Response()  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_binary(request, "https://pull.example.test/media", "video/mp4", 0)
        finally:
            server_module.requests.get = original_get

        self.assertEqual("identity", captured["headers"]["Accept-Encoding"])
        self.assertEqual(b"\x1f\x8bcompressed-media", request.wfile.getvalue())
        self.assertEqual("gzip", headers["Content-Encoding"])
        self.assertEqual(str(len(encoded)), headers["Content-Length"])


class HlsSignedUrlTests(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.STATE.lock:
            self.original_enabled = server_module.STATE.stream_enabled
            server_module.STATE.stream_enabled = True

    def tearDown(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.stream_enabled = self.original_enabled

    def test_hls_proxy_decodes_the_signed_url_parameter_exactly_once(self) -> None:
        upstream = "https://pull.example.test/segment.ts?token=a%2Fb%2Bc%25"
        seen: list[str] = []
        request = type("Request", (), {})()
        request.send_text = lambda *args, **kwargs: None
        with server_module.STATE.lock:
            original_result = server_module.STATE.last_result
            server_module.STATE.last_result = ResolveResult(
                ok=True, is_live=True, selected_url=upstream, selected_type="hls"
            )
        try:
            request.proxy_hls_binary_limited = lambda url, *args: seen.append(url)
            parsed = type("Parsed", (), {"query": "url=" + quote(upstream, safe="")})()
            server_module.LocalProxyHandler.handle_hls_proxy(request, parsed, False)
        finally:
            with server_module.STATE.lock:
                server_module.STATE.last_result = original_result

        self.assertEqual([upstream], seen)


class TranscodeCleanupTests(unittest.TestCase):
    def test_reader_and_stdout_are_cleaned_when_process_terminate_raises_after_exit(self) -> None:
        events: list[str] = []

        class Stdout:
            def close(self) -> None:
                events.append("stdout-close")

        class Process:
            stdout = Stdout()

            def poll(self) -> int:
                return 0

            def terminate(self) -> None:
                events.append("terminate")
                raise OSError("already exited")

        class Reader:
            def join(self, timeout: float) -> None:
                events.append("reader-join")

        original_terminate = server_module.terminate_process
        try:
            server_module.terminate_process = lambda process: process.terminate()  # type: ignore[assignment]
            server_module.stop_transcode_pipeline(Process(), threading.Event(), Reader())
        finally:
            server_module.terminate_process = original_terminate

        self.assertEqual(["terminate", "stdout-close", "reader-join"], events)


class TranscodeStallTests(unittest.TestCase):
    def test_silent_running_ffmpeg_closes_response_after_silence_timeout(self) -> None:
        request = _media_request()
        stopped: list[object] = []

        class Process:
            def poll(self) -> None:
                return None

        original_command = server_module.get_ffmpeg_command
        original_start = server_module.start_ffmpeg_process
        original_reader = server_module.start_stdout_reader
        original_first = server_module.read_first_transcode_chunk
        original_stop = server_module.stop_transcode_pipeline
        original_monotonic = server_module.time.monotonic
        original_enabled = server_module.STATE.stream_enabled
        original_generation = server_module.STATE.stream_generation
        try:
            server_module.STATE.stream_enabled = True
            server_module.STATE.stream_generation = 0
            server_module.get_ffmpeg_command = lambda url, settings: ["ffmpeg"]
            server_module.start_ffmpeg_process = lambda command: Process()  # type: ignore[assignment]
            server_module.start_stdout_reader = lambda *args: threading.Thread()  # type: ignore[assignment]
            server_module.read_first_transcode_chunk = lambda *args: b"first-frame"  # type: ignore[assignment]
            server_module.stop_transcode_pipeline = lambda *args: stopped.append(args[0])  # type: ignore[assignment]
            ticks = iter((0.0, server_module.TRANSCODE_SILENCE_TIMEOUT + 0.1))
            server_module.time.monotonic = lambda: next(ticks)

            server_module.LocalProxyHandler.stream_transcode(
                request, "https://pull.example.test/live.flv", 0, "test-client"
            )
        finally:
            server_module.get_ffmpeg_command = original_command
            server_module.start_ffmpeg_process = original_start
            server_module.start_stdout_reader = original_reader
            server_module.read_first_transcode_chunk = original_first
            server_module.stop_transcode_pipeline = original_stop
            server_module.time.monotonic = original_monotonic
            server_module.STATE.stream_enabled = original_enabled
            server_module.STATE.stream_generation = original_generation

        self.assertIn(Process, [type(process) for process in stopped])

    def test_transcode_eof_cannot_invalidate_a_newer_source_published_during_output_write(self) -> None:
        newer = ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/new.flv", selected_type="transcode")
        request = _media_request(wfile=_SwitchSourceWriter(newer))

        class Process:
            def poll(self) -> None:
                return None

        class EndedQueue:
            def __init__(self, maxsize: int) -> None:
                return

            def get(self, timeout: float) -> None:
                return None

        original_command = server_module.get_ffmpeg_command
        original_start = server_module.start_ffmpeg_process
        original_reader = server_module.start_stdout_reader
        original_first = server_module.read_first_transcode_chunk
        original_stop = server_module.stop_transcode_pipeline
        original_queue = server_module.queue.Queue
        original_result = server_module.STATE.last_result
        original_version = server_module.STATE.source_version
        observed_result: ResolveResult | None = None
        try:
            server_module.STATE.last_result = ResolveResult(
                ok=True, is_live=True, selected_url="https://pull.example.test/old.flv", selected_type="transcode"
            )
            server_module.STATE.source_version = 30
            server_module.get_ffmpeg_command = lambda url, settings: ["ffmpeg"]
            server_module.start_ffmpeg_process = lambda command: Process()  # type: ignore[assignment]
            server_module.start_stdout_reader = lambda *args: threading.Thread()  # type: ignore[assignment]
            server_module.read_first_transcode_chunk = lambda *args: b"first-frame"  # type: ignore[assignment]
            server_module.stop_transcode_pipeline = lambda *args: None  # type: ignore[assignment]
            server_module.queue.Queue = EndedQueue  # type: ignore[assignment]
            server_module.LocalProxyHandler.stream_transcode(request, "https://pull.example.test/old.flv", 0, "client", 30)
            observed_result = server_module.STATE.last_result
        finally:
            server_module.get_ffmpeg_command = original_command
            server_module.start_ffmpeg_process = original_start
            server_module.start_stdout_reader = original_reader
            server_module.read_first_transcode_chunk = original_first
            server_module.stop_transcode_pipeline = original_stop
            server_module.queue.Queue = original_queue  # type: ignore[assignment]
            server_module.STATE.last_result = original_result
            server_module.STATE.source_version = original_version

        self.assertIs(observed_result, newer)


class StreamInvalidationRaceTests(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.STATE.lock:
            self.original_result = server_module.STATE.last_result
            self.original_source_version = server_module.STATE.source_version
            self.original_enabled = server_module.STATE.stream_enabled
            self.original_generation = server_module.STATE.stream_generation
            server_module.STATE.stream_enabled = True
            server_module.STATE.stream_generation = 0
            server_module.STATE.source_version = 7
            self.old_result = ResolveResult(
                ok=True, is_live=True, selected_url="https://pull.example.test/old.flv", selected_type="flv"
            )
            server_module.STATE.last_result = self.old_result

    def tearDown(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.last_result = self.original_result
            server_module.STATE.source_version = self.original_source_version
            server_module.STATE.stream_enabled = self.original_enabled
            server_module.STATE.stream_generation = self.original_generation

    def test_upstream_request_error_invalidates_the_matching_cached_source(self) -> None:
        request = _media_request()
        original_get = server_module.requests.get
        original_refresh = server_module.force_refresh_flv_source
        try:
            server_module.requests.get = lambda *args, **kwargs: (_ for _ in ()).throw(requests.ConnectionError("upstream gone"))  # type: ignore[assignment]
            refreshes: list[None] = []
            server_module.force_refresh_flv_source = lambda: refreshes.append(None)  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_switchable_binary(
                request, self.old_result.selected_url, "video/x-flv", 0, 7, "client"
            )
        finally:
            server_module.requests.get = original_get
            server_module.force_refresh_flv_source = original_refresh

        self.assertIsNone(server_module.STATE.last_result)
        self.assertEqual([], refreshes)

    def test_downstream_broken_pipe_keeps_the_cached_source_for_the_next_client(self) -> None:
        request = _media_request(wfile=_BrokenWriter())
        original_get = server_module.requests.get
        try:
            server_module.requests.get = lambda *args, **kwargs: _OneChunkResponse(b"payload")  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_switchable_binary(
                request, self.old_result.selected_url, "video/x-flv", 0, 7, "client"
            )
        finally:
            server_module.requests.get = original_get

        self.assertIs(server_module.STATE.last_result, self.old_result)

    def test_old_stream_eof_cannot_invalidate_a_newer_source_published_during_write(self) -> None:
        newer = ResolveResult(
            ok=True, is_live=True, selected_url="https://pull.example.test/new.flv", selected_type="flv"
        )
        request = _media_request(wfile=_SwitchSourceWriter(newer))
        original_get = server_module.requests.get
        try:
            server_module.requests.get = lambda *args, **kwargs: _OneChunkResponse(b"payload")  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_switchable_binary(
                request, self.old_result.selected_url, "video/x-flv", 0, 7, "client"
            )
        finally:
            server_module.requests.get = original_get

        self.assertIs(server_module.STATE.last_result, newer)


class HlsRevisionRaceTests(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.STATE.lock:
            self.original_result = server_module.STATE.last_result
            self.original_source_version = server_module.STATE.source_version
            self.original_urls = server_module.STATE.allowed_hls_urls.copy()
            server_module.STATE.last_result = ResolveResult(
                ok=True, is_live=True, selected_url="https://pull.example.test/old.m3u8", selected_type="hls"
            )
            server_module.STATE.source_version = 10
            server_module.STATE.allowed_hls_urls.clear()

    def tearDown(self) -> None:
        with server_module.STATE.lock:
            server_module.STATE.last_result = self.original_result
            server_module.STATE.source_version = self.original_source_version
            server_module.STATE.allowed_hls_urls.clear()
            server_module.STATE.allowed_hls_urls.update(self.original_urls)

    def test_playlist_switch_during_rewrite_does_not_publish_old_uri_authorizations(self) -> None:
        statuses: list[object] = []
        request = type("Request", (), {})()
        request.headers = {"Host": "127.0.0.1:5000"}
        request.set_media_write_timeout = lambda: None
        request.send_text = lambda text, content_type, status=200: statuses.append(status)

        class Response:
            url = "https://pull.example.test/live/old.m3u8"

            def raise_for_status(self) -> None:
                return

            @property
            def text(self) -> str:
                with server_module.STATE.lock:
                    server_module.STATE.last_result = ResolveResult(
                        ok=True, is_live=True, selected_url="https://pull.example.test/live/new.m3u8", selected_type="hls"
                    )
                server_module.STATE.mark_source_changed()
                return "segment.ts"

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original_get = server_module.requests.get
        try:
            server_module.requests.get = lambda *args, **kwargs: Response()  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_hls_playlist(request, "https://pull.example.test/live/old.m3u8")
        finally:
            server_module.requests.get = original_get

        self.assertEqual([], list(server_module.STATE.allowed_hls_urls))
        self.assertIn(409, statuses)

    def test_playlist_response_applies_the_media_write_timeout(self) -> None:
        timeouts: list[float] = []
        request = type("Request", (), {})()
        request.headers = {"Host": "127.0.0.1:5000"}
        request.connection = type("Connection", (), {"settimeout": lambda self, value: timeouts.append(value)})()
        request.set_media_write_timeout = lambda: server_module.LocalProxyHandler.set_media_write_timeout(request)
        request.send_text = lambda *args, **kwargs: None

        class Response:
            url = "https://pull.example.test/live/index.m3u8"
            text = "segment.ts"

            def raise_for_status(self) -> None:
                return

            def __enter__(self):
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original_get = server_module.requests.get
        try:
            server_module.requests.get = lambda *args, **kwargs: Response()  # type: ignore[assignment]
            server_module.LocalProxyHandler.proxy_hls_playlist(request, Response.url)
        finally:
            server_module.requests.get = original_get

        self.assertIn(server_module.MEDIA_WRITE_TIMEOUT, timeouts)

    def test_authorized_old_playlist_is_not_fetched_after_the_source_switches(self) -> None:
        old_url = "https://pull.example.test/live/old-child.m3u8"
        statuses: list[object] = []
        request = type("Request", (), {})()
        request.path = "/hls/playlist?url=" + old_url.replace(":", "%3A").replace("/", "%2F")
        request.send_text = lambda text, content_type, status=200: statuses.append(status)
        original_get = server_module.requests.get
        try:
            self.assertTrue(server_module.STATE.register_hls_url(old_url, server_module.STATE.current_revisions()))
            with server_module.STATE.lock:
                server_module.STATE.last_result = ResolveResult(
                    ok=True, is_live=True, selected_url="https://pull.example.test/live/new.m3u8", selected_type="hls"
                )
            server_module.STATE.mark_source_changed()
            server_module.requests.get = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("stale HLS request fetched"))  # type: ignore[assignment]
            server_module.LocalProxyHandler.handle_hls_proxy(
                request,
                type("Parsed", (), {"query": request.path.split("?", 1)[1], "path": "/hls/playlist"})(),
                True,
            )
        finally:
            server_module.requests.get = original_get

        self.assertIn(403, statuses)


class StdoutReaderTests(unittest.TestCase):
    def test_stdout_reader_uses_read1_with_the_configured_chunk_size(self) -> None:
        calls: list[int] = []

        class Stdout:
            def read1(self, amount: int) -> bytes:
                calls.append(amount)
                return b"x" * amount if len(calls) == 1 else b""

        process = type("Process", (), {"stdout": Stdout()})()
        output: queue.Queue[bytes | None] = queue.Queue()
        stop_event = threading.Event()
        thread = server_module.start_stdout_reader(process, 4096, output, stop_event)
        thread.join(1)

        self.assertFalse(thread.is_alive())
        self.assertEqual(b"x" * 4096, output.get_nowait())
        self.assertEqual([4096, 4096], calls)


class ResolverStabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_resolver = server_module.resolve_platform_stream_async
        with server_module.STATE.lock:
            self.original_settings = server_module.STATE.settings
            self.original_result = server_module.STATE.last_result
            self.original_config_version = server_module.STATE.config_version
            self.original_source_version = server_module.STATE.source_version
            server_module.STATE.last_result = None
            server_module.STATE.config_version += 1
        with server_module.RESOLVE_CONDITION:
            if hasattr(server_module.RESOLVER_IN_FLIGHT, "clear"):
                server_module.RESOLVER_IN_FLIGHT.clear()
            else:
                server_module.RESOLVER_IN_FLIGHT = False
            server_module.RESOLVER_CONFIG_VERSION = -1
            server_module.RESOLVER_RETRY_AT = 0.0
            server_module.RESOLVER_RETRY_DELAY = 0.0
            server_module.RESOLVER_COMPLETED.clear()

    def tearDown(self) -> None:
        server_module.resolve_platform_stream_async = self.original_resolver
        with server_module.STATE.lock:
            server_module.STATE.settings = self.original_settings
            server_module.STATE.last_result = self.original_result
            server_module.STATE.config_version = self.original_config_version
            server_module.STATE.source_version = self.original_source_version
        with server_module.RESOLVE_CONDITION:
            if hasattr(server_module.RESOLVER_IN_FLIGHT, "clear"):
                server_module.RESOLVER_IN_FLIGHT.clear()
            else:
                server_module.RESOLVER_IN_FLIGHT = False
            server_module.RESOLVER_CONFIG_VERSION = -1
            server_module.RESOLVER_RETRY_AT = 0.0
            server_module.RESOLVER_RETRY_DELAY = 0.0
            server_module.RESOLVER_COMPLETED.clear()
            server_module.RESOLVE_CONDITION.notify_all()

    def test_concurrent_forced_resolves_share_one_platform_request(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        calls = {"count": 0}
        results: list[ResolveResult] = []

        async def resolve_once(settings: object) -> ResolveResult:
            calls["count"] += 1
            entered.set()
            await asyncio.to_thread(release.wait)
            return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/live.flv", selected_type="flv")

        server_module.resolve_platform_stream_async = resolve_once
        settings = server_module.ProxySettings(room_url="https://live.example.test/room")
        first = threading.Thread(target=lambda: results.append(server_module.resolve_stream(settings, force=True)))
        second = threading.Thread(target=lambda: results.append(server_module.resolve_stream(settings, force=True)))
        waiter_entered = threading.Event()
        original_wait = server_module.RESOLVE_CONDITION.wait

        def observed_wait(timeout: float | None = None) -> bool:
            waiter_entered.set()
            return original_wait(timeout)

        first.start()
        try:
            self.assertTrue(entered.wait(1))
            server_module.RESOLVE_CONDITION.wait = observed_wait  # type: ignore[method-assign]
            second.start()
            self.assertTrue(waiter_entered.wait(1))
        finally:
            release.set()
            first.join(2)
            second.join(2)
            server_module.RESOLVE_CONDITION.wait = original_wait  # type: ignore[method-assign]

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(1, calls["count"])
        self.assertEqual([True, True], sorted(result.ok for result in results))

    def test_stale_resolve_result_is_not_published_after_settings_change(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        results: list[ResolveResult] = []

        async def delayed_result(settings: object) -> ResolveResult:
            entered.set()
            await asyncio.to_thread(release.wait)
            return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/old.flv", selected_type="flv")

        server_module.resolve_platform_stream_async = delayed_result
        old_settings = server_module.ProxySettings(room_url="https://live.example.test/old")
        thread = threading.Thread(target=lambda: results.append(server_module.resolve_stream(old_settings, force=True)))
        thread.start()
        self.assertTrue(entered.wait(1))
        server_module.STATE.update_settings(server_module.ProxySettings(room_url="https://live.example.test/new"))
        release.set()
        thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertFalse(results[0].ok)
        self.assertIsNone(server_module.STATE.last_result)

    def test_config_switch_keeps_joiners_on_their_original_resolve_and_runs_each_revision_once(self) -> None:
        a_entered = threading.Event()
        release_a = threading.Event()
        calls: list[str] = []
        results: dict[str, ResolveResult] = {}

        async def per_revision(settings: server_module.ProxySettings) -> ResolveResult:
            calls.append(settings.room_url)
            if settings.room_url.endswith("/a"):
                a_entered.set()
                await asyncio.to_thread(release_a.wait)
                return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/a.flv", selected_type="flv")
            return ResolveResult(ok=False, error="b unavailable")

        server_module.resolve_platform_stream_async = per_revision
        settings_a = server_module.ProxySettings(room_url="https://live.example.test/a")
        settings_b = server_module.ProxySettings(room_url="https://live.example.test/b")
        server_module.STATE.update_settings(settings_a)
        primary = threading.Thread(target=lambda: results.update(primary=server_module.resolve_stream(settings_a, force=True)))
        joiner = threading.Thread(target=lambda: results.update(joiner=server_module.resolve_stream(settings_a, force=True)))
        joiner_waiting = threading.Event()
        original_wait = server_module.RESOLVE_CONDITION.wait

        def observed_wait(timeout: float | None = None) -> bool:
            joiner_waiting.set()
            return original_wait(timeout)

        primary.start()
        try:
            self.assertTrue(a_entered.wait(1))
            server_module.RESOLVE_CONDITION.wait = observed_wait  # type: ignore[method-assign]
            joiner.start()
            self.assertTrue(joiner_waiting.wait(1))
            server_module.STATE.update_settings(settings_b)
            results["b"] = server_module.resolve_stream(settings_b, force=True)
        finally:
            release_a.set()
            primary.join(2)
            joiner.join(2)
            server_module.RESOLVE_CONDITION.wait = original_wait  # type: ignore[method-assign]

        self.assertEqual(["https://live.example.test/a", "https://live.example.test/b"], calls)
        self.assertFalse(results["primary"].ok)
        self.assertFalse(results["joiner"].ok)
        self.assertFalse(results["b"].ok)

    def test_old_completion_cannot_clear_the_new_revision_retry_backoff(self) -> None:
        a_entered = threading.Event()
        release_a = threading.Event()
        calls: list[str] = []

        async def per_revision(settings: server_module.ProxySettings) -> ResolveResult:
            calls.append(settings.room_url)
            if settings.room_url.endswith("/a"):
                a_entered.set()
                await asyncio.to_thread(release_a.wait)
                return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/a.flv", selected_type="flv")
            return ResolveResult(ok=False, error="b unavailable")

        server_module.resolve_platform_stream_async = per_revision
        settings_a = server_module.ProxySettings(room_url="https://live.example.test/a")
        settings_b = server_module.ProxySettings(room_url="https://live.example.test/b")
        server_module.STATE.update_settings(settings_a)
        a_thread = threading.Thread(target=lambda: server_module.resolve_stream(settings_a, force=True))
        a_thread.start()
        self.assertTrue(a_entered.wait(1))
        server_module.STATE.update_settings(settings_b)
        server_module.resolve_stream(settings_b, force=True)
        release_a.set()
        a_thread.join(2)
        server_module.resolve_stream(settings_b, force=False)

        self.assertEqual(["https://live.example.test/a", "https://live.example.test/b"], calls)

    def test_completed_resolve_results_are_bounded_across_many_settings_revisions(self) -> None:
        async def always_fail(settings: server_module.ProxySettings) -> ResolveResult:
            return ResolveResult(ok=False, error="offline")

        server_module.resolve_platform_stream_async = always_fail
        for index in range(server_module.MAX_RESOLVER_COMPLETED + 10):
            settings = server_module.ProxySettings(room_url=f"https://live.example.test/{index}")
            server_module.STATE.update_settings(settings)
            server_module.resolve_stream(settings, force=True)

        self.assertLessEqual(len(server_module.RESOLVER_COMPLETED), server_module.MAX_RESOLVER_COMPLETED)

    def test_joiner_ignores_a_previous_completion_while_a_new_attempt_is_in_flight(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        waiting = threading.Event()
        results: list[ResolveResult] = []

        async def delayed_success(settings: server_module.ProxySettings) -> ResolveResult:
            entered.set()
            await asyncio.to_thread(release.wait)
            return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/live.flv", selected_type="flv")

        server_module.resolve_platform_stream_async = delayed_success
        settings = server_module.ProxySettings(room_url="https://live.example.test/room")
        server_module.STATE.update_settings(settings)
        config_version = server_module.STATE.config_version
        with server_module.RESOLVE_CONDITION:
            server_module.RESOLVER_COMPLETED[config_version] = ResolveResult(ok=False, error="previous failure")
        original_wait = server_module.RESOLVE_CONDITION.wait

        def observed_wait(timeout: float | None = None) -> bool:
            waiting.set()
            return original_wait(timeout)

        primary = threading.Thread(target=lambda: results.append(server_module.resolve_stream(settings, force=True)))
        joiner = threading.Thread(target=lambda: results.append(server_module.resolve_stream(settings, force=True)))
        primary.start()
        try:
            self.assertTrue(entered.wait(1))
            server_module.RESOLVE_CONDITION.wait = observed_wait  # type: ignore[method-assign]
            joiner.start()
            self.assertTrue(waiting.wait(1))
            with server_module.RESOLVE_CONDITION:
                server_module.RESOLVE_CONDITION.notify_all()
            self.assertTrue(joiner.is_alive())
        finally:
            release.set()
            primary.join(2)
            joiner.join(2)
            server_module.RESOLVE_CONDITION.wait = original_wait  # type: ignore[method-assign]

        self.assertEqual([True, True], sorted(result.ok for result in results))

    def test_failure_backoff_doubles_to_the_configured_maximum(self) -> None:
        async def always_fail(settings: server_module.ProxySettings) -> ResolveResult:
            return ResolveResult(ok=False, error="offline")

        server_module.resolve_platform_stream_async = always_fail
        settings = server_module.ProxySettings(room_url="https://live.example.test/room")
        server_module.STATE.update_settings(settings)
        observed: list[float] = []
        for _ in range(5):
            server_module.resolve_stream(settings, force=True)
            observed.append(server_module.RESOLVER_RETRY_DELAY)

        self.assertEqual([1.0, 2.0, 4.0, 8.0, 15.0], observed)

    def test_forced_resolve_bypasses_retry_deadline(self) -> None:
        calls: list[None] = []

        async def succeeds(settings: server_module.ProxySettings) -> ResolveResult:
            calls.append(None)
            return ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/live.flv", selected_type="flv")

        server_module.resolve_platform_stream_async = succeeds
        settings = server_module.ProxySettings(room_url="https://live.example.test/room")
        server_module.STATE.update_settings(settings)
        with server_module.RESOLVE_CONDITION:
            server_module.RESOLVER_RETRY_VERSION = server_module.STATE.config_version
            server_module.RESOLVER_RETRY_AT = float("inf")

        result = server_module.resolve_stream(settings, force=True)

        self.assertTrue(result.ok)
        self.assertEqual([None], calls)


class StreamBindingTests(unittest.TestCase):
    def test_binding_rejects_a_resolve_that_finishes_behind_a_newer_source(self) -> None:
        old = ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/old.flv", selected_type="flv")
        newer = ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/new.flv", selected_type="flv")
        original_resolver = server_module.resolve_douyin_stream
        with server_module.STATE.lock:
            original_result = server_module.STATE.last_result
            original_source_version = server_module.STATE.source_version
            server_module.STATE.last_result = newer
            server_module.STATE.source_version = 22
        try:
            server_module.resolve_douyin_stream = lambda settings, force: old
            result, source_version, _config_version, _generation = server_module.resolve_stream_binding(
                server_module.ProxySettings(), force=False
            )
        finally:
            server_module.resolve_douyin_stream = original_resolver
            with server_module.STATE.lock:
                server_module.STATE.last_result = original_result
                server_module.STATE.source_version = original_source_version

        self.assertFalse(result.ok)
        self.assertEqual(22, source_version)

    def test_binding_rejects_a_result_when_settings_change_before_the_binding_fence_is_read(self) -> None:
        result_a = ResolveResult(ok=True, is_live=True, selected_url="https://pull.example.test/a.flv", selected_type="flv")
        original_resolver = server_module.resolve_douyin_stream
        with server_module.STATE.lock:
            original_settings = server_module.STATE.settings
            original_result = server_module.STATE.last_result
            original_config_version = server_module.STATE.config_version
        try:
            def resolve_then_switch(settings: server_module.ProxySettings, force: bool) -> ResolveResult:
                server_module.STATE.update_settings(server_module.ProxySettings(room_url="https://live.example.test/b"))
                return result_a

            server_module.resolve_douyin_stream = resolve_then_switch
            result, _source_version, config_version, _generation = server_module.resolve_stream_binding(
                server_module.ProxySettings(room_url="https://live.example.test/a"), force=False
            )
        finally:
            server_module.resolve_douyin_stream = original_resolver
            with server_module.STATE.lock:
                server_module.STATE.settings = original_settings
                server_module.STATE.last_result = original_result
                server_module.STATE.config_version = original_config_version

        self.assertFalse(result.ok)
        self.assertEqual(config_version, original_config_version + 1)


class _BrokenWriter:
    def write(self, data: bytes) -> int:
        raise BrokenPipeError()

    def flush(self) -> None:
        return


class _OneChunkResponse:
    headers = {"Content-Type": "video/x-flv"}

    def __init__(self, chunk: bytes) -> None:
        self.chunk = chunk

    def raise_for_status(self) -> None:
        return

    def iter_content(self, chunk_size: int):
        yield self.chunk

    def __enter__(self):
        return self

    def __exit__(self, *args: object) -> None:
        return None


class _SwitchSourceWriter:
    def __init__(self, newer: ResolveResult) -> None:
        self.newer = newer

    def write(self, data: bytes) -> int:
        with server_module.STATE.lock:
            server_module.STATE.last_result = self.newer
        server_module.STATE.mark_source_changed()
        return len(data)

    def flush(self) -> None:
        return


def _media_request(wfile: object | None = None) -> object:
    request = type("Request", (), {})()
    request.headers = {}
    request.wfile = wfile or io.BytesIO()
    request.send_response = lambda status: None
    request.send_header = lambda name, value: None
    request.end_headers = lambda: None
    request.set_media_write_timeout = lambda: None
    return request


if __name__ == "__main__":
    unittest.main()
