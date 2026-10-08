import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { _electron } from 'playwright'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const executableArg = process.argv.find(arg => arg.startsWith('--executable='))
const executable = executableArg?.slice('--executable='.length)
const electronExecutableArg = process.argv.find(arg => arg.startsWith('--electron-executable='))
const electronExecutable = electronExecutableArg?.slice('--electron-executable='.length)
const appEntryArg = process.argv.find(arg => arg.startsWith('--app-entry='))
const appEntry = appEntryArg?.slice('--app-entry='.length)
const captureUiBaseline = process.argv.includes('--capture-ui-baseline')
const mode = executable ? 'packaged' : 'development'
const runtimeRoot = executable
  ? path.join(path.dirname(executable), 'resources', 'video-box')
  : path.join(root, 'build', 'video-box-runtime')
const ffmpeg = path.join(runtimeRoot, '_internal', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const backendExe = path.join(runtimeRoot, 'video-box.exe')
const reportDir = path.join(root, 'test-results', `relay-${mode}`)
const uiReportDir = path.join(root, 'test-results', 'relay-ui')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'oba-relay-e2e-'))
const results = []
const startedAt = new Date().toISOString()
let backendSha256
let application
let page
let profileNumber = 0
let fixtureServer
let foreignServer
const decoders = new Set()
const fixtureStreams = new Set()
const electronLaunchPreload = path.join(scratch, 'electron-e2e-preload.cjs')
let electronLaunchPreloadReady = false

class BaselineCaptured extends Error {}

function log(message) {
  process.stdout.write(`${message}\n`)
}

async function eventually(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let failure
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      failure = error
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${label}${failure ? `: ${failure.message}` : ''}`)
}

async function expectAttribute(locator, name, expected) {
  await eventually(
    async () => (await locator.getAttribute(name)) === expected,
    `expected ${name}=${expected}`,
  )
}

async function step(name, action) {
  const started = Date.now()
  try {
    await action()
    results.push({ name, passed: true, durationMs: Date.now() - started })
    log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, passed: false, durationMs: Date.now() - started, error: error.message })
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
        .catch(() => {})
    }
    throw error
  }
}

async function status() {
  const response = await fetch('http://127.0.0.1:5000/api/status', {
    signal: AbortSignal.timeout(2000),
  })
  assert.equal(response.status, 200)
  return response.json()
}

async function backendProcesses() {
  const escaped = backendExe.replaceAll("'", "''")
  const command = `$relayProcesses = @(Get-CimInstance Win32_Process -Filter "Name='video-box.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' }); ConvertTo-Json -Compress -InputObject @($relayProcesses | Select-Object ProcessId,ParentProcessId)`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
  })
  return JSON.parse(stdout.trim() || '[]')
}

async function ensureElectronLaunchPreload() {
  if (electronLaunchPreloadReady) return
  await fs.writeFile(
    electronLaunchPreload,
    `const { app } = require('electron')
const appendSwitch = app.commandLine.appendSwitch.bind(app.commandLine)
app.commandLine.appendSwitch = (name, value) =>
  appendSwitch(name, name === 'remote-debugging-port' ? '0' : value)
`,
  )
  electronLaunchPreloadReady = true
}

async function assertStopped() {
  await eventually(async () => {
    try {
      await status()
      return false
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error
      return (await backendProcesses()).length === 0 && (await transcodeProcesses()).length === 0
    }
  }, 'relay process or port survived app exit')
}

async function transcodeProcesses() {
  const escaped = ffmpeg.replaceAll("'", "''")
  const command = `$relayProcesses = @(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' }); ConvertTo-Json -Compress -InputObject @($relayProcesses | Select-Object ProcessId,ParentProcessId)`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
  })
  const decoderPids = new Set([...decoders].map(decoder => decoder.pid))
  return JSON.parse(stdout.trim() || '[]').filter(item => !decoderPids.has(item.ProcessId))
}

async function launch() {
  const profile = path.join(scratch, `profile-${++profileNumber}`)
  await fs.mkdir(profile, { recursive: true })
  await ensureElectronLaunchPreload()
  const args = ['-r', electronLaunchPreload, `--user-data-dir=${profile}`]
  const developmentEntry =
    appEntry || (!executable ? path.join(root, 'dist-electron', 'main', 'index.js') : undefined)
  if (developmentEntry) args.splice(2, 0, developmentEntry)
  application = await _electron.launch({
    ...(executable || electronExecutable
      ? { executablePath: executable || electronExecutable }
      : {}),
    args,
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 45000,
  })
  page = await application.firstWindow()
  page.setDefaultTimeout(20000)
  await page.evaluate(() => {
    window.location.hash = '/relay'
  })
  await page.locator('#relay-room-url').waitFor()
  const actualProfile = await application.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile).toLowerCase(), path.resolve(profile).toLowerCase())
  return profile
}

async function setContentSize(width, height) {
  const bounds = await application.evaluate(
    ({ BrowserWindow }, requested) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(requested.width, requested.height)
      return window.getContentBounds()
    },
    { width, height },
  )
  await page.waitForTimeout(150)
  return bounds
}

async function captureBaseline() {
  await fs.mkdir(uiReportDir, { recursive: true })
  await launch()
  const bounds = await setContentSize(1280, 800)
  const workspace = page.locator('#relay-room-url')
  const box = await workspace.boundingBox()
  assert.ok(box, 'baseline relay room input is not visible')
  await page.screenshot({ path: path.join(uiReportDir, 'before1280.png') })
  await fs.writeFile(
    path.join(uiReportDir, 'before1280.json'),
    JSON.stringify(
      {
        contentBounds: bounds,
        roomUrlBox: box,
        source: {
          executable: executable || electronExecutable || null,
          appEntry: appEntry || null,
        },
      },
      null,
      2,
    ),
  )
  log(`Baseline: ${path.join(uiReportDir, 'before1280.png')}`)
  await closeApplication()
}

async function assertCompactRelayViewport(width, height, variant = '') {
  await fs.mkdir(uiReportDir, { recursive: true })
  await setContentSize(width, height)
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const required = [
    page.getByRole('heading', { name: '转播', exact: true }),
    page.locator('#relay-room-url'),
    page.getByRole('button', { name: '保存并开始转播', exact: true }),
    page.getByText('OBS 固定地址', { exact: true }),
    page.getByTestId('relay-status'),
    page.getByTestId('relay-logs'),
    page.getByTestId('global-logs'),
  ]
  for (const locator of required) {
    await locator.waitFor({ state: 'visible' })
    const box = await locator.boundingBox()
    assert.ok(
      box,
      `${await locator.evaluate(element => element.outerHTML.slice(0, 120))} has no box`,
    )
    assert.ok(box.x >= 0 && box.y >= 0, 'relay control escaped the viewport origin')
    assert.ok(
      box.x + box.width <= viewport.width + 1,
      `relay control overflows horizontally: ${JSON.stringify({ box, viewport, target: { width, height } })}`,
    )
    assert.ok(
      box.y + box.height <= viewport.height + 1,
      `relay control is not visible in the first screen: ${JSON.stringify({ box, viewport, target: { width, height } })}`,
    )
  }
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  assert.ok(
    overflow.scrollWidth <= overflow.clientWidth,
    `horizontal overflow: ${JSON.stringify(overflow)}`,
  )
  await page.screenshot({
    path: path.join(uiReportDir, `compact${variant}-${width}x${height}.png`),
  })
}

async function globalLogHeight() {
  return page
    .getByTestId('global-logs')
    .evaluate(element => Math.round(element.getBoundingClientRect().height))
}

async function closeApplication(method = 'quit') {
  if (!application) return
  const closed = application.waitForEvent('close', { timeout: 30000 })
  if (method === 'window') await page.close()
  else await application.evaluate(({ app }) => app.quit())
  await closed
  application = undefined
  page = undefined
}

async function maintenance() {
  const button = page.getByRole('button', { name: '关闭后台服务', exact: true })
  if (!(await button.isVisible())) await page.getByText('维护操作', { exact: true }).click()
}

async function save(source, output = '自动') {
  await page.locator('#relay-room-url').fill(source)
  await page.getByRole('combobox', { name: '输出模式', exact: true }).click()
  await page.getByRole('option', { name: output, exact: true }).click()
  await page.getByRole('button', { name: '保存并开始转播', exact: true }).click()
  await eventually(
    async () => {
      const data = await status()
      return data.settings.room_url === source && data.result?.ok && data.stream_enabled
    },
    'saved source did not become active',
    45000,
  )
  await eventually(
    async () =>
      !(await page.getByRole('button', { name: '保存并开始转播', exact: true }).isDisabled()),
    'save action stayed busy',
  )
}

async function decode(url = 'http://127.0.0.1:5000/live') {
  const { stdout, stderr } = await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rw_timeout',
      '10000000',
      '-i',
      url,
      '-t',
      '1',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'framemd5',
      '-',
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  )
  assert.match(stdout, /^0,\s*\d+/m, `no decoded video frames: ${stderr}`)
  assert.match(stdout, /^1,\s*\d+/m, `no decoded audio frames: ${stderr}`)
}

async function startContinuousDecoder() {
  let stderr = ''
  const decoder = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rw_timeout',
      '10000000',
      '-i',
      'http://127.0.0.1:5000/live',
      '-f',
      'null',
      '-',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  decoder.stderr.setEncoding('utf8')
  decoder.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  decoders.add(decoder)
  decoder.once('exit', () => decoders.delete(decoder))
  try {
    await eventually(
      async () => (await status()).active_clients > 0,
      'decoder did not establish relay connection',
    )
  } catch (error) {
    const statusContext = await status().catch(statusError => ({ error: statusError.message }))
    const liveContext = await fetch('http://127.0.0.1:5000/live', {
      signal: AbortSignal.timeout(2000),
    })
      .then(async response => {
        await response.body?.cancel()
        return { status: response.status, contentType: response.headers.get('content-type') }
      })
      .catch(liveError => ({ error: liveError.message }))
    throw new Error(
      `${error.message}; decoderExit=${decoder.exitCode}; decoderStderr=${stderr || '(empty)'}; status=${JSON.stringify(statusContext)}; live=${JSON.stringify(liveContext)}`,
    )
  }
  return decoder
}

async function killDecoders() {
  for (const decoder of decoders) {
    decoder.kill()
    await once(decoder, 'exit').catch(() => {})
  }
}

async function makeFixtures() {
  const media = path.join(scratch, 'media')
  await fs.mkdir(media)
  const input = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '10',
    '-c:a',
    'aac',
  ]
  await execFileAsync(ffmpeg, [...input, '-f', 'flv', path.join(media, 'live.flv')], {
    windowsHide: true,
    timeout: 30000,
  })
  await execFileAsync(
    ffmpeg,
    [
      ...input,
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      path.join(media, 'part%03d.ts'),
      path.join(media, 'live.m3u8'),
    ],
    { windowsHide: true, timeout: 30000 },
  )
  fixtureServer = http.createServer(async (request, response) => {
    const name = path.basename(new URL(request.url, 'http://localhost').pathname)
    try {
      if (name === 'live.flv') {
        response.setHeader('Content-Type', 'video/x-flv')
        response.setHeader('Cache-Control', 'no-store')
        const stream = spawn(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-re',
            '-stream_loop',
            '-1',
            '-i',
            path.join(media, 'live.flv'),
            '-c',
            'copy',
            '-f',
            'flv',
            'pipe:1',
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
        )
        fixtureStreams.add(stream)
        const stopStream = () => {
          stream.stdout.unpipe(response)
          if (stream.exitCode === null) stream.kill()
        }
        stream.once('exit', () => fixtureStreams.delete(stream))
        request.once('aborted', stopStream)
        response.once('close', stopStream)
        stream.stdout.pipe(response)
        return
      }
      const data = await fs.readFile(path.join(media, name))
      response.setHeader(
        'Content-Type',
        name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : name.endsWith('.flv')
            ? 'video/x-flv'
            : 'video/mp2t',
      )
      response.end(data)
    } catch {
      response.writeHead(404).end()
    }
  })
  fixtureServer.listen(0, '127.0.0.1')
  await once(fixtureServer, 'listening')
  return `http://127.0.0.1:${fixtureServer.address().port}`
}

async function closeServer(server) {
  if (!server) return
  if (server === fixtureServer) {
    for (const stream of fixtureStreams) {
      stream.kill()
      await once(stream, 'exit').catch(() => {})
    }
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

async function resourceManifest(directory = runtimeRoot) {
  const entries = []
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(...(await resourceManifest(target)))
    else {
      const stat = await fs.stat(target)
      entries.push([
        path.relative(runtimeRoot, target).replaceAll('\\', '/'),
        stat.size,
        stat.mtimeMs,
      ])
    }
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]))
}

try {
  assert.equal(process.platform, 'win32', 'Windows relay E2E requires Windows')
  await fs.mkdir(reportDir, { recursive: true })
  if (captureUiBaseline) {
    await captureBaseline()
    throw new BaselineCaptured()
  }
  await fs.rm(path.join(reportDir, 'failure.png'), { force: true })
  await fs.access(backendExe)
  backendSha256 = createHash('sha256')
    .update(await fs.readFile(backendExe))
    .digest('hex')
  await fs.access(ffmpeg)
  try {
    await status()
    throw new Error(
      'Port 5000 is already serving a relay; refusing to disturb an existing instance',
    )
  } catch (error) {
    if (error.message.includes('refusing')) throw error
    if (error.cause?.code !== 'ECONNREFUSED') throw error
  }
  const before = await resourceManifest()
  assert.ok(
    before.every(
      ([name]) => !/^config\/|(^|\/)logs(\/|$)|\.(lock|log)$|instance\.json$/.test(name),
    ),
    'runtime contains mutable state',
  )
  await step('frozen platform modules use bundled Node with no system Node', async () => {
    const dataDir = path.join(scratch, 'runtime-check')
    await fs.mkdir(dataDir)
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
    const isolatedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    )
    isolatedEnv.PATH = `${path.join(windowsRoot, 'System32')}${path.delimiter}${windowsRoot}`
    await execFileAsync(backendExe, ['--verify-runtime', '--data-dir', dataDir], {
      windowsHide: true,
      env: isolatedEnv,
      timeout: 45000,
    })
    const diagnostic = JSON.parse(
      await fs.readFile(path.join(dataDir, 'runtime-check.json'), 'utf8'),
    )
    assert.equal(diagnostic.ok, true)
    assert.equal(diagnostic.nodeVersion, 'v24.19.0')
    assert.deepEqual(await resourceManifest(), before)
  })
  const source = await makeFixtures()
  let profile

  await step('initial idle state and isolated profile', async () => {
    profile = await launch()
    await page.getByText(/服务(?:尚)?未启动。点击主按钮后会自动启动本地转播服务。/).waitFor()
    assert.equal(await page.locator('#relay-room-url').inputValue(), '')
  })
  await step('compact relay layout keeps primary controls in the first screen', async () => {
    for (const [width, height] of [
      [1280, 800],
      [1366, 768],
      [1024, 768],
    ]) {
      await assertCompactRelayViewport(width, height)
    }
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    try {
      await assertCompactRelayViewport(1280, 800, '-dark')
    } finally {
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    }
    assert.equal(await globalLogHeight(), 40)
  })
  await step(
    'relay-only global log collapses and retains its chosen state across navigation',
    async () => {
      await setContentSize(1280, 800)
      const globalLogs = page.getByTestId('global-logs')
      const toggle = page.getByTestId('global-log-toggle')
      await expectAttribute(toggle, 'aria-expanded', 'false')
      assert.equal(await globalLogHeight(), 40)
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('log', {
          date: new Date(),
          data: ['compact-global-log-sentinel'],
          scope: 'QA',
          level: 'warn',
        })
      })
      await eventually(
        async () => (await globalLogs.textContent())?.includes('compact-global-log-sentinel'),
        'collapsed global log did not retain an incoming IPC message',
      )
      await toggle.focus()
      await page.keyboard.press('Space')
      await expectAttribute(toggle, 'aria-expanded', 'true')
      await page.waitForTimeout(250)
      assert.equal(await globalLogHeight(), 180)
      await globalLogs.getByText('compact-global-log-sentinel', { exact: true }).waitFor()

      await page.evaluate(() => {
        window.location.hash = '/'
      })
      await page.getByTestId('global-logs').waitFor()
      await page.waitForTimeout(250)
      assert.equal(await globalLogHeight(), 180)
      assert.equal(await page.getByTestId('global-log-toggle').count(), 0)

      await page.evaluate(() => {
        window.location.hash = '/relay/'
      })
      await page.locator('#relay-room-url').waitFor()
      await expectAttribute(
        globalLogs.locator('[data-testid="global-log-toggle"]'),
        'aria-expanded',
        'true',
      )
      assert.equal(await globalLogHeight(), 180)
      await globalLogs.locator('[data-testid="global-log-toggle"]').focus()
      await page.keyboard.press('Space')
      await expectAttribute(
        globalLogs.locator('[data-testid="global-log-toggle"]'),
        'aria-expanded',
        'false',
      )
      await page.waitForTimeout(250)
      assert.equal(await globalLogHeight(), 40)
    },
  )
  await step('real concurrent starts own exactly one backend', async () => {
    const statuses = await page.evaluate(() =>
      Promise.all(Array.from({ length: 4 }, () => window.ipcRenderer.invoke('tasks:relay:start'))),
    )
    assert.ok(statuses.every(value => value.serviceRunning))
    assert.equal((await backendProcesses()).length, 1)
    const snapshot = await status()
    assert.equal(snapshot.service_id, 'oba-video-relay')
    assert.equal(snapshot.protocol_version, 1)
  })
  await step('FLV source saves, records history and decodes video/audio', async () => {
    await save(`${source}/live.flv`)
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      globalThis.relayClipboardTestState = { original, value: undefined }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async value => {
            globalThis.relayClipboardTestState.value = value
          },
        },
      })
    })
    try {
      await page
        .getByTestId('relay-workspace')
        .getByRole('button', { name: '复制', exact: true })
        .click()
      await eventually(
        async () => Boolean(await page.evaluate(() => globalThis.relayClipboardTestState.value)),
        'OBS URL was not copied',
      )
      assert.equal(
        await page.evaluate(() => globalThis.relayClipboardTestState.value),
        (await status()).obs_url,
      )
    } finally {
      await page.evaluate(() => {
        const { original } = globalThis.relayClipboardTestState
        if (original) Object.defineProperty(navigator, 'clipboard', original)
        else delete navigator.clipboard
        delete globalThis.relayClipboardTestState
      })
    }
    await decode()
    await page.getByText('已保存 1 条', { exact: true }).waitFor()
    const ini = await fs.readFile(
      path.join(profile, 'video-relay', 'config', 'local_proxy.ini'),
      'utf8',
    )
    assert.ok(ini.includes(`${source}/live.flv`))
  })
  await step(
    'collapsed relay logs retain polling output, restore auto-scroll, and stay cleared',
    async () => {
      const relayLogs = page.getByTestId('relay-logs')
      const toggle = page.getByTestId('relay-log-toggle')
      await expectAttribute(toggle, 'aria-expanded', 'false')
      await eventually(
        async () => /[1-9]\d* 条记录/.test((await relayLogs.textContent()) || ''),
        'relay logs did not retain output while collapsed',
      )
      await toggle.click()
      await expectAttribute(toggle, 'aria-expanded', 'true')
      const content = page.getByTestId('relay-log-content')
      await content.waitFor({ state: 'visible' })
      assert.equal(
        Math.round(await content.evaluate(element => element.getBoundingClientRect().height)),
        160,
      )
      const autoScroll = page.getByRole('switch', { name: '自动滚动', exact: true })
      await expectAttribute(autoScroll, 'data-state', 'checked')
      const scrollPosition = await content.evaluate(element => {
        const viewport = element.querySelector('[data-radix-scroll-area-viewport]')
        if (!viewport) return null
        return { top: viewport.scrollTop, maximum: viewport.scrollHeight - viewport.clientHeight }
      })
      assert.ok(scrollPosition, 'relay log viewport is missing after expansion')
      assert.ok(
        scrollPosition.top >= Math.max(0, scrollPosition.maximum - 1),
        `relay log did not restore auto-scroll: ${JSON.stringify(scrollPosition)}`,
      )

      await page.getByRole('button', { name: '停止输出', exact: true }).click()
      await eventually(
        async () => !(await status()).stream_enabled,
        'stop did not quiet relay logs',
      )
      await page.waitForTimeout(2500)
      await page.getByTestId('relay-log-clear').click()
      await content.getByText('暂无日志，启动转播后会自动刷新。', { exact: true }).waitFor()
      await toggle.click()
      await expectAttribute(toggle, 'aria-expanded', 'false')
      await page.waitForTimeout(2500)
      await toggle.click()
      await expectAttribute(toggle, 'aria-expanded', 'true')
      await content.getByText('暂无日志，启动转播后会自动刷新。', { exact: true }).waitFor()
      await toggle.click()
      await expectAttribute(toggle, 'aria-expanded', 'false')
      await save(`${source}/live.flv`)
    },
  )
  await step('periodic polling preserves unsaved room and Cookie edits', async () => {
    await page.locator('#relay-room-url').fill('http://unsaved.example/live.flv')
    if (!(await page.locator('#relay-cookie').isVisible())) {
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    }
    await page.locator('#relay-cookie').fill('unsaved-synthetic-cookie')
    await new Promise(resolve => setTimeout(resolve, 4500))
    assert.equal(
      await page.locator('#relay-room-url').inputValue(),
      'http://unsaved.example/live.flv',
    )
    assert.equal(await page.locator('#relay-cookie').inputValue(), 'unsaved-synthetic-cookie')
    assert.equal((await status()).settings.room_url, `${source}/live.flv`)
    await page.locator('#relay-cookie').fill('')
    await save(`${source}/live.flv`)
  })
  await step('LAN media remains playable while the control plane is private', async () => {
    const adapter = Object.values(os.networkInterfaces())
      .flat()
      .find(value => value?.family === 'IPv4' && !value.internal)
    assert.ok(adapter, 'a non-loopback adapter is required to validate LAN access')
    const lanBase = `http://${adapter.address}:5000`
    for (const route of ['/', '/api/status', '/api/status?resolve=1']) {
      const response = await fetch(`${lanBase}${route}`, { signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 403)
    }
    await decode(`${lanBase}/live`)
    const crossOrigin = await fetch('http://127.0.0.1:5000/api/control', {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    })
    assert.equal(crossOrigin.status, 403)
    const simplePost = await fetch('http://127.0.0.1:5000/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'stop' }),
    })
    assert.equal(simplePost.status, 415)
    const oldResolve = await fetch('http://127.0.0.1:5000/api/status?resolve=1')
    assert.equal(oldResolve.status, 405)
    assert.equal((await status()).stream_enabled, true)
  })
  await step('forced resolve returns running state', async () => {
    await page.getByRole('button', { name: '刷新解析', exact: true }).click()
    await eventually(
      async () => !(await page.getByRole('button', { name: '刷新解析', exact: true }).isDisabled()),
      'resolve stayed busy',
    )
    assert.equal((await status()).stream_enabled, true)
  })
  await step('stop blocks output and save restarts it', async () => {
    await page.getByRole('button', { name: '停止输出', exact: true }).click()
    await eventually(async () => !(await status()).stream_enabled, 'stop did not disable output')
    const response = await fetch('http://127.0.0.1:5000/live', {
      signal: AbortSignal.timeout(3000),
    })
    assert.equal(response.status, 503)
    await save(`${source}/live.flv`)
    await decode()
  })
  await step('HLS playlist and segments decode video/audio', async () => {
    await save(`${source}/live.m3u8`, 'HLS')
    assert.equal((await status()).result.selected_type, 'hls')
    await decode()
  })
  await step('real ffmpeg transcode decodes video/audio', async () => {
    await save(`${source}/live.flv`, '转码为 FLV')
    assert.equal((await status()).result.selected_type, 'transcode')
    await decode()
  })
  await step('control panel opens only after verified startup', async () => {
    await application.evaluate(({ shell }) => {
      globalThis.relayOpenedUrls = []
      shell.openExternal = async url => {
        globalThis.relayOpenedUrls.push(url)
      }
    })
    await maintenance()
    await page.getByRole('button', { name: '打开原控制台', exact: true }).click()
    await eventually(
      async () => (await application.evaluate(() => globalThis.relayOpenedUrls)).length === 1,
      'panel did not open',
    )
    const panel = await fetch('http://127.0.0.1:5000/')
    assert.equal(panel.status, 200)
    assert.match(await panel.text(), /转播助手/)
  })
  await step('shutdown waits for exit and immediately restarts safely', async () => {
    await maintenance()
    await page.getByRole('button', { name: '关闭后台服务', exact: true }).click()
    await assertStopped()
    await eventually(
      async () =>
        !(await page.getByRole('button', { name: '保存并开始转播', exact: true }).isDisabled()),
      'shutdown stayed busy',
    )
    await save(`${source}/live.flv`, '转码为 FLV')
    assert.equal((await backendProcesses()).length, 1)
    await decode()
  })
  await step('normal window close frees relay, transcode and port', async () => {
    const decoder = await startContinuousDecoder()
    await page.screenshot({ path: path.join(reportDir, 'transcode.png'), fullPage: true })
    await closeApplication('window')
    await assertStopped()
    await eventually(() => decoder.exitCode !== null, 'decoder survived stopped relay', 15000)
  })
  await step('explicit app.quit also cleans a running backend', async () => {
    await launch()
    await save(`${source}/live.flv`)
    await closeApplication()
    await assertStopped()
  })
  await step('update installer invocation waits for relay cleanup', async () => {
    await launch()
    await save(`${source}/live.flv`)
    const marker = path.join(scratch, 'update-order.json')
    await application.evaluate(({ app }, markerPath) => {
      const relayRequire = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`)
      const updater = relayRequire('electron-updater').autoUpdater
      updater.quitAndInstall = () => {
        const socket = process.getBuiltinModule('net').connect(5000, '127.0.0.1')
        const finish = listening => {
          process.getBuiltinModule('fs').writeFileSync(markerPath, JSON.stringify({ listening }))
          socket.destroy()
          app.quit()
        }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      }
    }, marker)
    const closed = application.waitForEvent('close', { timeout: 30000 })
    await page.evaluate(() => window.ipcRenderer.invoke('updater:quitAndInstall')).catch(() => {})
    await closed
    application = undefined
    page = undefined
    assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).listening, false)
    await assertStopped()
  })
  await step('unknown port listener never receives Cookie settings', async () => {
    let posts = 0
    foreignServer = http.createServer((request, response) => {
      if (request.method === 'POST') posts++
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ anotherApplication: true }))
    })
    foreignServer.listen(5000, '127.0.0.1')
    await once(foreignServer, 'listening')
    await launch()
    const result = await page.evaluate(() =>
      window.ipcRenderer.invoke('tasks:relay:updateSettings', {
        room_url: 'http://example.test/live.flv',
        cookie: 'synthetic-cookie',
        resolve: true,
      }),
    )
    assert.equal(result.serviceRunning, false)
    assert.equal(result.errorCode, 'invalid-service')
    assert.equal(posts, 0)
    await application.evaluate(({ shell }) => {
      globalThis.relayOpenedUrls = []
      shell.openExternal = async url => {
        globalThis.relayOpenedUrls.push(url)
      }
    })
    const panel = await page.evaluate(() => window.ipcRenderer.invoke('tasks:relay:openPanel'))
    assert.equal(panel.ok, false)
    assert.equal((await application.evaluate(() => globalThis.relayOpenedUrls)).length, 0)
    assert.equal(posts, 0)
    await closeApplication()
    assert.equal(posts, 0)
    assert.equal((await backendProcesses()).length, 0)
    await closeServer(foreignServer)
    foreignServer = undefined
  })
  await step('runtime resources remain unchanged after all sessions', async () => {
    assert.deepEqual(await resourceManifest(), before)
    await assertStopped()
  })
} catch (error) {
  if (!(error instanceof BaselineCaptured)) {
    process.exitCode = 1
    log(`FAIL ${error.stack}`)
  }
} finally {
  await killDecoders()
  if (application) await closeApplication().catch(error => log(`cleanup: ${error.message}`))
  await closeServer(foreignServer)
  await closeServer(fixtureServer)
  await fs.mkdir(reportDir, { recursive: true })
  const finalReport = captureUiBaseline
    ? path.join(uiReportDir, 'baseline-report.json')
    : path.join(reportDir, 'report.json')
  await fs.writeFile(
    finalReport,
    JSON.stringify(
      {
        mode,
        executable,
        electronExecutable,
        appEntry,
        startedAt,
        backendSha256,
        results,
        passed: process.exitCode !== 1,
      },
      null,
      2,
    ),
  )
  log(`Report: ${finalReport}`)
}
