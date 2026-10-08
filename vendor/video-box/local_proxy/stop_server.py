from __future__ import annotations

import configparser
import json
import os
import sys
from pathlib import Path

import requests


if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

if getattr(sys, "frozen", False):
    PROJECT_ROOT = Path(sys.executable).resolve().parent
else:
    PROJECT_ROOT = Path(__file__).resolve().parents[1]

CONFIG_DIR = PROJECT_ROOT / "config"
CONFIG_FILE = CONFIG_DIR / "local_proxy.ini"
INSTANCE_INFO_FILE = CONFIG_DIR / "instance.json"
DEFAULT_PORT = 5000


def read_port() -> int:
    for candidate in read_instance_port(), read_config_port():
        if 1 <= candidate <= 65535:
            return candidate
    return DEFAULT_PORT


def read_instance_port() -> int:
    try:
        data = json.loads(INSTANCE_INFO_FILE.read_text(encoding="utf-8"))
        return int(data.get("port", DEFAULT_PORT))
    except (OSError, TypeError, ValueError):
        return DEFAULT_PORT


def read_config_port() -> int:
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(CONFIG_FILE, encoding="utf-8-sig")
        return int(parser.get("local_proxy", "port", fallback=str(DEFAULT_PORT)))
    except (OSError, ValueError):
        return DEFAULT_PORT


def main() -> int:
    port = read_port()
    try:
        response = requests.post(f"http://127.0.0.1:{port}/api/shutdown", timeout=3)
        if response.status_code in {200, 404}:
            return 0
        return 1
    except requests.RequestException:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
