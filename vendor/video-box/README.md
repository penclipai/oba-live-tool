# OBA Video Relay build input

This directory is the tracked, reproducible build input for the Windows relay
runtime. `scripts/build-video-box.ps1` clones
`penclipai/DouyinLiveRecorder` at `add187f8d8c7ff7d231fcbee45cbb4f1ed247d3a`,
applies `patch_upstream_logger.py`, verifies the fixed FFmpeg 8.1.1 and Node.js
24.19.0 archives,
and produces `build/video-box-runtime`.

The patch redirects the upstream Loguru files to `VIDEO_BOX_DATA_DIR`,
which Electron supplies through `--data-dir`; application settings, locks, and
instance metadata use that same directory. It also requires the bundled Node
runtime and prevents the upstream initializer from downloading one at runtime.
No user data belongs in this tree or in the packaged runtime.

The local proxy treats every FLV upstream reconnect or source-mode change as a
new HTTP session. This preserves FLV container timestamps and lets OBS reconnect
cleanly instead of concatenating unrelated byte streams. HLS resource URLs are
short-lived and bounded, and stalled transcoder or downstream media connections
are closed so they cannot consume a relay slot indefinitely.

Electron only cleans up the relay process tree that it started. A valid relay
already listening on the configured port may be used but is never adopted or
terminated automatically, including one left after a previous crash. The
explicit maintenance close action may close a verified existing relay.
