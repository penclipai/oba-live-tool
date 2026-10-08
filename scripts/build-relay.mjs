import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32') {
  console.log('Skipping Windows-only relay runtime build.')
  process.exit(0)
}

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './scripts/build-video-box.ps1'],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
