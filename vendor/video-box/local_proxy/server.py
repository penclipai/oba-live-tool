from __future__ import annotations

import argparse
import atexit
import asyncio
from collections import OrderedDict
import configparser
import copy
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from dataclasses import asdict, dataclass
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse

import requests

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

try:
    import msvcrt
except ImportError:  # pragma: no cover - Windows distribution path uses msvcrt.
    msvcrt = None  # type: ignore[assignment]


if getattr(sys, "frozen", False):
    BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    DEFAULT_DATA_DIR = Path(sys.executable).resolve().parent
else:
    BUNDLE_ROOT = Path(__file__).resolve().parents[1]
    DEFAULT_DATA_DIR = BUNDLE_ROOT


def data_directory(value: str | None = None) -> Path:
    """Return the writable runtime directory without ever writing into the bundle."""
    candidate = value or os.environ.get("VIDEO_BOX_DATA_DIR")
    return Path(candidate).expanduser().resolve() if candidate else DEFAULT_DATA_DIR


PROJECT_ROOT = data_directory()

RECORDER_ROOT = BUNDLE_ROOT / "DouyinLiveRecorder"
CONFIG_DIR = PROJECT_ROOT / "config"
CONFIG_FILE = CONFIG_DIR / "local_proxy.ini"
INSTANCE_LOCK_FILE = CONFIG_DIR / "video-box.lock"
INSTANCE_INFO_FILE = CONFIG_DIR / "instance.json"
_INSTANCE_LOCK_HANDLE: Any | None = None

if str(RECORDER_ROOT) not in sys.path:
    sys.path.insert(0, str(RECORDER_ROOT))


QUALITY_MAPPING = {
    "original": "OD",
    "blue": "BD",
    "uhd": "UHD",
    "hd": "HD",
    "sd": "SD",
    "ld": "LD",
    "原画": "OD",
    "蓝光": "BD",
    "超清": "UHD",
    "高清": "HD",
    "标清": "SD",
    "流畅": "LD",
}

OUTPUT_MODES = {"auto", "hls", "transcode", "flv"}
HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl; charset=utf-8"
FLV_CONTENT_TYPE = "video/x-flv"
TS_CONTENT_TYPE = "video/mp2t"
VENDORED_FFMPEG = Path("vendor") / "ffmpeg" / "bin" / "ffmpeg.exe"
LOCAL_CONTROL_HOST = "127.0.0.1"


@dataclass
class ProxySettings:
    room_url: str = ""
    quality: str = "OD"
    output_mode: str = "auto"
    listen_host: str = "0.0.0.0"
    port: int = 5000
    cookie: str = ""
    upstream_proxy: str = ""
    chunk_size: int = 16384
    transcode_preset: str = "veryfast"


@dataclass
class ResolveResult:
    ok: bool
    platform: str = ""
    is_live: bool = False
    anchor_name: str = ""
    title: str = ""
    quality: str = ""
    flv_url: str = ""
    m3u8_url: str = ""
    selected_url: str = ""
    selected_type: str = ""
    codec: str = ""
    hevc: bool = False
    output_mode: str = "auto"
    error: str = ""
    resolved_at: float = 0.0


class PayloadTooLarge(Exception):
    pass


class HLSRegistryFull(Exception):
    pass


class HLSStalePlaylist(Exception):
    pass


@dataclass
class ResolverAttempt:
    attempt_id: int
    done: bool = False
    result: ResolveResult | None = None


class ProxyState:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.last_result: ResolveResult | None = None
        self.last_resolve_error: ResolveResult | None = None
        self.resolved_source_identity: tuple[str, str] | None = None
        self.active_clients: dict[str, float] = {}
        self.stream_enabled = True
        self.stream_generation = 0
        self.source_version = 0
        self.started_at = time.time()
        self.logs: list[dict[str, Any]] = []
        # URL -> monotonic expiry.  This is deliberately bounded: live HLS
        # manifests normally contain a rolling window, while signed segment
        # URLs can otherwise grow this process forever.
        self.allowed_hls_urls: OrderedDict[str, float] = OrderedDict()
        self.config_version = 0
        self.lock = threading.RLock()

    def log(self, level: str, message: str) -> None:
        with self.lock:
            self.logs.append({"time": time.time(), "level": level, "message": message})
            self.logs = self.logs[-120:]

    def register_client(self) -> str:
        client_id = uuid.uuid4().hex
        with self.lock:
            self.active_clients[client_id] = time.time()
        return client_id

    def unregister_client(self, client_id: str) -> None:
        with self.lock:
            self.active_clients.pop(client_id, None)

    def touch_client(self, client_id: str) -> None:
        with self.lock:
            if client_id in self.active_clients:
                self.active_clients[client_id] = time.time()

    def active_client_count(self) -> int:
        with self.lock:
            return len(self.active_clients)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            current = self.last_result or self.last_resolve_error
            result = asdict(current) if current else None
            return {
                "service_id": "oba-video-relay",
                "protocol_version": 1,
                "settings": safe_settings_dict(self.settings),
                "result": result,
                "active_clients": self.active_client_count(),
                "stream_enabled": self.stream_enabled,
                "stream_generation": self.stream_generation,
                "source_version": self.source_version,
                "uptime_seconds": int(time.time() - self.started_at),
                "obs_url": f"http://127.0.0.1:{self.settings.port}/live",
                "lan_urls": get_lan_urls(self.settings.port),
                "logs": list(self.logs[-30:]),
            }

    def start_stream(self) -> None:
        with self.lock:
            self.stream_enabled = True
            self.stream_generation += 1
            self.last_result = None
            self.last_resolve_error = None
            self.allowed_hls_urls.clear()
        self.log("info", "代理输出已启动。")

    def stop_stream(self) -> None:
        with self.lock:
            self.stream_enabled = False
            self.stream_generation += 1
        self.log("info", "代理输出已停止，当前 OBS 连接将断开。")

    def current_generation(self) -> int:
        with self.lock:
            return self.stream_generation

    def current_source_version(self) -> int:
        with self.lock:
            return self.source_version

    def mark_source_changed(self) -> int:
        with self.lock:
            self.source_version += 1
            self.allowed_hls_urls.clear()
            source_version = self.source_version
        self.log("info", f"直播源已切换到版本 {source_version}。")
        return source_version

    def current_source(self) -> tuple[int, ResolveResult | None]:
        with self.lock:
            return self.source_version, self.last_result

    def current_revisions(self) -> tuple[int, int]:
        with self.lock:
            return self.config_version, self.source_version

    def should_continue_stream(self, generation: int) -> bool:
        with self.lock:
            return self.stream_enabled and self.stream_generation == generation

    def update_settings(self, settings: ProxySettings) -> int:
        with self.lock:
            self.settings = settings
            self.config_version += 1
            self.last_result = None
            self.last_resolve_error = None
            self.allowed_hls_urls.clear()
            return self.config_version

    def invalidate_result(
        self,
        message: str,
        expected_revisions: tuple[int, int] | None = None,
        expected_identity: tuple[str, str] | None = None,
    ) -> bool:
        with self.lock:
            if expected_revisions and (self.config_version, self.source_version) != expected_revisions:
                return False
            if expected_identity:
                result = self.last_result
                if not result or (result.selected_type, result.selected_url) != expected_identity:
                    return False
            self.last_result = None
        self.log("error", message)
        return True

    def register_hls_url(self, url: str, expected_revisions: tuple[int, int] | None = None) -> bool:
        now = time.monotonic()
        with self.lock:
            if expected_revisions and (self.config_version, self.source_version) != expected_revisions:
                raise HLSStalePlaylist("直播源已切换，请重新加载播放列表。")
            self._expire_hls_urls(now)
            if url in self.allowed_hls_urls:
                self.allowed_hls_urls.move_to_end(url)
                self.allowed_hls_urls[url] = now + HLS_URL_TTL
                return True
            while len(self.allowed_hls_urls) >= MAX_HLS_URLS:
                self.allowed_hls_urls.popitem(last=False)
            self.allowed_hls_urls[url] = now + HLS_URL_TTL
            return True

    def _expire_hls_urls(self, now: float) -> None:
        while self.allowed_hls_urls:
            _, expiry = next(iter(self.allowed_hls_urls.items()))
            if expiry > now:
                break
            self.allowed_hls_urls.popitem(last=False)

    def is_registered_hls_url(self, url: str) -> bool:
        with self.lock:
            self._expire_hls_urls(time.monotonic())
            if url not in self.allowed_hls_urls:
                return False
            if self.allowed_hls_urls[url] <= time.monotonic():
                self.allowed_hls_urls.pop(url, None)
                return False
            self.allowed_hls_urls.move_to_end(url)
            self.allowed_hls_urls[url] = time.monotonic() + HLS_URL_TTL
            return True


def safe_settings_dict(settings: ProxySettings) -> dict[str, Any]:
    data = asdict(settings)
    data["cookie"] = "configured" if settings.cookie else ""
    return data


def normalize_quality(value: str) -> str:
    value = (value or "OD").strip()
    return QUALITY_MAPPING.get(value, value.upper())


def normalize_mode(value: str) -> str:
    value = (value or "auto").strip().lower()
    return value if value in OUTPUT_MODES else "auto"


def load_settings(path: Path | None = None) -> ProxySettings:
    target = path or CONFIG_FILE
    settings = ProxySettings()
    if not target.exists():
        return settings

    parser = configparser.ConfigParser(interpolation=None)
    parser.read(target, encoding="utf-8-sig")
    section = parser["local_proxy"] if parser.has_section("local_proxy") else {}
    settings.room_url = section.get("room_url", settings.room_url).strip()
    settings.quality = normalize_quality(section.get("quality", settings.quality))
    settings.output_mode = normalize_mode(section.get("output_mode", settings.output_mode))
    settings.listen_host = section.get("listen_host", settings.listen_host).strip() or settings.listen_host
    settings.port = parse_int(section.get("port"), settings.port, 1, 65535)
    settings.cookie = section.get("cookie", settings.cookie)
    settings.upstream_proxy = section.get("upstream_proxy", settings.upstream_proxy).strip()
    settings.chunk_size = parse_int(section.get("chunk_size"), settings.chunk_size, 4096, 1024 * 1024)
    settings.transcode_preset = section.get("transcode_preset", settings.transcode_preset).strip() or "veryfast"
    return settings


def save_settings(settings: ProxySettings, path: Path | None = None) -> None:
    target = path or CONFIG_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    parser = configparser.ConfigParser(interpolation=None)
    parser["local_proxy"] = {k: str(v) for k, v in asdict(settings).items()}
    with target.open("w", encoding="utf-8-sig") as fp:
        parser.write(fp)


def parse_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed < min_value or parsed > max_value:
        return default
    return parsed


STATE = ProxyState()
RESOLVE_LOCK = threading.Lock()
RESOLVE_CONDITION = threading.Condition(RESOLVE_LOCK)
RESOLVER_IN_FLIGHT: set[int] = set()
RESOLVER_ACTIVE: dict[int, ResolverAttempt] = {}
RESOLVER_ATTEMPT_ID = 0
RESOLVER_CONFIG_VERSION = -1
RESOLVER_RETRY_VERSION = -1
RESOLVER_RETRY_AT = 0.0
RESOLVER_RETRY_DELAY = 0.0
RESOLVER_COMPLETED: dict[int, ResolveResult] = {}
RESOLVE_CACHE_TTL = 15.0
STREAM_RETRY_BASE_DELAY = 1.0
STREAM_RETRY_MAX_DELAY = 15.0
TRANSCODE_START_TIMEOUT = 12.0
TRANSCODE_SILENCE_TIMEOUT = 15.0
TRANSCODE_READ_TIMEOUT = 0.5
MEDIA_WRITE_TIMEOUT = 10.0
HLS_URL_TTL = 180.0
MAX_HLS_URLS = 4096
MAX_RESOLVER_COMPLETED = 64
MAX_LIVE_CLIENTS = 4
MAX_HLS_REQUESTS = 32
MAX_API_BODY_BYTES = 64 * 1024
LIVE_CLIENTS = threading.BoundedSemaphore(MAX_LIVE_CLIENTS)
HLS_REQUESTS = threading.BoundedSemaphore(MAX_HLS_REQUESTS)


def get_lan_urls(port: int) -> list[str]:
    urls: list[str] = []
    try:
        hostname = socket.gethostname()
        for item in socket.getaddrinfo(hostname, None, socket.AF_INET):
            sockaddr = item[4]
            if not isinstance(sockaddr, tuple) or not sockaddr:
                continue
            ip = sockaddr[0]
            if not isinstance(ip, str):
                continue
            if ip.startswith("127."):
                continue
            url = f"http://{ip}:{port}/live"
            if url not in urls:
                urls.append(url)
    except OSError:
        pass
    return urls


def control_panel_url(port: int) -> str:
    return f"http://{LOCAL_CONTROL_HOST}:{port}/"


def configure_data_dir(value: str) -> None:
    """Move settings and instance metadata to the caller-selected writable directory."""
    global PROJECT_ROOT, CONFIG_DIR, CONFIG_FILE, INSTANCE_LOCK_FILE, INSTANCE_INFO_FILE
    PROJECT_ROOT = data_directory(value)
    CONFIG_DIR = PROJECT_ROOT / "config"
    CONFIG_FILE = CONFIG_DIR / "local_proxy.ini"
    INSTANCE_LOCK_FILE = CONFIG_DIR / "video-box.lock"
    INSTANCE_INFO_FILE = CONFIG_DIR / "instance.json"
    os.environ["VIDEO_BOX_DATA_DIR"] = str(PROJECT_ROOT)


def is_local_client(host: str) -> bool:
    return host in {"127.0.0.1", "::1"}


def is_existing_instance(port: int) -> bool:
    try:
        response = requests.get(f"{control_panel_url(port)}api/status", timeout=0.8)
        if response.status_code != HTTPStatus.OK:
            return False
        data = response.json()
        return (
            isinstance(data, dict)
            and data.get("service_id") == "oba-video-relay"
            and data.get("protocol_version") == 1
            and "obs_url" in data
            and "settings" in data
        )
    except (OSError, ValueError, requests.RequestException):
        return False


def read_instance_port(default_port: int) -> int:
    try:
        data = json.loads(INSTANCE_INFO_FILE.read_text(encoding="utf-8"))
        return parse_int(data.get("port"), default_port, 1, 65535)
    except (OSError, ValueError):
        return default_port


def write_instance_info(port: int) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = {"port": port, "url": control_panel_url(port), "pid": os.getpid(), "started_at": time.time()}
    INSTANCE_INFO_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def acquire_instance_lock(port: int) -> bool:
    global _INSTANCE_LOCK_HANDLE
    if _INSTANCE_LOCK_HANDLE is not None:
        return True
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        handle = INSTANCE_LOCK_FILE.open("r+b")
    except FileNotFoundError:
        handle = INSTANCE_LOCK_FILE.open("w+b")
    try:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        if msvcrt is not None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            try:
                os.mkdir(str(INSTANCE_LOCK_FILE) + ".dir")
            except FileExistsError:
                handle.close()
                return False
        _INSTANCE_LOCK_HANDLE = handle
        write_instance_info(port)
        atexit.register(release_instance_lock)
        return True
    except OSError:
        handle.close()
        return False


def release_instance_lock() -> None:
    global _INSTANCE_LOCK_HANDLE
    handle = _INSTANCE_LOCK_HANDLE
    _INSTANCE_LOCK_HANDLE = None
    if handle is None:
        return
    try:
        if msvcrt is not None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    finally:
        handle.close()


def open_control_panel(port: int, delay: float = 0.25) -> None:
    def opener() -> None:
        try:
            webbrowser.open(control_panel_url(port))
        except Exception as exc:  # pragma: no cover - browser integration depends on host OS.
            STATE.log("error", f"Could not open browser: {exc}")

    if delay <= 0:
        opener()
        return
    timer = threading.Timer(delay, opener)
    timer.daemon = True
    timer.start()


def safe_print(message: str) -> None:
    try:
        print(message)
    except (AttributeError, OSError, ValueError):
        return


def load_recorder_modules() -> tuple[Any, Any, Any]:
    try:
        from src import spider, stream, utils  # type: ignore
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "DouyinLiveRecorder dependencies are missing. Run this proxy with the recorder virtual environment "
            "or install DouyinLiveRecorder/requirements.txt."
        ) from exc
    return spider, stream, utils


def handle_proxy_addr(upstream_proxy: str) -> str | None:
    _, _, recorder_utils = load_recorder_modules()
    return recorder_utils.handle_proxy_addr(upstream_proxy)


def codec_from_url(url: str) -> str:
    if not url:
        return ""
    codec = parse_qs(urlparse(url).query).get("codec", [""])[0]
    return normalize_codec(codec)


def normalize_codec(value: Any) -> str:
    codec = str(value or "").strip().lower()
    if codec in {"h264", "h.264", "avc", "avc1", "264"}:
        return "h264"
    if codec in {"h265", "h.265", "hevc", "hev1", "hvc1", "265"}:
        return "h265"
    return codec


def is_hevc_codec(codec: str) -> bool:
    return normalize_codec(codec) == "h265"


def extract_douyin_codec(json_data: dict[str, Any], quality: str) -> str:
    stream_url = json_data.get("stream_url") or {}
    raw_sources: list[Any] = []
    live_core = stream_url.get("live_core_sdk_data") or {}
    raw_sources.append(((live_core.get("pull_data") or {}).get("stream_data")))
    pull_datas = stream_url.get("pull_datas") or {}
    if isinstance(pull_datas, dict):
        raw_sources.extend(
            item.get("stream_data")
            for item in pull_datas.values()
            if isinstance(item, dict)
        )

    stream_data_items: list[dict[str, Any]] = []
    for raw_source in raw_sources:
        if not raw_source:
            continue
        try:
            parsed = json.loads(raw_source) if isinstance(raw_source, str) else raw_source
        except (TypeError, ValueError):
            continue
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if isinstance(data, dict):
            stream_data_items.append(data)

    for key in get_quality_order(quality):
        for item in stream_data_items:
            main = item.get(key, {}).get("main") if isinstance(item.get(key), dict) else None
            codec = extract_sdk_codec(main)
            if codec:
                return codec

    for item in stream_data_items:
        for entry in item.values():
            main = entry.get("main") if isinstance(entry, dict) else None
            codec = extract_sdk_codec(main)
            if codec:
                return codec
    return ""


def extract_sdk_codec(main: Any) -> str:
    if not isinstance(main, dict):
        return ""
    sdk_params = main.get("sdk_params") or {}
    if isinstance(sdk_params, str):
        try:
            sdk_params = json.loads(sdk_params)
        except (TypeError, ValueError):
            return ""
    if not isinstance(sdk_params, dict):
        return ""
    return normalize_codec(sdk_params.get("VCodec") or sdk_params.get("vcodec") or sdk_params.get("codec"))


def get_quality_order(quality: str) -> list[str]:
    ordered = ["origin", "uhd", "hd", "sd", "ld"]
    quality_to_key = {"OD": "origin", "BD": "origin", "UHD": "uhd", "HD": "hd", "SD": "sd", "LD": "ld"}
    preferred = quality_to_key.get(normalize_quality(quality), "origin")
    return [preferred] + [item for item in ordered if item != preferred]


@dataclass(frozen=True)
class PlatformResolver:
    name: str
    patterns: tuple[str, ...]
    resolver: Any


def enrich_douyin_stream_info(
    stream_info: dict[str, Any],
    json_data: dict[str, Any],
    quality: str,
) -> dict[str, Any]:
    enriched = copy.copy(stream_info)
    if not enriched.get("codec"):
        enriched["codec"] = extract_douyin_codec(json_data, quality)
    return enriched


def choose_stream(stream_info: dict[str, Any], output_mode: str, platform: str = "") -> ResolveResult:
    mode = normalize_mode(output_mode)
    flv_url = stream_info.get("flv_url") or ""
    m3u8_url = stream_info.get("m3u8_url") or stream_info.get("record_url") or ""
    codec = normalize_codec(stream_info.get("codec")) or codec_from_url(flv_url)
    hevc = is_hevc_codec(codec)

    selected_url = ""
    selected_type = ""
    if mode == "transcode":
        selected_url = flv_url or m3u8_url
        selected_type = "transcode"
    elif mode == "hls":
        selected_url = m3u8_url or flv_url
        selected_type = "hls" if selected_url == m3u8_url else "flv"
    elif mode == "flv":
        selected_url = flv_url or m3u8_url
        selected_type = "flv" if selected_url == flv_url else "hls"
    else:
        if flv_url and not hevc:
            selected_url = flv_url
            selected_type = "flv"
        else:
            selected_url = m3u8_url or flv_url
            selected_type = "hls" if selected_url == m3u8_url else "flv"

    return ResolveResult(
        ok=bool(selected_url),
        platform=platform,
        is_live=bool(stream_info.get("is_live")),
        anchor_name=stream_info.get("anchor_name") or "",
        title=stream_info.get("title") or "",
        quality=stream_info.get("quality") or "",
        flv_url=flv_url,
        m3u8_url=m3u8_url,
        selected_url=selected_url,
        selected_type=selected_type,
        codec=codec,
        hevc=hevc,
        output_mode=mode,
        error="" if selected_url else "没有解析到可播放的上游直播地址。",
        resolved_at=time.time(),
    )


def normalize_platform_stream_info(stream_info: Any, platform: str, source_url: str) -> dict[str, Any]:
    if isinstance(stream_info, str):
        stream_info = {"record_url": stream_info}
    if not isinstance(stream_info, dict):
        return {"anchor_name": platform, "is_live": False}

    normalized = copy.copy(stream_info)
    normalized.setdefault("anchor_name", platform)

    record_url = normalized.get("record_url") or normalized.get("url") or normalized.get("play_url") or ""
    flv_url = normalized.get("flv_url") or ""
    m3u8_url = normalized.get("m3u8_url") or ""
    if record_url and not flv_url and ".flv" in record_url.lower():
        flv_url = record_url
    if record_url and not m3u8_url and ".m3u8" in record_url.lower():
        m3u8_url = record_url
    if not record_url:
        record_url = flv_url or m3u8_url

    normalized["record_url"] = record_url
    normalized["flv_url"] = flv_url
    normalized["m3u8_url"] = m3u8_url
    normalized["is_live"] = bool(normalized.get("is_live") or record_url)
    normalized.setdefault("title", "")
    normalized.setdefault("quality", "")
    if not normalized.get("anchor_name"):
        normalized["anchor_name"] = platform or source_url
    return normalized


def direct_source_info(url: str) -> dict[str, Any] | None:
    lower_url = url.lower()
    if ".flv" not in lower_url and ".m3u8" not in lower_url:
        return None
    info = {
        "anchor_name": f"自定义直播源_{uuid.uuid4().hex[:8]}",
        "is_live": True,
        "record_url": url,
    }
    if ".flv" in lower_url:
        info["flv_url"] = url
    else:
        info["m3u8_url"] = url
    return info


def get_platform_resolver(url: str) -> PlatformResolver | None:
    lower_url = url.lower()
    for resolver in PLATFORM_RESOLVERS:
        if any(pattern in lower_url for pattern in resolver.patterns):
            return resolver
    return None


async def get_douyin_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    if "v.douyin.com" not in settings.room_url and "/user/" not in settings.room_url:
        json_data = await recorder_spider.get_douyin_web_stream_data(
            url=settings.room_url,
            proxy_addr=proxy_addr,
            cookies=settings.cookie,
        )
    else:
        json_data = await recorder_spider.get_douyin_app_stream_data(
            url=settings.room_url,
            proxy_addr=proxy_addr,
            cookies=settings.cookie,
        )
    stream_info = await recorder_stream.get_douyin_stream_url(json_data, normalize_quality(settings.quality), proxy_addr)
    return enrich_douyin_stream_info(stream_info, json_data, settings.quality)


async def get_tiktok_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_tiktok_stream_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    return await recorder_stream.get_tiktok_stream_url(json_data, normalize_quality(settings.quality), proxy_addr)


async def get_kuaishou_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_kuaishou_stream_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    return await recorder_stream.get_kuaishou_stream_url(json_data, normalize_quality(settings.quality))


async def get_huya_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    quality = normalize_quality(settings.quality)
    if quality not in {"OD", "BD", "UHD"}:
        json_data = await recorder_spider.get_huya_stream_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
        return await recorder_stream.get_huya_stream_url(json_data, quality)
    return await recorder_spider.get_huya_app_stream_url(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)


async def get_douyu_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_douyu_info_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    return await recorder_stream.get_douyu_stream_url(
        json_data,
        video_quality=normalize_quality(settings.quality),
        cookies=settings.cookie,
        proxy_addr=proxy_addr,
    )


async def get_yy_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_yy_stream_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    return await recorder_stream.get_yy_stream_url(json_data)


async def get_bilibili_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_bilibili_room_info(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    stream_info = await recorder_stream.get_bilibili_stream_url(
        json_data,
        video_quality=normalize_quality(settings.quality),
        proxy_addr=proxy_addr,
        cookies=settings.cookie,
    )
    if stream_info.get("is_live") and (stream_info.get("record_url") or stream_info.get("flv_url") or stream_info.get("m3u8_url")):
        return stream_info
    return get_bilibili_port_info_fallback(settings, proxy_addr)


def get_bilibili_room_id(url: str) -> str:
    return url.split("?")[0].rstrip("/").rsplit("/", maxsplit=1)[-1]


def get_bilibili_json(api: str, proxy_addr: str | None, cookies: str = "", **params: str) -> dict[str, Any]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
        "Accept-Language": "zh-CN,zh;q=0.8,en;q=0.6",
        "Referer": "https://live.bilibili.com/",
    }
    if cookies:
        headers["Cookie"] = cookies
    response = requests.get(api, params=params, headers=headers, proxies=proxy_map(proxy_addr or ""), timeout=20)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("B 站接口返回格式异常")
    return data


def build_bilibili_stream_info_from_play_data(play_data: dict[str, Any]) -> dict[str, str]:
    playurl = ((play_data.get("playurl_info") or {}).get("playurl") or {})
    flv_url = ""
    m3u8_url = ""
    fallback_flv = ""
    fallback_m3u8 = ""
    for stream_item in playurl.get("stream") or []:
        protocol_name = str(stream_item.get("protocol_name") or "")
        for format_item in stream_item.get("format") or []:
            format_name = str(format_item.get("format_name") or "")
            for codec_item in format_item.get("codec") or []:
                base_url = codec_item.get("base_url")
                url_info = (codec_item.get("url_info") or [{}])[0]
                if not base_url or not isinstance(url_info, dict):
                    continue
                full_url = f"{url_info.get('host', '')}{base_url}{url_info.get('extra', '')}"
                if not full_url:
                    continue
                codec_name = str(codec_item.get("codec_name") or "")
                is_avc = codec_name in {"avc", "h264"}
                if (protocol_name == "http_stream" or format_name == "flv" or ".flv" in full_url) and not fallback_flv:
                    fallback_flv = full_url
                if (protocol_name == "http_hls" or ".m3u8" in full_url) and not fallback_m3u8:
                    fallback_m3u8 = full_url
                if is_avc and (protocol_name == "http_stream" or format_name == "flv" or ".flv" in full_url) and not flv_url:
                    flv_url = full_url
                if is_avc and (protocol_name == "http_hls" or ".m3u8" in full_url) and not m3u8_url:
                    m3u8_url = full_url
    return {"flv_url": flv_url or fallback_flv, "m3u8_url": m3u8_url or fallback_m3u8}


def get_bilibili_port_info_fallback(settings: ProxySettings, proxy_addr: str | None) -> dict[str, Any]:
    requested_room_id = get_bilibili_room_id(settings.room_url)
    room_data = get_bilibili_json(
        "https://api.live.bilibili.com/room/v1/Room/room_init",
        proxy_addr,
        settings.cookie,
        id=requested_room_id,
    )
    room_info = room_data.get("data") or {}
    room_id = str(room_info.get("room_id") or requested_room_id)
    live_status = room_info.get("live_status") == 1
    anchor_name = "B站直播"
    uid = room_info.get("uid")
    if uid:
        try:
            anchor_data = get_bilibili_json(
                "https://api.live.bilibili.com/live_user/v1/Master/info",
                proxy_addr,
                settings.cookie,
                uid=str(uid),
            )
            anchor_name = (((anchor_data.get("data") or {}).get("info") or {}).get("uname")) or anchor_name
        except (requests.RequestException, ValueError, KeyError, TypeError):
            pass
    if not live_status:
        return {"anchor_name": anchor_name, "is_live": False, "room_url": settings.room_url}

    play_data = get_bilibili_json(
        "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo",
        proxy_addr,
        settings.cookie,
        room_id=room_id,
        protocol="0,1",
        format="0,1,2",
        codec="0,1",
        qn="10000",
        platform="web",
        ptype="8",
    )
    stream_urls = build_bilibili_stream_info_from_play_data(play_data.get("data") or {})
    return {
        "anchor_name": anchor_name,
        "is_live": bool(stream_urls.get("flv_url") or stream_urls.get("m3u8_url")),
        "title": "",
        "quality": normalize_quality(settings.quality),
        "flv_url": stream_urls.get("flv_url") or "",
        "m3u8_url": stream_urls.get("m3u8_url") or "",
        "record_url": stream_urls.get("flv_url") or stream_urls.get("m3u8_url") or "",
    }


async def get_stream_url_port_info(
    settings: ProxySettings,
    proxy_addr: str | None,
    recorder_spider: Any,
    recorder_stream: Any,
    spider_name: str,
    **stream_kwargs: Any,
) -> dict[str, Any]:
    json_data = await getattr(recorder_spider, spider_name)(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    if isinstance(json_data, dict) and ("play_url_list" not in json_data or not json_data.get("is_live", True)):
        return json_data
    return await recorder_stream.get_stream_url(json_data, normalize_quality(settings.quality), **stream_kwargs)


async def get_netease_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, recorder_stream: Any) -> dict[str, Any]:
    json_data = await recorder_spider.get_netease_stream_data(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)
    return await recorder_stream.get_netease_stream_url(json_data, normalize_quality(settings.quality))


async def get_direct_spider_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, _recorder_stream: Any, spider_name: str) -> dict[str, Any]:
    return await getattr(recorder_spider, spider_name)(settings.room_url, proxy_addr=proxy_addr, cookies=settings.cookie)


async def get_popkontv_port_info(settings: ProxySettings, proxy_addr: str | None, recorder_spider: Any, _recorder_stream: Any) -> dict[str, Any]:
    return await recorder_spider.get_popkontv_stream_url(
        settings.room_url,
        proxy_addr=proxy_addr,
        access_token=settings.cookie or None,
    )


PLATFORM_RESOLVERS = (
    PlatformResolver("抖音直播", ("douyin.com/",), get_douyin_port_info),
    PlatformResolver("TikTok直播", ("www.tiktok.com/",), get_tiktok_port_info),
    PlatformResolver("快手直播", ("live.kuaishou.com/",), get_kuaishou_port_info),
    PlatformResolver("虎牙直播", ("www.huya.com/",), get_huya_port_info),
    PlatformResolver("斗鱼直播", ("www.douyu.com/",), get_douyu_port_info),
    PlatformResolver("YY直播", ("www.yy.com/",), get_yy_port_info),
    PlatformResolver("B站直播", ("live.bilibili.com/",), get_bilibili_port_info),
    PlatformResolver("小红书直播", ("xhslink.com/", "xiaohongshu.com/"), partial(get_direct_spider_port_info, spider_name="get_xhs_stream_url")),
    PlatformResolver("Bigo直播", ("www.bigo.tv/", "slink.bigovideo.tv/"), partial(get_direct_spider_port_info, spider_name="get_bigo_stream_url")),
    PlatformResolver("Blued直播", ("app.blued.cn/",), partial(get_direct_spider_port_info, spider_name="get_blued_stream_url")),
    PlatformResolver("SOOP", ("sooplive.co.kr/", "sooplive.com/"), partial(get_stream_url_port_info, spider_name="get_sooplive_stream_data", spec=True)),
    PlatformResolver("网易CC直播", ("cc.163.com/",), get_netease_port_info),
    PlatformResolver("千度热播", ("qiandurebo.com/",), partial(get_direct_spider_port_info, spider_name="get_qiandurebo_stream_data")),
    PlatformResolver("PandaTV", ("www.pandalive.co.kr/",), partial(get_stream_url_port_info, spider_name="get_pandatv_stream_data", spec=True)),
    PlatformResolver("猫耳FM直播", ("fm.missevan.com/",), partial(get_direct_spider_port_info, spider_name="get_maoerfm_stream_url")),
    PlatformResolver("WinkTV", ("www.winktv.co.kr/",), partial(get_stream_url_port_info, spider_name="get_winktv_stream_data", spec=True)),
    PlatformResolver("FlexTV", ("www.flextv.co.kr/", "www.ttinglive.com/"), partial(get_stream_url_port_info, spider_name="get_flextv_stream_data", spec=True)),
    PlatformResolver("Look直播", ("look.163.com/",), partial(get_direct_spider_port_info, spider_name="get_looklive_stream_url")),
    PlatformResolver("PopkonTV", ("www.popkontv.com/",), get_popkontv_port_info),
    PlatformResolver("TwitCasting", ("twitcasting.tv/",), partial(get_stream_url_port_info, spider_name="get_twitcasting_stream_url", spec=False)),
    PlatformResolver("百度直播", ("live.baidu.com/",), partial(get_stream_url_port_info, spider_name="get_baidu_stream_data")),
    PlatformResolver("微博直播", ("weibo.com/",), partial(get_stream_url_port_info, spider_name="get_weibo_stream_data", hls_extra_key="m3u8_url")),
    PlatformResolver("酷狗直播", ("kugou.com/",), partial(get_direct_spider_port_info, spider_name="get_kugou_stream_url")),
    PlatformResolver("TwitchTV", ("www.twitch.tv/",), partial(get_stream_url_port_info, spider_name="get_twitchtv_stream_data", spec=True)),
    PlatformResolver("LiveMe", ("www.liveme.com/",), partial(get_direct_spider_port_info, spider_name="get_liveme_stream_url")),
    PlatformResolver("花椒直播", ("www.huajiao.com/",), partial(get_direct_spider_port_info, spider_name="get_huajiao_stream_url")),
    PlatformResolver("流星直播", ("7u66.com/",), partial(get_direct_spider_port_info, spider_name="get_liuxing_stream_url")),
    PlatformResolver("ShowRoom", ("showroom-live.com/",), partial(get_stream_url_port_info, spider_name="get_showroom_stream_data", spec=True)),
    PlatformResolver("Acfun", ("live.acfun.cn/", "m.acfun.cn/"), partial(get_stream_url_port_info, spider_name="get_acfun_stream_data", url_type="flv", flv_extra_key="url")),
    PlatformResolver("畅聊直播", ("live.tlclw.com/", "www.tlclw.com/"), partial(get_direct_spider_port_info, spider_name="get_changliao_stream_url")),
    PlatformResolver("音播直播", ("ybw1666.com/",), partial(get_direct_spider_port_info, spider_name="get_yinbo_stream_url")),
    PlatformResolver("映客直播", ("www.inke.cn/",), partial(get_direct_spider_port_info, spider_name="get_yingke_stream_url")),
    PlatformResolver("知乎直播", ("www.zhihu.com/",), partial(get_direct_spider_port_info, spider_name="get_zhihu_stream_url")),
    PlatformResolver("CHZZK", ("chzzk.naver.com/",), partial(get_stream_url_port_info, spider_name="get_chzzk_stream_data", spec=True)),
    PlatformResolver("嗨秀直播", ("www.haixiutv.com/",), partial(get_direct_spider_port_info, spider_name="get_haixiu_stream_url")),
    PlatformResolver("VV星球", ("vvxqiu.com/",), partial(get_direct_spider_port_info, spider_name="get_vvxqiu_stream_url")),
    PlatformResolver("17Live", ("17.live/",), partial(get_direct_spider_port_info, spider_name="get_17live_stream_url")),
    PlatformResolver("浪Live", ("www.lang.live/",), partial(get_direct_spider_port_info, spider_name="get_langlive_stream_url")),
    PlatformResolver("漂漂直播", ("m.pp.weimipopo.com/",), partial(get_direct_spider_port_info, spider_name="get_pplive_stream_url")),
    PlatformResolver("六间房直播", (".6.cn/",), partial(get_direct_spider_port_info, spider_name="get_6room_stream_url")),
    PlatformResolver("乐嗨直播", ("lehaitv.com/",), partial(get_direct_spider_port_info, spider_name="get_haixiu_stream_url")),
    PlatformResolver("花猫直播", ("h.catshow168.com/",), partial(get_direct_spider_port_info, spider_name="get_pplive_stream_url")),
    PlatformResolver("Shopee直播", ("live.shopee", "shp.ee/"), partial(get_direct_spider_port_info, spider_name="get_shopee_stream_url")),
    PlatformResolver("Youtube", ("www.youtube.com/", "youtu.be/"), partial(get_stream_url_port_info, spider_name="get_youtube_stream_url", spec=True)),
    PlatformResolver("淘宝直播", ("tb.cn",), partial(get_stream_url_port_info, spider_name="get_taobao_stream_url", url_type="all", hls_extra_key="hlsUrl", flv_extra_key="flvUrl")),
    PlatformResolver("京东直播", ("3.cn", "m.jd.com"), partial(get_direct_spider_port_info, spider_name="get_jd_stream_url")),
    PlatformResolver("Faceit", ("faceit.com/",), partial(get_stream_url_port_info, spider_name="get_faceit_stream_data", spec=True)),
    PlatformResolver("咪咕直播", ("www.miguvideo.com", "m.miguvideo.com"), partial(get_direct_spider_port_info, spider_name="get_migu_stream_url")),
    PlatformResolver("连接直播", ("show.lailianjie.com",), partial(get_direct_spider_port_info, spider_name="get_lianjie_stream_url")),
    PlatformResolver("来秀直播", ("www.imkktv.com",), partial(get_direct_spider_port_info, spider_name="get_laixiu_stream_url")),
    PlatformResolver("Picarto", ("www.picarto.tv",), partial(get_direct_spider_port_info, spider_name="get_picarto_stream_url")),
)


async def resolve_platform_stream_async(settings: ProxySettings) -> ResolveResult:
    if not settings.room_url:
        return ResolveResult(ok=False, error="请先填写直播间链接。", resolved_at=time.time())

    direct_info = direct_source_info(settings.room_url)
    if direct_info:
        return choose_stream(direct_info, settings.output_mode, "自定义直播源")

    platform_resolver = get_platform_resolver(settings.room_url)
    if not platform_resolver:
        return ResolveResult(
            ok=False,
            error="暂未识别该直播平台；请确认 DouyinLiveRecorder 是否支持这个链接格式。",
            resolved_at=time.time(),
        )

    recorder_spider, recorder_stream, _ = load_recorder_modules()
    proxy_addr = handle_proxy_addr(settings.upstream_proxy)
    try:
        port_info = await platform_resolver.resolver(settings, proxy_addr, recorder_spider, recorder_stream)
        stream_info = normalize_platform_stream_info(port_info, platform_resolver.name, settings.room_url)
        if not stream_info or not stream_info.get("is_live"):
            return ResolveResult(
                ok=False,
                platform=platform_resolver.name,
                is_live=False,
                anchor_name=(stream_info or {}).get("anchor_name", ""),
                output_mode=settings.output_mode,
                error="直播间未开播、解析失败，或 Cookie 可能已过期。",
                resolved_at=time.time(),
            )
        return choose_stream(stream_info, settings.output_mode, platform_resolver.name)
    except Exception as exc:
        return ResolveResult(
            ok=False,
            output_mode=settings.output_mode,
            platform=platform_resolver.name,
            error=f"{platform_resolver.name}解析失败：Cookie 可能已过期、需要代理/登录，或触发了平台风控。详情：{exc}",
            resolved_at=time.time(),
        )


def resolve_stream(settings: ProxySettings, force: bool = True) -> ResolveResult:
    """Resolve one settings revision at a time.

    A forced request skips the retry deadline, but joins an existing resolve;
    it never creates a second platform request for the same configuration.
    """
    global RESOLVER_CONFIG_VERSION, RESOLVER_RETRY_VERSION, RESOLVER_RETRY_AT, RESOLVER_RETRY_DELAY, RESOLVER_ATTEMPT_ID
    with STATE.lock:
        config_version = STATE.config_version
        # Callers may have evaluated STATE.settings immediately before a
        # concurrent settings save. Always resolve an immutable copy owned by
        # this revision, never the caller's potentially stale object.
        settings = ProxySettings(**asdict(STATE.settings))
        cached = STATE.last_result
        if not force and cached and cached.ok and time.time() - cached.resolved_at <= RESOLVE_CACHE_TTL:
            return cached

    with RESOLVE_CONDITION:
        joined_attempt = RESOLVER_ACTIVE.get(config_version)
        if joined_attempt is not None:
            while not joined_attempt.done:
                RESOLVE_CONDITION.wait()
            if joined_attempt.result is not None:
                return joined_attempt.result
        now = time.monotonic()
        if not force and RESOLVER_RETRY_VERSION == config_version and now < RESOLVER_RETRY_AT:
            with STATE.lock:
                cached = STATE.last_result or STATE.last_resolve_error
                if cached is not None:
                    return cached
        # A new retry must not reuse the previous failed attempt result.
        RESOLVER_COMPLETED.pop(config_version, None)
        RESOLVER_ATTEMPT_ID += 1
        attempt = ResolverAttempt(RESOLVER_ATTEMPT_ID)
        RESOLVER_ACTIVE[config_version] = attempt
        RESOLVER_IN_FLIGHT.add(config_version)
        RESOLVER_CONFIG_VERSION = config_version

    try:
        result = asyncio.run(resolve_platform_stream_async(settings))
    except BaseException as exc:
        result = ResolveResult(ok=False, output_mode=settings.output_mode, error=f"解析异常：{exc}", resolved_at=time.time())

    with STATE.lock:
        # Settings may have changed while the platform resolver was awaiting.
        # Never publish that stale result into the newer session.
        if STATE.config_version != config_version:
            stale = ResolveResult(ok=False, output_mode=STATE.settings.output_mode,
                                 error="配置在解析期间已变更，请重新连接。", resolved_at=time.time())
            result = stale
        else:
            STATE.last_result = result if result.ok else None
            STATE.last_resolve_error = None if result.ok else result
            source_identity = (result.selected_type, result.selected_url)
            if result.ok and STATE.resolved_source_identity != source_identity:
                STATE.resolved_source_identity = source_identity
                STATE.mark_source_changed()
    with RESOLVE_CONDITION:
        attempt.result = result
        attempt.done = True
        RESOLVER_IN_FLIGHT.discard(config_version)
        if RESOLVER_ACTIVE.get(config_version) is attempt:
            RESOLVER_ACTIVE.pop(config_version, None)
        RESOLVER_COMPLETED[config_version] = result
        # A completed attempt exists only to wake concurrent joiners for that
        # revision. Bound historical attempts across long-lived settings edits.
        while len(RESOLVER_COMPLETED) > MAX_RESOLVER_COMPLETED:
            RESOLVER_COMPLETED.pop(next(iter(RESOLVER_COMPLETED)))
        # Only the active configuration controls the shared retry deadline.
        with STATE.lock:
            current_config_version = STATE.config_version
        if current_config_version != config_version:
            RESOLVE_CONDITION.notify_all()
        elif result.ok:
            if RESOLVER_RETRY_VERSION == config_version:
                RESOLVER_RETRY_DELAY = 0.0
                RESOLVER_RETRY_AT = 0.0
        else:
            previous_delay = RESOLVER_RETRY_DELAY if RESOLVER_RETRY_VERSION == config_version else 0.0
            RESOLVER_RETRY_VERSION = config_version
            RESOLVER_RETRY_DELAY = next_retry_delay(previous_delay)
            RESOLVER_RETRY_AT = time.monotonic() + RESOLVER_RETRY_DELAY
        RESOLVE_CONDITION.notify_all()
    if result.ok:
        STATE.log("info", f"已解析{result.platform or '直播源'}上游：{result.selected_type.upper()}（{result.codec or '未知编码'}）。")
    else:
        STATE.log("error", result.error)
    return result


resolve_douyin_stream = resolve_stream


def resolve_stream_binding(settings: ProxySettings, force: bool = True) -> tuple[ResolveResult, int, int, int]:
    """Return a result and its source/config/generation fence atomically."""
    result = resolve_douyin_stream(settings, force)
    with STATE.lock:
        current = STATE.last_result
        if result.ok and current is not result:
            result = ResolveResult(
                ok=False, output_mode=STATE.settings.output_mode,
                error="直播源在解析后已切换，请重新连接。", resolved_at=time.time(),
            )
        return result, STATE.source_version, STATE.config_version, STATE.stream_generation


def force_refresh_flv_source() -> ResolveResult:
    result = resolve_douyin_stream(STATE.settings, force=True)
    return result


def next_retry_delay(previous_delay: float) -> float:
    if previous_delay <= 0:
        return STREAM_RETRY_BASE_DELAY
    return min(previous_delay * 2, STREAM_RETRY_MAX_DELAY)


HLS_URI_TAGS = {
    "#EXT-X-KEY", "#EXT-X-SESSION-KEY", "#EXT-X-MAP", "#EXT-X-MEDIA",
    "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-PART", "#EXT-X-PRELOAD-HINT",
    "#EXT-X-RENDITION-REPORT",
}
HLS_PLAYLIST_URI_TAGS = {
    "#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-RENDITION-REPORT",
}


def hls_proxy_url(
    absolute: str,
    request_base: str,
    expected_revisions: tuple[int, int] | None = None,
    force_playlist: bool = False,
) -> str:
    if not STATE.register_hls_url(absolute, expected_revisions):
        raise HLSRegistryFull("HLS 地址缓存已满，请刷新主播放列表后重试。")
    endpoint = "playlist" if force_playlist or ".m3u8" in urlparse(absolute).path.lower() else "segment"
    return f"{request_base}/hls/{endpoint}?url={quote(absolute, safe='')}"


def rewrite_hls_attributes(
    line: str, playlist_url: str, request_base: str, expected_revisions: tuple[int, int] | None = None,
) -> str:
    """Rewrite quoted or unquoted URI attributes without splitting commas in quotes."""
    if ":" not in line:
        return line
    prefix, attributes = line.split(":", 1)
    if prefix.upper() not in HLS_URI_TAGS:
        return line
    pieces: list[str] = []
    start = 0
    quote_char: str | None = None
    for index, char in enumerate(attributes):
        if char in {"'", '"'}:
            if quote_char == char:
                quote_char = None
            elif quote_char is None:
                quote_char = char
        elif char == "," and quote_char is None:
            pieces.append(attributes[start:index])
            start = index + 1
    pieces.append(attributes[start:])
    if quote_char is not None:
        raise ValueError("HLS 属性列表包含未闭合引号。")
    rewritten: list[str] = []
    for piece in pieces:
        name, separator, raw_value = piece.partition("=")
        if separator and name.strip().upper() == "URI":
            value = raw_value.strip()
            quote_char = value[0] if len(value) >= 2 and value[0] in {"'", '"'} and value[-1] == value[0] else ""
            target = value[1:-1] if quote_char else value
            absolute = urljoin(playlist_url, target)
            value = hls_proxy_url(
                absolute, request_base, expected_revisions, prefix.upper() in HLS_PLAYLIST_URI_TAGS,
            )
            rewritten.append(f"{name}={quote_char}{value}{quote_char}")
        else:
            rewritten.append(piece)
    return f"{prefix}:{','.join(rewritten)}"


def rewrite_hls_playlist(
    text: str,
    playlist_url: str,
    request_base: str,
    expected_revisions: tuple[int, int] | None = None,
) -> str:
    # Do not evict URLs from a single giant manifest: it would emit a playlist
    # whose earliest links are unauthorized before the client can request them.
    uri_count = sum(1 for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#"))
    uri_count += sum(line.upper().count("URI=") for line in text.splitlines() if line.lstrip().startswith("#"))
    if uri_count > MAX_HLS_URLS:
        raise HLSRegistryFull("单个 HLS 播放列表包含过多地址。")
    lines: list[str] = []
    next_uri_is_playlist = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append(line)
            continue
        if stripped.startswith("#"):
            lines.append(rewrite_hls_attributes(line, playlist_url, request_base, expected_revisions))
            if stripped.upper().startswith("#EXT-X-STREAM-INF"):
                next_uri_is_playlist = True
            continue
        absolute = urljoin(playlist_url, stripped)
        lines.append(hls_proxy_url(absolute, request_base, expected_revisions, next_uri_is_playlist))
        next_uri_is_playlist = False
    return "\n".join(lines) + "\n"


def rewrite_hls_key_uri(line: str, playlist_url: str, request_base: str) -> str:
    return rewrite_hls_attributes(line, playlist_url, request_base)


def is_allowed_hls_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    with STATE.lock:
        result = STATE.last_result
    if not result:
        return False
    if STATE.is_registered_hls_url(url):
        return True
    allowed_hosts = {
        urlparse(candidate).netloc
        for candidate in (result.m3u8_url, result.selected_url)
        if candidate
    }
    return url in {result.m3u8_url, result.selected_url} and parsed.netloc in allowed_hosts


def strip_flv_header(chunk: bytes) -> bytes:
    if chunk.startswith(b"FLV") and len(chunk) > 13:
        return chunk[13:]
    return chunk


def get_ffmpeg_command(input_url: str, settings: ProxySettings) -> list[str]:
    ffmpeg = find_ffmpeg()
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "10",
        "-rw_timeout",
        "15000000",
        "-user_agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "-headers",
        "Referer: https://live.bilibili.com/\r\nOrigin: https://live.bilibili.com\r\n",
        "-i",
        input_url,
        "-sn",
        "-dn",
        "-c:v",
        "libx264",
        "-preset",
        settings.transcode_preset,
        "-tune",
        "zerolatency",
        "-c:a",
        "aac",
        "-f",
        "flv",
        "pipe:1",
    ]


def find_ffmpeg() -> str:
    if getattr(sys, "frozen", False):
        bundled_ffmpeg = BUNDLE_ROOT / VENDORED_FFMPEG
        if bundled_ffmpeg.is_file():
            return str(bundled_ffmpeg)
        raise RuntimeError("冻结版缺少已打包的 ffmpeg：_internal/vendor/ffmpeg/bin/ffmpeg.exe。")
    candidates = [
        PROJECT_ROOT / VENDORED_FFMPEG,
        BUNDLE_ROOT / VENDORED_FFMPEG,
        RECORDER_ROOT / "ffmpeg" / "ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            "未找到 ffmpeg。请重新打包含 vendor/ffmpeg/bin/ffmpeg.exe 的发行版，"
            "或安装 ffmpeg 并加入 PATH。"
        )
    return ffmpeg


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def start_ffmpeg_process(command: list[str]) -> subprocess.Popen[bytes]:
    kwargs: dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform.startswith("win"):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
        kwargs["startupinfo"] = startupinfo
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return cast("subprocess.Popen[bytes]", subprocess.Popen(command, **kwargs))


def start_stdout_reader(
    process: subprocess.Popen[bytes],
    chunk_size: int,
    output: "queue.Queue[bytes | None]",
    stop_event: threading.Event,
) -> threading.Thread:
    def put_chunk(chunk: bytes | None) -> None:
        while not stop_event.is_set():
            try:
                output.put(chunk, timeout=0.2)
                return
            except queue.Full:
                continue

    def reader() -> None:
        try:
            assert process.stdout is not None
            while not stop_event.is_set():
                # BufferedReader.read(n) may wait for a full buffer; read1
                # returns currently available data without turning each byte
                # into a queue operation.  Test doubles may only expose read.
                read1 = getattr(process.stdout, "read1", None)
                chunk = read1(chunk_size) if read1 else process.stdout.read(chunk_size)
                if not chunk:
                    break
                put_chunk(chunk)
        finally:
            put_chunk(None)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    return thread


def read_first_transcode_chunk(
    process: subprocess.Popen[bytes],
    chunks: "queue.Queue[bytes | None]",
    generation: int,
) -> bytes | None:
    deadline = time.monotonic() + TRANSCODE_START_TIMEOUT
    while STATE.should_continue_stream(generation) and time.monotonic() < deadline:
        try:
            first_chunk = chunks.get(timeout=TRANSCODE_READ_TIMEOUT)
        except queue.Empty:
            if process.poll() is not None:
                break
            continue
        if first_chunk:
            return first_chunk
        if first_chunk is None:
            break
    return None


def stop_transcode_pipeline(
    process: subprocess.Popen[bytes] | None,
    stop_reader: threading.Event | None,
    reader: threading.Thread | None = None,
) -> None:
    if stop_reader:
        stop_reader.set()
    try:
        if process:
            try:
                terminate_process(process)
            except OSError:
                # A process can exit in the narrow interval before terminate.
                # Do not hide a live-process failure, but tolerate that race.
                if process.poll() is None:
                    raise
    finally:
        if process and process.stdout:
            try:
                process.stdout.close()
            except OSError:
                pass
        if reader:
            reader.join(timeout=1)


def should_close_transcode_response(
    current_url: str,
    current_source_version: int,
    latest_version: int,
    latest_result: ResolveResult | None,
) -> bool:
    if latest_version == current_source_version or not latest_result or not latest_result.ok:
        return False
    # A response has one FLV container/encoder session.  Any valid source
    # transition, including mode changes, must start a fresh HTTP response.
    return bool(latest_result.selected_url) and (
        latest_result.selected_type != "transcode" or latest_result.selected_url != current_url
    )


class LocalProxyHandler(BaseHTTPRequestHandler):
    server_version = "VideoBoxLocalProxy/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        if args and isinstance(args[0], str) and args[0].startswith("GET /api/status"):
            return
        STATE.log("http", format % args)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            if not self.require_local_control():
                return
            self.send_text(INDEX_HTML, "text/html; charset=utf-8")
        elif parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        elif parsed.path == "/live":
            self.handle_live()
        elif parsed.path == "/api/status":
            if not self.require_local_control():
                return
            if "resolve" in parse_qs(parsed.query):
                self.send_json(
                    {"error": "请使用 POST /api/control 和 action=resolve 触发解析。"},
                    HTTPStatus.METHOD_NOT_ALLOWED,
                )
                return
            self.handle_status(parsed)
        elif parsed.path == "/hls/playlist":
            self.handle_hls_proxy(parsed, playlist=True)
        elif parsed.path == "/hls/segment":
            self.handle_hls_proxy(parsed, playlist=False)
        else:
            self.send_json({"error": "未找到对应的服务接口。"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/settings":
            self.handle_settings()
        elif parsed.path == "/api/control":
            self.handle_control()
        elif parsed.path == "/api/shutdown":
            self.handle_shutdown()
        else:
            self.send_json({"error": "未找到对应的服务接口。"}, HTTPStatus.NOT_FOUND)

    def handle_status(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        if query.get("resolve", ["0"])[0] == "1":
            resolve_douyin_stream(STATE.settings, force=True)
        self.send_json(STATE.snapshot())

    def handle_settings(self) -> None:
        if not self.require_local_control():
            return
        if not self.require_json_content_type():
            return
        try:
            body = self.read_json_body()
            data = json.loads(body.decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError("请求 JSON 必须是对象。")
        except PayloadTooLarge:
            self.send_json({"error": "请求内容过大，请减少配置内容后重试。"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        except (ValueError, OSError) as exc:
            self.send_json({"error": f"请求格式不正确：{exc}"}, HTTPStatus.BAD_REQUEST)
            return

        with STATE.lock:
            current = STATE.settings
            settings = ProxySettings(**asdict(current))
            if "room_url" in data:
                settings.room_url = str(data["room_url"]).strip()
            if "quality" in data:
                settings.quality = normalize_quality(str(data["quality"]))
            if "output_mode" in data:
                settings.output_mode = normalize_mode(str(data["output_mode"]))
            if "cookie" in data:
                settings.cookie = str(data["cookie"])
            if "upstream_proxy" in data:
                settings.upstream_proxy = str(data["upstream_proxy"]).strip()
            if "chunk_size" in data:
                settings.chunk_size = parse_int(data["chunk_size"], current.chunk_size, 4096, 1024 * 1024)
            if "transcode_preset" in data:
                settings.transcode_preset = str(data["transcode_preset"]).strip() or "veryfast"
            STATE.update_settings(settings)
            if data.get("enable_stream"):
                STATE.stream_enabled = True
            save_settings(settings)
        STATE.log("info", "配置已保存。")
        if data.get("resolve"):
            result = resolve_douyin_stream(STATE.settings)
        self.send_json(STATE.snapshot())

    def handle_control(self) -> None:
        if not self.require_local_control():
            return
        if not self.require_json_content_type():
            return
        try:
            body = self.read_json_body()
            data = json.loads(body.decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError("请求 JSON 必须是对象。")
        except PayloadTooLarge:
            self.send_json({"error": "请求内容过大，请减少配置内容后重试。"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        except (ValueError, OSError) as exc:
            self.send_json({"error": f"请求格式不正确：{exc}"}, HTTPStatus.BAD_REQUEST)
            return

        action = str(data.get("action", "")).strip().lower()
        if action == "start":
            STATE.start_stream()
            if data.get("resolve", True):
                resolve_douyin_stream(STATE.settings)
            self.send_json(STATE.snapshot())
        elif action == "stop":
            STATE.stop_stream()
            self.send_json(STATE.snapshot())
        elif action == "resolve":
            result = resolve_douyin_stream(STATE.settings, force=True)
            self.send_json(STATE.snapshot())
        else:
            self.send_json({"error": "控制动作无效，请使用 start 或 stop。"}, HTTPStatus.BAD_REQUEST)

    def handle_shutdown(self) -> None:
        if not self.require_local_control("只能在本机关闭转播助手。"):
            return
        STATE.stop_stream()
        STATE.log("info", "已收到本机关闭请求。")
        self.send_json({"ok": True, "message": "转播助手正在关闭。"})

        def shutdown_server() -> None:
            time.sleep(0.2)
            self.server.shutdown()

        thread = threading.Thread(target=shutdown_server, daemon=True)
        thread.start()

    def require_local_control(self, message: str = "控制接口仅允许本机访问。") -> bool:
        client_host = self.client_address[0] if self.client_address else ""
        if not is_local_client(client_host):
            self.send_json({"error": message}, HTTPStatus.FORBIDDEN)
            return False
        port = int(self.server.server_address[1])
        host = self.headers.get("Host", "")
        if not self.is_local_control_origin(host, port):
            self.send_json({"error": "控制接口的 Host 必须是当前本机控制台。"}, HTTPStatus.FORBIDDEN)
            return False
        origin = self.headers.get("Origin")
        if origin and not self.is_local_control_origin(origin, port):
            self.send_json({"error": "控制接口不接受跨域请求。"}, HTTPStatus.FORBIDDEN)
            return False
        return True

    @staticmethod
    def is_local_control_origin(value: str, port: int) -> bool:
        try:
            parsed = urlparse(value if "://" in value else f"//{value}")
            return parsed.scheme in {"", "http"} and is_local_client(parsed.hostname or "") and parsed.port == port
        except ValueError:
            return False

    def require_json_content_type(self) -> bool:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type == "application/json":
            return True
        self.send_json({"error": "控制接口要求 application/json 请求体。"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        return False

    def read_json_body(self) -> bytes:
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        if content_length > MAX_API_BODY_BYTES:
            self.rfile.read(min(content_length, MAX_API_BODY_BYTES + 1))
            raise PayloadTooLarge()
        return self.rfile.read(content_length)

    def handle_live(self) -> None:
        if not STATE.stream_enabled:
            self.send_text(
                "代理输出已停止，请在控制台点击“播放”后再连接。",
                "text/plain; charset=utf-8",
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        if not LIVE_CLIENTS.acquire(blocking=False):
            self.send_text(
                "OBS 连接数过多，请关闭不用的媒体源后重试。",
                "text/plain; charset=utf-8",
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        client_id = STATE.register_client()
        try:
            result, source_version, _config_version, generation = resolve_stream_binding(STATE.settings, force=False)
            if not STATE.should_continue_stream(generation):
                return
            if not result.ok:
                self.send_text(result.error, "text/plain; charset=utf-8", HTTPStatus.BAD_GATEWAY)
                return
            if result.selected_type == "transcode":
                self.stream_transcode(result.selected_url, generation, client_id, source_version, _config_version)
            elif result.selected_type == "hls":
                self.proxy_hls_playlist_limited(result.selected_url, (_config_version, source_version))
            else:
                self.proxy_switchable_binary(
                    result.selected_url,
                    FLV_CONTENT_TYPE,
                    generation,
                    source_version,
                    client_id,
                    _config_version,
                )
        finally:
            STATE.unregister_client(client_id)
            LIVE_CLIENTS.release()

    def handle_hls_proxy(self, parsed: Any, playlist: bool) -> None:
        # parse_qs already performs one URL decode. A second pass mutates
        # signed URLs containing escaped percent/plus/slash characters.
        url = parse_qs(parsed.query).get("url", [""])[0]
        if not url:
            self.send_text("缺少 HLS 地址参数。", "text/plain; charset=utf-8", HTTPStatus.BAD_REQUEST)
            return
        with STATE.lock:
            expected_revisions = (STATE.config_version, STATE.source_version)
            result = STATE.last_result
            root_urls = {candidate for candidate in (
                result.m3u8_url if result else "", result.selected_url if result else "",
            ) if candidate}
            authorized = STATE.is_registered_hls_url(url) or url in root_urls
            enabled = STATE.stream_enabled
        if not authorized:
            self.send_text("该 HLS 地址不属于当前直播源。", "text/plain; charset=utf-8", HTTPStatus.FORBIDDEN)
            return
        if not enabled:
            self.send_text(
                "代理输出已停止。",
                "text/plain; charset=utf-8",
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        if playlist:
            self.proxy_hls_playlist_limited(url, expected_revisions)
        else:
            content_type = TS_CONTENT_TYPE if ".ts" in urlparse(url).path.lower() else "application/octet-stream"
            self.proxy_hls_binary_limited(url, content_type, expected_revisions)

    def proxy_hls_playlist_limited(self, upstream_url: str, expected_revisions: tuple[int, int] | None = None) -> None:
        if not HLS_REQUESTS.acquire(blocking=False):
            self.send_text("HLS 请求过多，请稍后重试。", "text/plain; charset=utf-8", HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            self.proxy_hls_playlist(upstream_url, expected_revisions)
        finally:
            HLS_REQUESTS.release()

    def proxy_hls_binary_limited(
        self, upstream_url: str, content_type: str, expected_revisions: tuple[int, int] | None = None,
    ) -> None:
        if not HLS_REQUESTS.acquire(blocking=False):
            self.send_text("HLS 请求过多，请稍后重试。", "text/plain; charset=utf-8", HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            self.proxy_binary(upstream_url, content_type, STATE.current_generation(), expected_revisions)
        finally:
            HLS_REQUESTS.release()

    def proxy_hls_playlist(self, upstream_url: str, expected_revisions: tuple[int, int] | None = None) -> None:
        config_version, source_version = expected_revisions or STATE.current_revisions()
        try:
            with requests.get(
                upstream_url,
                timeout=20,
                headers={"User-Agent": "Mozilla/5.0"},
                proxies=proxy_map(STATE.settings.upstream_proxy),
            ) as response:
                response.raise_for_status()
                # Hold the state lock across revision validation and all URL
                # registration, so an old response cannot refill a fresh
                # source's allowlist halfway through a rewrite.
                with STATE.lock:
                    if STATE.current_revisions() != (config_version, source_version):
                        raise HLSStalePlaylist("直播源已切换，请重新加载播放列表。")
                    request_base = f"http://{self.headers.get('Host', f'127.0.0.1:{STATE.settings.port}')}"
                    text = rewrite_hls_playlist(response.text, response.url, request_base, (config_version, source_version))
            self.set_media_write_timeout()
            self.send_text(text, HLS_CONTENT_TYPE)
        except HLSStalePlaylist as exc:
            self.set_media_write_timeout()
            self.send_text(str(exc), "text/plain; charset=utf-8", HTTPStatus.CONFLICT)
        except (HLSRegistryFull, ValueError) as exc:
            STATE.log("error", str(exc))
            self.set_media_write_timeout()
            self.send_text(str(exc), "text/plain; charset=utf-8", HTTPStatus.BAD_GATEWAY)
        except requests.RequestException as exc:
            STATE.log("error", f"HLS 代理失败：{exc}")
            self.set_media_write_timeout()
            self.send_text(f"HLS 代理失败：{exc}", "text/plain; charset=utf-8", HTTPStatus.BAD_GATEWAY)

    def proxy_binary(
        self, upstream_url: str, content_type: str, generation: int | None = None,
        expected_revisions: tuple[int, int] | None = None,
    ) -> None:
        headers = {"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"}
        for name in ("Range", "If-Range"):
            if self.headers.get(name):
                headers[name] = self.headers[name]
        proxies = proxy_map(STATE.settings.upstream_proxy)
        if generation is None:
            generation = STATE.current_generation()
        try:
            with requests.get(upstream_url, stream=True, timeout=(10, 30), headers=headers, proxies=proxies) as response:
                response.raise_for_status()
                self.set_media_write_timeout()
                self.send_response(response.status_code)
                self.send_header("Content-Type", response.headers.get("Content-Type", content_type))
                self.send_header("Cache-Control", "no-store")
                for name in ("Content-Range", "Accept-Ranges", "Content-Length", "Content-Encoding"):
                    if response.headers.get(name):
                        self.send_header(name, response.headers[name])
                self.end_headers()
                raw = getattr(response, "raw", None)
                chunks = (
                    raw.stream(STATE.settings.chunk_size, decode_content=False)
                    if raw is not None and hasattr(raw, "stream")
                    else response.iter_content(chunk_size=STATE.settings.chunk_size)
                )
                for chunk in chunks:
                    if not STATE.should_continue_stream(generation):
                        break
                    if expected_revisions and STATE.current_revisions() != expected_revisions:
                        break
                    if chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        except (requests.RequestException, OSError) as exc:
            STATE.log("error", f"直播流代理已结束：{exc}")

    def set_media_write_timeout(self) -> None:
        try:
            self.connection.settimeout(MEDIA_WRITE_TIMEOUT)
        except OSError:
            pass

    def proxy_switchable_binary(
        self,
        upstream_url: str,
        content_type: str,
        generation: int,
        source_version: int,
        client_id: str,
        config_version: int | None = None,
    ) -> None:
        headers = {"User-Agent": "Mozilla/5.0"}
        proxies = proxy_map(STATE.settings.upstream_proxy)
        expected_revisions = (STATE.config_version if config_version is None else config_version, source_version)
        expected_identity = ("flv", upstream_url)
        try:
            proxies = proxy_map(STATE.settings.upstream_proxy)
            with requests.get(
                upstream_url, stream=True, timeout=(10, 30), headers=headers, proxies=proxies,
            ) as response:
                response.raise_for_status()
                self.set_media_write_timeout()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", response.headers.get("Content-Type", content_type))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                for chunk in response.iter_content(chunk_size=STATE.settings.chunk_size):
                    if not STATE.should_continue_stream(generation):
                        return
                    if STATE.current_revisions() != expected_revisions:
                        STATE.log("info", "直播源或配置已切换，将关闭当前 OBS 响应以便重连。")
                        return
                    if chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        STATE.touch_client(client_id)
                # EOF marks this stream stale.  The next OBS reconnect will
                # resolve under the shared retry policy rather than concatenate.
                STATE.invalidate_result(
                    "上游直播流已结束，等待客户端重新连接。", expected_revisions, expected_identity,
                )
        except requests.RequestException as exc:
            STATE.invalidate_result(f"上游直播流中断：{exc}", expected_revisions, expected_identity)
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            # A downstream socket error is terminal for this handler.  Do not
            # mistake it for an upstream fault and create a retry storm.
            STATE.log("info", f"OBS 客户端连接已结束：{exc}")
            return

    def stream_transcode(
        self, upstream_url: str, generation: int, client_id: str, source_version: int | None = None,
        config_version: int | None = None,
    ) -> None:
        process: subprocess.Popen[bytes] | None = None
        chunks: queue.Queue[bytes | None] | None = None
        header_sent = False
        stop_reader: threading.Event | None = None
        reader: threading.Thread | None = None
        current_url = upstream_url
        current_source_version = STATE.current_source_version() if source_version is None else source_version
        expected_config_version = STATE.config_version if config_version is None else config_version
        expected_revisions = (expected_config_version, current_source_version)
        expected_identity = ("transcode", current_url)

        def start_pipeline(url: str) -> bytes:
            nonlocal process, chunks, stop_reader, reader
            stop_transcode_pipeline(process, stop_reader, reader)
            command = get_ffmpeg_command(url, STATE.settings)
            process = start_ffmpeg_process(command)
            stop_reader = threading.Event()
            chunks = queue.Queue(maxsize=8)
            reader = start_stdout_reader(process, STATE.settings.chunk_size, chunks, stop_reader)
            first_chunk = read_first_transcode_chunk(process, chunks, generation)
            if not first_chunk:
                raise RuntimeError("ffmpeg 启动超时，未输出直播流数据。")
            return first_chunk

        try:
            first_chunk = start_pipeline(current_url)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", FLV_CONTENT_TYPE)
            self.send_header("Cache-Control", "no-store")
            self.set_media_write_timeout()
            self.end_headers()
            header_sent = True
            self.wfile.write(first_chunk)
            self.wfile.flush()
            STATE.touch_client(client_id)
            last_output_at = time.monotonic()
            while STATE.should_continue_stream(generation):
                latest_version, latest_result = STATE.current_source()
                if STATE.current_revisions()[0] != expected_config_version:
                    STATE.log("info", "转码模式检测到配置变更，将关闭当前 OBS 响应以便重连。")
                    return
                if should_close_transcode_response(current_url, current_source_version, latest_version, latest_result):
                    STATE.log("info", f"转码模式检测到源版本 {latest_version}，将关闭当前 OBS 响应以便稳定重连。")
                    return
                if latest_version != current_source_version:
                    current_source_version = latest_version
                try:
                    if chunks is None:
                        break
                    chunk = chunks.get(timeout=TRANSCODE_READ_TIMEOUT)
                except queue.Empty:
                    if process and process.poll() is not None:
                        break
                    if time.monotonic() - last_output_at >= TRANSCODE_SILENCE_TIMEOUT:
                        STATE.invalidate_result(
                            "ffmpeg 持续无输出，已关闭当前响应等待重新连接。",
                            expected_revisions,
                            expected_identity,
                        )
                        return
                    continue
                if chunk is None:
                    break
                if not STATE.should_continue_stream(generation):
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                STATE.touch_client(client_id)
                last_output_at = time.monotonic()
            if STATE.should_continue_stream(generation):
                STATE.invalidate_result(
                    "ffmpeg 输出已结束，等待客户端重新连接。",
                    expected_revisions,
                    expected_identity,
                )
        except (RuntimeError, OSError, BrokenPipeError, ConnectionResetError) as exc:
            STATE.log("error", f"转码直播流已结束：{exc}")
            if not header_sent and not self.wfile.closed:
                try:
                    self.send_text(str(exc), "text/plain; charset=utf-8", HTTPStatus.BAD_GATEWAY)
                except OSError:
                    pass
        finally:
            stop_transcode_pipeline(process, stop_reader, reader)

    def send_json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def proxy_map(upstream_proxy: str) -> dict[str, str] | None:
    if upstream_proxy and not upstream_proxy.startswith("http"):
        proxy_addr = "http://" + upstream_proxy
    else:
        proxy_addr = upstream_proxy or None
    if not proxy_addr:
        return None
    return {"http": proxy_addr, "https": proxy_addr}


def run(host: str | None = None, port: int | None = None, open_browser: bool = True) -> None:
    settings = STATE.settings
    if host:
        settings.listen_host = host
    if port:
        settings.port = port
    if not acquire_instance_lock(settings.port):
        if open_browser:
            open_control_panel(read_instance_port(settings.port), delay=0)
        return
    if is_existing_instance(settings.port):
        if open_browser:
            open_control_panel(settings.port, delay=0)
        release_instance_lock()
        return
    try:
        server = ThreadingHTTPServer((settings.listen_host, settings.port), LocalProxyHandler)
    except OSError:
        release_instance_lock()
        if is_existing_instance(settings.port):
            if open_browser:
                open_control_panel(settings.port, delay=0)
            return
        raise
    STATE.log("info", f"Local proxy listening on http://{settings.listen_host}:{settings.port}")
    safe_print(f"Local proxy listening on {control_panel_url(settings.port)}")
    if open_browser:
        open_control_panel(settings.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        safe_print("\nStopping local proxy.")
    finally:
        server.server_close()
        release_instance_lock()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Local OBS proxy for live streams supported by DouyinLiveRecorder.")
    parser.add_argument("--host", default=None, help="Listen host, defaults to the saved setting.")
    parser.add_argument("--port", default=None, type=int, help="Listen port, defaults to the saved setting.")
    parser.add_argument("--data-dir", default=None, help="Writable directory for settings, locks, logs, and instance metadata.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser on startup.")
    parser.add_argument("--verify-runtime", action="store_true", help="Verify bundled recorder modules and JavaScript runtime without starting the server.")
    args = parser.parse_args(argv)
    if args.data_dir:
        configure_data_dir(args.data_dir)
        STATE.settings = load_settings()
    if args.verify_runtime:
        raise SystemExit(verify_runtime())
    run(args.host, args.port, open_browser=not args.no_browser)


def verify_runtime() -> int:
    """Exercise bundled imports and Node without opening sockets or making network requests."""
    report_path = PROJECT_ROOT / "runtime-check.json"
    try:
        load_recorder_modules()
        from src import JS_SCRIPT_PATH, room

        if not (JS_SCRIPT_PATH / "x-bogus.js").is_file():
            raise RuntimeError(f"Bundled JavaScript signing file is missing: {JS_SCRIPT_PATH / 'x-bogus.js'}")
        import execjs

        if execjs.eval("1 + 2") != 3:
            raise RuntimeError("The bundled JavaScript runtime returned an unexpected result.")
        signature = asyncio.run(room.get_xbogus("https://example.test/?qa=1", {"User-Agent": "relay-runtime-check"}))
        if not signature:
            raise RuntimeError("Bundled JavaScript signing runtime did not return a signature.")
        node_version = subprocess.check_output(["node", "--version"], text=True, stderr=subprocess.STDOUT).strip()
        report = {"ok": True, "nodeVersion": node_version}
    except Exception as exc:
        report = {"ok": False, "error": str(exc)}
    try:
        PROJECT_ROOT.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    safe_print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>转播助手</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #15211f;
      --muted: #66736f;
      --line: #d7ddd8;
      --panel: #eef1ed;
      --paper: #fbfaf4;
      --field: #fffefa;
      --accent: #b5462d;
      --accent-2: #176f64;
      --good: #1f7a4f;
      --warn: #9b641f;
      --bad: #b3261e;
      --shadow: 0 18px 50px rgba(34, 45, 41, .10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background: var(--panel);
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(340px, 430px) 1fr;
      min-height: 100vh;
    }
    aside {
      padding: 30px;
      background: var(--paper);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    main { padding: 30px; min-width: 0; }
    h1 { margin: 0; font-size: 30px; line-height: 1.08; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: 0; }
    label { display: block; margin: 0 0 7px; color: var(--muted); font-size: 13px; }
    input, select, textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      background: var(--field);
      color: var(--ink);
      padding: 11px 12px;
      border-radius: 6px;
      font: inherit;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    input:focus, select:focus, textarea:focus {
      border-color: color-mix(in srgb, var(--accent-2) 70%, var(--line));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 15%, transparent);
    }
    button:focus-visible, summary:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent-2) 45%, transparent);
      outline-offset: 3px;
    }
    textarea { min-height: 92px; resize: vertical; }
    button {
      border: 0;
      border-radius: 6px;
      min-height: 44px;
      padding: 11px 14px;
      background: var(--ink);
      color: #fff;
      font: inherit;
      cursor: pointer;
      transition: transform .14s ease, opacity .14s ease, background .14s ease;
    }
    button:hover { transform: translateY(-1px); }
    button.secondary { background: #e6e1d5; color: var(--ink); }
    button.danger { background: transparent; color: var(--bad); border: 1px solid color-mix(in srgb, var(--bad) 35%, var(--line)); }
    button.toggle.on, button.toggle.off { background: var(--accent-2); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button:disabled:hover { transform: none; }
    .brand {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 2px;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 8px;
      background: var(--ink);
      color: var(--paper);
      font-weight: 750;
      flex: 0 0 auto;
    }
    .status-strip {
      margin-top: 18px;
      margin-bottom: 10px;
    }
    .form-stack { display: grid; gap: 16px; }
    .field-row { display: grid; gap: 7px; }
    .actions { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 4px; }
    .main-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 18px;
    }
    .main-head h2 { margin: 0; font-size: 20px; }
    .board {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
      min-width: 0;
    }
    .tile {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 90px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .tile .k { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .tile .v { font-size: 20px; font-weight: 650; overflow-wrap: anywhere; }
    .room-info .v {
      font-size: 15px;
      line-height: 1.35;
    }
    .wide {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .url {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--field);
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .url code { flex: 1; min-width: 0; font-family: Consolas, monospace; }
    .obs-guide {
      margin-top: 12px;
      padding: 12px 13px;
      border: 1px solid color-mix(in srgb, var(--accent-2) 18%, var(--line));
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent-2) 7%, var(--field));
      color: var(--ink);
    }
    .obs-guide-title {
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 700;
    }
    .obs-guide ol {
      margin: 0;
      padding-inline-start: 20px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .obs-guide code {
      color: var(--ink);
      font-family: Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      max-width: 100%;
      padding: 4px 9px;
      border-radius: 999px;
      color: #fff;
      background: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .status-strip .pill {
      display: flex;
      width: 100%;
      justify-content: flex-start;
      border-radius: 8px;
      padding: 9px 11px;
      line-height: 1.35;
    }
    .pill.good { background: var(--good); }
    .pill.bad { background: var(--bad); }
    .logs {
      height: 260px;
      overflow: auto;
      border: 1px solid var(--line);
      background: #111817;
      color: #d8eee8;
      border-radius: 8px;
      padding: 12px;
      font-family: Consolas, monospace;
      font-size: 12px;
    }
    details { margin-top: 16px; }
    details .form-stack { margin-top: 10px; }
    summary {
      display: flex;
      align-items: center;
      min-height: 44px;
      cursor: pointer;
      color: var(--accent-2);
      font-weight: 600;
    }
    .log-line { overflow-wrap: anywhere; }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .main-head { flex-direction: column; }
      .board { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
    }
    @media (max-width: 560px) {
      aside, main { padding: 18px; }
      .board { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
      }
      button:hover { transform: none; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <div>
          <h1>转播助手</h1>
        </div>
        <div class="brand-mark">播</div>
      </div>
      <div class="status-strip">
        <div class="pill" id="liveState">等待解析</div>
      </div>
      <div class="form-stack">
        <div class="field-row">
          <label for="roomUrl">直播间链接</label>
          <input id="roomUrl" autocomplete="off" placeholder="粘贴 DouyinLiveRecorder 支持的直播间链接，或 .flv/.m3u8 直链">
        </div>
        <div class="field-row">
          <label for="outputMode">输出模式</label>
          <select id="outputMode">
            <option value="auto">自动兼容</option>
            <option value="hls">HLS 代理</option>
            <option value="transcode">转码 H.264</option>
            <option value="flv">FLV 直通</option>
          </select>
        </div>
        <div class="field-row">
          <label for="quality">清晰度</label>
          <select id="quality">
            <option value="OD">原画</option>
            <option value="UHD">超清</option>
            <option value="HD">高清</option>
            <option value="SD">标清</option>
            <option value="LD">流畅</option>
          </select>
        </div>
        <details>
          <summary>高级设置</summary>
          <div class="form-stack">
            <div class="field-row">
              <label for="cookie">平台 Cookie</label>
              <textarea id="cookie" placeholder="需要登录态的平台可在此填写 Cookie"></textarea>
            </div>
            <div class="field-row">
              <label for="proxy">上游代理</label>
              <input id="proxy" placeholder="127.0.0.1:7890">
            </div>
            <div class="field-row">
              <label for="preset">转码 preset</label>
              <input id="preset" value="veryfast">
            </div>
          </div>
        </details>
        <div class="actions">
          <button class="toggle" id="playBtn">播放</button>
          <button class="danger" id="shutdownBtn">退出</button>
        </div>
      </div>
    </aside>
    <main>
      <div class="main-head">
        <h2>转播工作台</h2>
        <div class="pill" id="runtimeState">后台运行中</div>
      </div>
      <section class="board">
        <div class="tile"><div class="k">上游状态</div><div class="v" id="upstream">-</div></div>
        <div class="tile room-info"><div class="k">直播间</div><div class="v" id="roomInfo">-</div></div>
        <div class="tile"><div class="k">输出</div><div class="v" id="selectedType">-</div></div>
        <div class="tile"><div class="k">编码</div><div class="v" id="codec">-</div></div>
        <div class="tile"><div class="k">OBS 连接</div><div class="v" id="clients">0</div></div>
      </section>
      <section class="wide">
        <h2>OBS 固定地址</h2>
        <div class="url"><code id="obsUrl">http://127.0.0.1:5000/live</code><button class="secondary" id="copyBtn">复制</button></div>
        <div class="obs-guide" aria-label="OBS 配置说明">
          <div class="obs-guide-title">OBS 配置</div>
          <ol>
            <li>在 OBS 中添加“媒体源”。</li>
            <li>取消勾选“本地文件”。</li>
            <li>输入框填写：<code>http://127.0.0.1:5000/live</code></li>
          </ol>
        </div>
      </section>
      <section class="wide">
        <h2>局域网地址</h2>
        <div id="lanUrls">-</div>
      </section>
      <section class="wide">
        <h2>最近日志</h2>
        <div class="logs" id="logs"></div>
      </section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let formDirty = false;
    let formHydrated = false;
    let shuttingDown = false;
    const editableIds = ['roomUrl', 'outputMode', 'quality', 'cookie', 'proxy', 'preset'];
    function fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString(); }
    function setPlaceholder(element, text='-') {
      element.textContent = text;
    }
    function renderLanUrls(urls) {
      const container = $('lanUrls');
      container.replaceChildren();
      if (!urls || urls.length === 0) {
        setPlaceholder(container);
        return;
      }
      urls.forEach((url) => {
        const row = document.createElement('div');
        row.className = 'url';
        const code = document.createElement('code');
        code.textContent = url;
        row.appendChild(code);
        container.appendChild(row);
      });
    }
    function renderLogs(logs) {
      const container = $('logs');
      container.replaceChildren();
      (logs || []).forEach((entry) => {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = `[${fmtTime(entry.time)}] ${entry.level}: ${entry.message}`;
        container.appendChild(line);
      });
    }
    function appendLog(message) {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = message;
      $('logs').appendChild(line);
    }
    function hydrateForm(settings, force=false) {
      if (!force && (formDirty || formHydrated)) return;
      $('roomUrl').value = settings.room_url || '';
      $('outputMode').value = settings.output_mode || 'auto';
      $('quality').value = settings.quality || 'OD';
      $('proxy').value = settings.upstream_proxy || '';
      $('preset').value = settings.transcode_preset || 'veryfast';
      formHydrated = true;
      formDirty = false;
    }
    async function status(resolve=false, hydrate=false) {
      if (shuttingDown) return;
      let data;
      try {
        const res = await fetch(resolve ? '/api/control' : '/api/status', resolve ? {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'resolve'})
        } : undefined);
        if (!res.ok) throw new Error(`status ${res.status}`);
        data = await res.json();
      } catch (error) {
        $('liveState').textContent = '后台服务不可达，请重新启动转播助手';
        $('liveState').className = 'pill bad';
        $('runtimeState').textContent = '连接中断';
        $('runtimeState').className = 'pill bad';
        $('upstream').textContent = '不可用';
        $('clients').textContent = '-';
        appendLog('后台服务暂时不可达，页面已停止自动刷新状态。');
        shuttingDown = true;
        return;
      }
      const s = data.settings;
      const r = data.result || {};
      hydrateForm(s, hydrate);
      $('upstream').textContent = data.stream_enabled ? (r.ok ? (r.is_live ? '直播中' : '未开播') : '不可用') : '已停止';
      $('roomInfo').textContent = [r.anchor_name, r.title].filter(Boolean).join(' / ') || '-';
      $('selectedType').textContent = r.selected_type || '-';
      $('codec').textContent = r.codec ? (r.hevc ? r.codec + ' HEVC' : r.codec) : '-';
      $('clients').textContent = data.active_clients;
      $('obsUrl').textContent = data.obs_url;
      renderLanUrls(data.lan_urls || []);
      $('liveState').textContent = data.stream_enabled ? (r.ok ? '代理就绪' : (r.error || '等待解析')) : '输出已停止';
      $('liveState').className = 'pill ' + (data.stream_enabled && r.ok ? 'good' : (!data.stream_enabled || r.error ? 'bad' : ''));
      $('runtimeState').textContent = data.stream_enabled ? '后台运行中' : '输出已停止';
      $('runtimeState').className = 'pill ' + (data.stream_enabled ? 'good' : 'bad');
      $('playBtn').className = 'toggle ' + (data.stream_enabled ? 'on' : 'off');
      renderLogs(data.logs || []);
    }
    function formPayload(resolve=true) {
      return {
        room_url: $('roomUrl').value.trim(),
        output_mode: $('outputMode').value,
        quality: $('quality').value,
        cookie: $('cookie').value,
        upstream_proxy: $('proxy').value.trim(),
        transcode_preset: $('preset').value.trim(),
        resolve
      };
    }
    async function applySettings(resolve=true) {
      const payload = {
        ...formPayload(resolve),
        enable_stream: true
      };
      await fetch('/api/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      formDirty = false;
      await status(false, true);
    }
    async function play() {
      $('playBtn').disabled = true;
      try {
        await applySettings(true);
      } finally {
        $('playBtn').disabled = false;
      }
    }
    async function shutdownServer() {
      if (!confirm('关闭后台服务后，OBS 将无法继续从本地地址拉流。确定退出？')) return;
      shuttingDown = true;
      $('shutdownBtn').disabled = true;
      $('playBtn').disabled = true;
      await fetch('/api/shutdown', { method: 'POST' });
      $('liveState').textContent = '后台服务正在退出';
      $('liveState').className = 'pill bad';
      $('runtimeState').textContent = '正在退出';
      $('runtimeState').className = 'pill bad';
      appendLog('后台服务正在退出。');
    }
    editableIds.forEach(id => $(id).addEventListener('input', () => { formDirty = true; }));
    $('playBtn').addEventListener('click', play);
    $('shutdownBtn').addEventListener('click', shutdownServer);
    $('copyBtn').addEventListener('click', () => navigator.clipboard.writeText($('obsUrl').textContent));
    status(false, true);
    setInterval(() => status(false), 3000);
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
