# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path


root = Path.cwd()

pathex = [str(root), str(root / "DouyinLiveRecorder")]
datas = [
    (str(root / "DouyinLiveRecorder" / "src"), "DouyinLiveRecorder/src"),
    (str(root / "DouyinLiveRecorder" / "i18n"), "DouyinLiveRecorder/i18n"),
    (str(root / "DouyinLiveRecorder" / "config"), "DouyinLiveRecorder/config"),
    (str(root / "DouyinLiveRecorder" / "ffmpeg_install.py"), "DouyinLiveRecorder"),
    (str(root / "DouyinLiveRecorder" / "i18n.py"), "DouyinLiveRecorder"),
    (str(root / "DouyinLiveRecorder" / "LICENSE"), "DouyinLiveRecorder"),
    (str(root / "vendor" / "ffmpeg"), "vendor/ffmpeg"),
    (str(root / "vendor" / "node"), "vendor/node"),
]
hiddenimports = [
    "src",
    "src.spider",
    "src.stream",
    "src.utils",
    "src.logger",
    "src.initializer",
    "src.http_clients.async_http",
    "src.http_clients.sync_http",
    "Crypto",
    "Crypto.Cipher",
    "Crypto.Hash",
    "Crypto.Util",
    "loguru",
    "requests",
    "httpx",
    "execjs",
]

main_analysis = Analysis(
    [str(root / "local_proxy" / "__main__.py")],
    pathex=pathex,
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
main_pyz = PYZ(main_analysis.pure)
main_exe = EXE(
    main_pyz,
    main_analysis.scripts,
    [],
    exclude_binaries=True,
    name="video-box",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    main_exe,
    main_analysis.binaries,
    main_analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="video-box",
)
