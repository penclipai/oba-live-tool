import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const validateStability = process.argv.includes('--stability')
const output = path.join(root, 'build', 'relay-installer-qa')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'oba-relay-install-'))
const installDir = path.join(scratch, 'application')
const installer = path.join(output, 'relay-qa.exe')
let installedExe

async function run(command, args, timeout = 600000) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: root,
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
}

async function waitForInstalledExecutable() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const entries = await fs.readdir(installDir).catch(() => [])
    const name = entries.find(value => value.toLowerCase() === 'oba-live-tool-relay-qa.exe')
    if (name) return path.join(installDir, name)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('NSIS did not install the QA application')
}

try {
  assert.equal(process.platform, 'win32', 'NSIS relay validation requires Windows')
  await fs.access(path.join(root, 'build', 'video-box-runtime', 'video-box.exe'))
  await fs.access(path.join(root, 'dist-electron', 'main', 'index.js'))
  process.stdout.write('Building isolated QA installer from the current application and runtime\n')
  await run(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config.appId=com.qbw.obalivetool.relayqa',
    '--config.productName=oba-live-tool-relay-qa',
    '--config.directories.output=build/relay-installer-qa',
    '--config.win.artifactName=relay-qa.exe',
    '--config.nsis.runAfterFinish=false',
  ])
  await run(installer, ['/S', `/D=${installDir}`], 120000)
  installedExe = await waitForInstalledExecutable()
  assert.ok(path.resolve(installedExe).startsWith(`${path.resolve(scratch)}${path.sep}`))
  process.stdout.write(`Validating installed application: ${installedExe}\n`)
  await run(process.execPath, [
    path.join(root, 'scripts', 'test-relay-e2e.mjs'),
    `--executable=${installedExe}`,
  ])
  if (validateStability) {
    await run(process.execPath, [
      path.join(root, 'scripts', 'test-video-box-stability.mjs'),
      `--runtime=${path.join(installDir, 'resources', 'video-box', 'video-box.exe')}`,
      `--report-dir=${path.join(root, 'test-results', 'relay-stability-installed')}`,
      '--smoke',
    ])
  }
} catch (error) {
  process.exitCode = 1
  process.stderr.write(`${error.stack}\n`)
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
} finally {
  {
    const entries = await fs.readdir(installDir).catch(() => [])
    const uninstallName = entries.find(value => /^uninstall.*\.exe$/i.test(value))
    if (uninstallName) {
      const uninstaller = path.resolve(installDir, uninstallName)
      assert.ok(uninstaller.startsWith(`${path.resolve(scratch)}${path.sep}`))
      await run(uninstaller, ['/S'], 120000)
    }
  }
}
