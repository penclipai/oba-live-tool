"""Build-time compatibility patch for the pinned DouyinLiveRecorder revision.

The upstream module derives its log directory from ``sys.argv[0]``.  Frozen
video-box would therefore write into the install directory, so this narrow
patch honours the runtime's explicit VIDEO_BOX_DATA_DIR instead. It also makes
the bundled Node runtime mandatory and prevents upstream from downloading a
mutable Node copy next to the executable.
"""

from __future__ import annotations

import sys
from pathlib import Path


logger_path = Path(sys.argv[1]) / "src" / "logger.py"
source = logger_path.read_text(encoding="utf-8")
old = "script_path = os.path.split(os.path.realpath(sys.argv[0]))[0]"
new = "script_path = os.environ.get('VIDEO_BOX_DATA_DIR') or os.path.split(os.path.realpath(sys.argv[0]))[0]\nos.makedirs(os.path.join(script_path, 'logs'), exist_ok=True)"
if old not in source:
    raise SystemExit(f"Expected upstream logger statement was not found: {logger_path}")
logger_path.write_text(source.replace(old, new, 1), encoding="utf-8")

init_path = Path(sys.argv[1]) / "src" / "__init__.py"
expected_init = """import os
import sys
from pathlib import Path
from .initializer import check_node

current_file_path = Path(__file__).resolve()
current_dir = current_file_path.parent
JS_SCRIPT_PATH = current_dir / 'javascript'

execute_dir = os.path.split(os.path.realpath(sys.argv[0]))[0]
node_execute_dir = Path(execute_dir) / 'node'
current_env_path = os.environ.get('PATH')
os.environ['PATH'] = str(node_execute_dir) + os.pathsep + current_env_path
check_node()
"""
patched_init = """import os
import sys
from pathlib import Path

current_file_path = Path(__file__).resolve()
current_dir = current_file_path.parent

if getattr(sys, 'frozen', False):
    bundle_root = Path(getattr(sys, '_MEIPASS'))
    JS_SCRIPT_PATH = bundle_root / 'DouyinLiveRecorder' / 'src' / 'javascript'
    node_execute_dir = bundle_root / 'vendor' / 'node'
else:
    JS_SCRIPT_PATH = current_dir / 'javascript'
    node_execute_dir = current_file_path.parents[2] / 'vendor' / 'node'
node_executable = node_execute_dir / 'node.exe'
if not node_executable.is_file():
    raise RuntimeError(f'Bundled Node runtime is missing: {node_executable}')
os.environ['PATH'] = str(node_execute_dir) + os.pathsep + os.environ.get('PATH', '')
"""
init_source = init_path.read_text(encoding="utf-8")
if init_source != expected_init:
    raise SystemExit(f"Expected upstream initializer was not found: {init_path}")
init_path.write_text(patched_init, encoding="utf-8")
