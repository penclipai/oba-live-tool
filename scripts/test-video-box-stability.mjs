/*
 * Real OBS soak harness for video-box.  It deliberately owns every process,
 * profile, port and artifact below test-results/relay-stability.
 *
 * Examples:
 *   pnpm test:relay:stability -- --smoke
 *   pnpm test:relay:stability -- --duration-seconds=3600
 *   pnpm test:relay:stability -- --runtime=C:\path\to\video-box.exe
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const smoke = process.argv.includes('--smoke')
const durationSeconds = Number(arg('--duration-seconds') || (smoke ? 75 : 3600))
const requestedRuntime = arg('--runtime')
const runtimeExe = path.resolve(
  requestedRuntime || path.join(root, 'build', 'video-box-runtime', 'video-box.exe'),
)
const runtimeRoot = path.dirname(runtimeExe)
const ffmpeg = path.join(runtimeRoot, '_internal', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const installedObs = 'C:\\Program Files\\obs-studio'
const outputRoot = path.resolve(
  arg('--report-dir') || path.join(root, 'test-results', 'relay-stability'),
)
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const runDir = path.join(outputRoot, runId)
const dataDir = path.join(runDir, 'video-box-data')
const obsDir = path.join(runDir, 'obs-portable')
const obsExe = path.join(obsDir, 'bin', '64bit', 'obs64.exe')
const report = {
  startedAt: new Date().toISOString(),
  smoke,
  durationSeconds,
  runtimeExe,
  backendSha256: null,
  harnessSha256: null,
  fixtureCadence: {},
  phases: [],
  samples: [],
  failures: [],
  passed: false,
}
let backend
let obs
let fixture
const fixtureState = { mode: 'healthy', generation: 0 }
let ws
let requestId = 0
let sampler
let frameSampler
let faultActive = false
let lastFrameHash
let lastFrameChangedAt
let frameChanges = 0
let lastHeartbeatAt = 0
let frameEpoch = 0
let frameBusy = false
let lastFrameResponseEnd
let shuttingDown = false
let samplePromise
let framePromise
const fixtureClients = new Set()
const fixtureEncoders = new Set()
const hlsEncoders = new Set()
const obsPassword = randomBytes(24).toString('base64url')
const ownedIdentities = []
const ownedPorts = []

function creationTime(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}
function normalizeCreationDate(value) {
  const timestamp = creationTime(value)
  return timestamp === null ? null : value
}
function hasSameCreationTime(left, right) {
  const leftTime = creationTime(left)
  const rightTime = creationTime(right)
  return leftTime !== null && leftTime === rightTime
}
async function recordOwnedProcess(label, pid) {
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath | ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
  })
  const identity = JSON.parse(stdout.trim() || 'null')
  const creationDate = normalizeCreationDate(identity?.CreationDate)
  if (!identity || !creationDate)
    throw new Error(`could not capture a valid creation time for owned ${label} process ${pid}`)
  ownedIdentities.push({ label, ...identity, CreationDate: creationDate })
}

function log(message) {
  process.stdout.write(`[stability] ${message}\n`)
}
function sha256Base64(value) {
  return createHash('sha256').update(value).digest('base64')
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
function phase(name, detail = {}) {
  report.phases.push({ name, at: new Date().toISOString(), ...detail })
  log(`${name}${detail.fault ? ` (${detail.fault})` : ''}`)
}
async function eventually(check, label, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label}${last ? `: ${last.message}` : ''}`)
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => (error ? reject(error) : resolve(port)))
    })
  })
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) })
  const body = await response.text()
  if (!response.ok)
    throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : {}
}
async function relay(port, method, endpoint, body) {
  return json(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function spawnOwned(command, args, logName, cwd = runDir) {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const [stream, suffix] of [
    [child.stdout, 'out'],
    [child.stderr, 'err'],
  ])
    stream?.pipe(requireStream(path.join(runDir, `${logName}.${suffix}.log`)))
  return child
}
function requireStream(file) {
  return new (class extends Writable {
    _write(chunk, _encoding, callback) {
      fs.appendFile(file, chunk).then(() => callback(), callback)
    }
  })()
}

async function createFixtures() {
  const media = path.join(runDir, 'fixtures')
  await fs.mkdir(media, { recursive: true })
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-c:a',
    'aac',
  ]
  await execFileAsync(ffmpeg, [...base, '-f', 'flv', path.join(media, 'live-a.flv')], {
    windowsHide: true,
    timeout: 30000,
  })
  await fs.copyFile(path.join(media, 'live-a.flv'), path.join(media, 'live-b.flv'))
  for (const variant of ['a', 'b']) {
    const directory = path.join(media, `hls-${variant}`)
    await fs.mkdir(directory)
    const encoder = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-re',
        '-stream_loop',
        '-1',
        '-i',
        path.join(media, `live-${variant}.flv`),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '15',
        '-keyint_min',
        '15',
        '-sc_threshold',
        '0',
        '-force_key_frames',
        'expr:gte(t,n_forced*1)',
        '-c:a',
        'aac',
        '-f',
        'hls',
        '-hls_segment_type',
        'fmp4',
        '-hls_time',
        '1',
        '-hls_list_size',
        '3',
        '-hls_flags',
        'delete_segments+append_list+program_date_time',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-hls_segment_filename',
        'part%09d.m4s',
        'live.m3u8',
      ],
      { cwd: directory, windowsHide: true, stdio: 'ignore' },
    )
    hlsEncoders.add(encoder)
    encoder.once('exit', () => hlsEncoders.delete(encoder))
    await recordOwnedProcess(`hls-${variant}`, encoder.pid)
    await eventually(
      async () =>
        fs.access(path.join(directory, 'live.m3u8')).then(
          () => true,
          () => false,
        ),
      `live HLS ${variant} fixture`,
      15000,
    )
    const manifest = await fs.readFile(path.join(directory, 'live.m3u8'), 'utf8')
    const durations = [...manifest.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]))
    const targetDuration = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(manifest)?.[1])
    report.fixtureCadence[variant] = { targetDuration, durations }
    assert.ok(
      durations.length > 0 && durations.every(duration => duration <= 1.1),
      `HLS ${variant} fixture did not produce <=1.1s segments: ${durations.join(',')}`,
    )
    assert.equal(
      targetDuration,
      1,
      `HLS ${variant} fixture target duration was ${targetDuration}, expected 1`,
    )
  }
  fixture = http.createServer(async (request, response) => {
    const requested = new URL(request.url, 'http://fixture')
    const relative = decodeURIComponent(requested.pathname).replace(/^\/+/, '')
    if (relative.includes('..')) return response.writeHead(400).end()
    const name = path.basename(relative)
    if (fixtureState.mode === 'down' || fixtureState.mode === 'silent') {
      if (fixtureState.mode === 'silent') response.writeHead(200, { 'Content-Type': 'video/x-flv' })
      else response.destroy()
      return
    }
    if (name === 'live-a.flv' || name === 'live-b.flv') {
      response.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store' })
      const input = path.join(media, name)
      const inputArgs = requested.searchParams.get('burst') === '1' ? [] : ['-re']
      const stream = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          ...inputArgs,
          '-stream_loop',
          '-1',
          '-i',
          input,
          '-c',
          'copy',
          '-f',
          'flv',
          'pipe:1',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      await recordOwnedProcess('fixture-flv', stream.pid)
      const client = { response, stream }
      fixtureClients.add(client)
      fixtureEncoders.add(stream)
      const stop = () => {
        stream.stdout.unpipe(response)
        if (stream.exitCode === null) stream.kill()
        fixtureClients.delete(client)
        fixtureEncoders.delete(stream)
      }
      request.once('aborted', stop)
      response.once('close', stop)
      stream.stdout.pipe(response)
      return
    }
    try {
      const file = path.join(media, relative)
      let bytes = await fs.readFile(file)
      if (name === 'live.m3u8') {
        // ffmpeg's finite fixture marks the list as VOD.  Removing ENDLIST
        // makes the proxy/OBS exercise its live playlist refresh path.
        bytes = Buffer.from(bytes.toString('utf8').replace(/#EXT-X-ENDLIST\r?\n?/g, ''))
      }
      const range = request.headers.range
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader(
        'Content-Type',
        name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : name.endsWith('.m4s') || name.endsWith('.mp4')
            ? 'video/mp4'
            : 'application/octet-stream',
      )
      if (range) {
        const [, startText, endText] = /bytes=(\d+)-(\d*)/.exec(range) || []
        const start = Number(startText)
        const end = endText ? Number(endText) : bytes.length - 1
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Content-Length': end - start + 1,
        })
        response.end(bytes.subarray(start, end + 1))
      } else response.end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  return `http://127.0.0.1:${fixture.address().port}`
}

function setFixtureFault(mode) {
  fixtureState.mode = mode
  for (const client of fixtureClients) {
    client.stream.stdout.unpipe(client.response)
    if (client.stream.exitCode === null) client.stream.kill()
    if (mode === 'down') client.response.destroy()
  }
}

async function connectObs(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
  await once(ws, 'open')
  const hello = await eventually(
    () => messages.find(message => message.op === 0),
    'OBS websocket hello',
  )
  const auth = hello.d.authentication
  const password = obsPassword
  const authentication = auth
    ? sha256Base64(`${sha256Base64(`${password}${auth.salt}`)}${auth.challenge}`)
    : undefined
  ws.send(
    JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(authentication ? { authentication } : {}) } }),
  )
  await eventually(() => messages.find(message => message.op === 2), 'OBS websocket identify')
  ws._relayMessages = messages
}
async function obsCall(requestType, requestData = {}) {
  const id = String(++requestId)
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }))
  const response = await eventually(
    () => ws._relayMessages.find(message => message.op === 7 && message.d.requestId === id),
    `OBS ${requestType}`,
    15000,
    50,
  )
  if (!response.d.requestStatus.result)
    throw new Error(
      `OBS ${requestType}: ${response.d.requestStatus.comment || response.d.requestStatus.code}`,
    )
  return response.d.responseData || {}
}

async function setupObs(websocketPort, liveUrl) {
  await fs.cp(installedObs, obsDir, { recursive: true, errorOnExist: false })
  const globalIni = path.join(obsDir, 'config', 'obs-studio', 'global.ini')
  await fs.mkdir(path.dirname(globalIni), { recursive: true })
  await fs.writeFile(
    globalIni,
    `[Basic]\nProfile=Relay QA\nProfileDir=Relay QA\n[WebSocketAPI]\nServerEnabled=true\nServerPort=${websocketPort}\nAuthRequired=true\n`,
  )
  const profileDir = path.join(obsDir, 'config', 'obs-studio', 'basic', 'profiles', 'Relay QA')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(
    path.join(obsDir, 'config', 'obs-studio', 'user.ini'),
    '[General]\nFirstRun=true\n[Basic]\nProfile=Relay QA\nProfileDir=Relay QA\nConfigOnNewProfile=false\n',
  )
  await fs.writeFile(
    path.join(profileDir, 'basic.ini'),
    `[General]\nName=Relay QA\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${path.join(runDir, 'recordings').replaceAll('\\', '\\\\')}\nRecFormat2=mkv\nRecQuality=Stream\nStreamEncoder=x264\nStreamAudioEncoder=aac\nRecEncoder=x264\nRecAudioEncoder=aac\nVBitrate=800\nABitrate=96\nPreset=ultrafast\n[Video]\nBaseCX=320\nBaseCY=180\nOutputCX=320\nOutputCY=180\nFPSType=0\nFPSCommon=15\nFPSInt=15\nFPSNum=15\nFPSDen=1\n`,
  )
  const websocketConfig = path.join(
    obsDir,
    'config',
    'obs-studio',
    'plugin_config',
    'obs-websocket',
    'config.json',
  )
  await fs.mkdir(path.dirname(websocketConfig), { recursive: true })
  await fs.writeFile(
    websocketConfig,
    JSON.stringify(
      {
        server_enabled: true,
        server_port: websocketPort,
        auth_required: true,
        server_password: obsPassword,
      },
      null,
      2,
    ),
  )
  obs = spawnOwned(
    obsExe,
    [
      '--portable',
      '--multi',
      '--disable-shutdown-check',
      '--profile',
      'Relay QA',
      '--websocket_port',
      String(websocketPort),
      '--websocket_password',
      obsPassword,
    ],
    'obs',
    path.dirname(obsExe),
  )
  await recordOwnedProcess('obs', obs.pid)
  await eventually(
    async () => {
      try {
        await connectObs(websocketPort)
        return true
      } catch {
        return false
      }
    },
    'OBS websocket startup',
    60000,
    1000,
  )
  await obsCall('CreateScene', { sceneName: 'Relay Stability' }).catch(() => {})
  await obsCall('SetCurrentProgramScene', { sceneName: 'Relay Stability' })
  await obsCall('CreateInput', {
    sceneName: 'Relay Stability',
    inputName: 'video-box',
    inputKind: 'ffmpeg_source',
    inputSettings: {
      input: liveUrl,
      is_local_file: false,
      seekable: false,
      reconnect_delay_sec: 2,
    },
    sceneItemEnabled: true,
  }).catch(async () =>
    obsCall('SetInputSettings', {
      inputName: 'video-box',
      inputSettings: {
        input: liveUrl,
        is_local_file: false,
        seekable: false,
        reconnect_delay_sec: 2,
      },
      overlay: false,
    }),
  )
  const inputs = await obsCall('GetInputList')
  for (const input of inputs.inputs || []) {
    if (input.inputName !== 'video-box') {
      await obsCall('SetInputMute', { inputName: input.inputName, inputMuted: true }).catch(
        () => {},
      )
    }
  }
  await fs.mkdir(path.join(runDir, 'recordings'), { recursive: true })
  await obsCall('SetRecordDirectory', { recordDirectory: path.join(runDir, 'recordings') })
  await obsCall('SetVideoSettings', {
    baseWidth: 320,
    baseHeight: 180,
    outputWidth: 320,
    outputHeight: 180,
    fpsNumerator: 15,
    fpsDenominator: 1,
  })
  const video = await obsCall('GetVideoSettings')
  assert.equal(video.outputWidth, 320, 'portable OBS output width did not apply')
  assert.equal(video.outputHeight, 180, 'portable OBS output height did not apply')
}

async function decodeEvidence(file, label) {
  const { stdout, stderr } = await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-t',
      '3',
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
  assert.match(stdout, /^0,\s*\d+/m, `${label}: no video frames (${stderr})`)
  assert.match(stdout, /^1,\s*\d+/m, `${label}: no audio frames (${stderr})`)
  const volume = await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-t',
      '3',
      '-map',
      '0:a:0',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    { windowsHide: true, timeout: 30000 },
  )
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr)?.[1]
  assert.ok(mean && Number(mean) > -40, `${label}: recording audio is silent`)
}
async function captureEvidence(label) {
  const shot = await obsCall('GetSourceScreenshot', {
    sourceName: 'video-box',
    imageFormat: 'png',
    imageWidth: 320,
    imageHeight: 180,
  })
  await fs.writeFile(
    path.join(runDir, `${label}.png`),
    Buffer.from(shot.imageData.replace(/^data:image\/png;base64,/, ''), 'base64'),
  )
  await eventually(
    async () => !(await obsCall('GetRecordStatus')).outputActive,
    `${label}: previous OBS recording did not finish stopping`,
    15000,
    50,
  )
  await obsCall('StartRecord')
  await eventually(
    async () => {
      const state = await obsCall('GetRecordStatus')
      return state.outputActive ? state : false
    },
    `${label}: OBS recorder did not become active`,
    15000,
    500,
  )
  await sleep(6000)
  const recorded = await obsCall('StopRecord')
  await eventually(
    async () => !(await obsCall('GetRecordStatus')).outputActive,
    `${label}: OBS recorder did not finish stopping`,
    15000,
    50,
  )
  await eventually(
    async () => {
      try {
        await fs.access(recorded.outputPath)
        return true
      } catch {
        return false
      }
    },
    `OBS recording ${label}`,
    15000,
  )
  await decodeEvidence(recorded.outputPath, label)
  return recorded.outputPath
}

async function processMetrics() {
  const roots = ownedIdentities.filter(identity => ['video-box', 'obs'].includes(identity.label))
  const rootPayload = Buffer.from(JSON.stringify(roots)).toString('base64')
  const command = `$roots=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${rootPayload}'))|ConvertFrom-Json; $all=@(Get-CimInstance Win32_Process); $byId=@{}; $all|%{$byId[[int]$_.ProcessId]=$_}; $toUtcTicks={param($date) if($null -eq $date){return $null}; ([datetime]$date).ToUniversalTime().Ticks}; $seen=New-Object 'System.Collections.Generic.HashSet[int]'; $pending=New-Object 'System.Collections.Generic.Queue[object]'; $roots|%{$current=$byId[[int]$_.ProcessId]; $currentCreated=&$toUtcTicks $current.CreationDate; $rootCreated=&$toUtcTicks $_.CreationDate; if($null -ne $current -and $null -ne $currentCreated -and $currentCreated -eq $rootCreated){[void]$seen.Add([int]$current.ProcessId);$pending.Enqueue($current)}}; while($pending.Count){$parent=$pending.Dequeue();$parentCreated=&$toUtcTicks $parent.CreationDate;$all|%{$child=$_;$childCreated=&$toUtcTicks $child.CreationDate;if($child.ParentProcessId -eq $parent.ProcessId -and $null -ne $childCreated -and $childCreated -ge $parentCreated){if($seen.Add([int]$child.ProcessId)){$pending.Enqueue($child)}}}}; @($all|?{$seen.Contains([int]$_.ProcessId)}|Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,ThreadCount,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath)|ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
  })
  const relayStatus = await relay(backend.port, 'GET', '/api/status').catch(error => ({
    error: error.message,
  }))
  return {
    at: new Date().toISOString(),
    relay: relayStatus,
    processes: JSON.parse(stdout.trim() || '[]').map(process => ({
      ...process,
      CreationDate: normalizeCreationDate(process.CreationDate),
    })),
  }
}
async function sample() {
  if (shuttingDown) return
  const metric = await processMetrics()
  report.samples.push(metric)
  const tree = relayTree(metric)
  const backendProcess = tree.find(process => process.ProcessId === backend?.pid)
  if (
    !backendProcess ||
    !Number.isFinite(Number(backendProcess.WorkingSetSize)) ||
    Number(backendProcess.WorkingSetSize) <= 0
  )
    throw new Error('process sampler did not observe the owned video-box root with positive RSS')
  for (const process of tree) {
    if (
      !ownedIdentities.some(
        identity =>
          identity.ProcessId === process.ProcessId &&
          identity.CreationDate === process.CreationDate,
      )
    ) {
      ownedIdentities.push({
        label: 'observed-descendant',
        ProcessId: process.ProcessId,
        CreationDate: process.CreationDate,
        ExecutablePath: process.ExecutablePath,
      })
    }
  }
  const progress = {
    mode: report.phases.at(-1)?.name || 'starting',
    elapsedSeconds: Math.round((Date.now() - Date.parse(report.startedAt)) / 1000),
    lastSampleActiveClients: metric.relay?.active_clients ?? null,
    parentRss: backendProcess.WorkingSetSize,
    treeRss: relayRss(metric),
    ownedFfmpegCount: tree.filter(process => process.Name?.toLowerCase() === 'ffmpeg.exe').length,
    frameChanges,
    faults: report.phases.filter(entry => entry.name.startsWith('fault:')).length,
    recoveries: report.phases.filter(entry => entry.name.endsWith(':recovered')).length,
    failures: report.failures,
  }
  await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify(progress, null, 2))
  if (Date.now() - lastHeartbeatAt >= 60000) {
    lastHeartbeatAt = Date.now()
    log(`heartbeat ${JSON.stringify(progress)}`)
  }
}
function relayTree(sample) {
  const all = sample?.processes || []
  const roots = all.filter(
    process =>
      Number.isFinite(Date.parse(process.CreationDate)) &&
      ownedIdentities.some(
        identity =>
          identity.label === 'video-box' &&
          identity.ProcessId === process.ProcessId &&
          hasSameCreationTime(identity.CreationDate, process.CreationDate),
      ),
  )
  const ids = new Set(roots.map(process => process.ProcessId))
  const pending = [...roots]
  while (pending.length) {
    const parent = pending.shift()
    const parentCreatedAt = creationTime(parent.CreationDate)
    for (const process of all) {
      const createdAt = creationTime(process.CreationDate)
      if (
        process.ParentProcessId === parent.ProcessId &&
        !ids.has(process.ProcessId) &&
        parentCreatedAt !== null &&
        createdAt !== null &&
        createdAt >= parentCreatedAt
      ) {
        ids.add(process.ProcessId)
        pending.push(process)
      }
    }
  }
  return all.filter(process => ids.has(process.ProcessId))
}
function relayRss(sample) {
  return relayTree(sample).reduce(
    (total, process) => total + Number(process.WorkingSetSize || 0),
    0,
  )
}
async function sampleFrame() {
  if (shuttingDown || !ws || faultActive) return
  const epoch = frameEpoch
  const requestedAt = new Date().toISOString()
  const requestStartedAtMs = performance.now()
  const image = await obsCall('GetSourceScreenshot', {
    sourceName: 'video-box',
    imageFormat: 'png',
    imageWidth: 160,
    imageHeight: 90,
  })
  const respondedAt = new Date().toISOString()
  const responseEndedAtMs = performance.now()
  const responseMs = Math.round(responseEndedAtMs - requestStartedAtMs)
  if (shuttingDown || epoch !== frameEpoch || faultActive) return
  const hash = createHash('sha256')
    .update(image.imageData || '')
    .digest('hex')
  const responseGapMs =
    lastFrameResponseEnd === undefined ? null : Math.round(responseEndedAtMs - lastFrameResponseEnd)
  lastFrameResponseEnd = responseEndedAtMs
  if (hash !== lastFrameHash) {
    lastFrameHash = hash
    lastFrameChangedAt = responseEndedAtMs
    frameChanges++
    return
  }
  const knownUnchangedMs =
    lastFrameChangedAt === undefined ? 0 : requestStartedAtMs - lastFrameChangedAt
  if (lastFrameChangedAt !== undefined && knownUnchangedMs > 2000) {
    const media = await obsCall('GetMediaInputStatus', { inputName: 'video-box' }).catch(error => ({
      error: error.message,
    }))
    if (epoch !== frameEpoch || faultActive) return
    throw new Error(
      JSON.stringify({
        type: 'unexpected-healthy-frame-freeze',
        knownUnchangedMs: Math.round(knownUnchangedMs),
        phase: report.phases.at(-1)?.name,
        at: new Date().toISOString(),
        hash,
        epoch,
        requestedAt,
        respondedAt,
        responseMs,
        responseGapMs,
        media,
      }),
    )
  }
}
async function verifyRecovery(label, readyAt) {
  const postReadyHashes = new Set()
  await eventually(
    async () => {
      const image = await obsCall('GetSourceScreenshot', {
        sourceName: 'video-box',
        imageFormat: 'png',
        imageWidth: 320,
        imageHeight: 180,
      })
      postReadyHashes.add(
        createHash('sha256')
          .update(image.imageData || '')
          .digest('hex'),
      )
      const media = await obsCall('GetMediaInputStatus', { inputName: 'video-box' })
      return postReadyHashes.size >= 2 && media.mediaState === 'OBS_MEDIA_STATE_PLAYING'
    },
    `${label} dynamic visual recovery`,
    30000,
    1000,
  )
  const recorded = await captureEvidence(`${label}-recovered`)
  const recoveredMs = Date.now() - readyAt
  if (recoveredMs > 30000) throw new Error(`${label} recovery exceeded 30 seconds: ${recoveredMs}`)
  report.phases.push({
    name: `${label}:recovered`,
    recoveredMs,
    recorded,
    at: new Date().toISOString(),
  })
  lastFrameHash = undefined
  lastFrameChangedAt = performance.now()
  lastFrameResponseEnd = lastFrameChangedAt
}

async function assertRelayMode(port, expected) {
  await eventually(
    async () => (await relay(port, 'GET', '/api/status')).result?.selected_type === expected,
    `expected ${expected} relay mode`,
    45000,
  )
}

async function waitForMediaPlaying(label) {
  await eventually(
    async () => {
      const media = await obsCall('GetMediaInputStatus', { inputName: 'video-box' })
      return media.mediaState === 'OBS_MEDIA_STATE_PLAYING'
    },
    `${label}: OBS media input did not reach playing state`,
    30000,
    500,
  )
}

async function probeClientCleanup(port) {
  phase('probe:client-cleanup')
  const clients = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(10000) }),
    ),
  )
  assert.ok(
    clients.every(client => client.ok),
    'four live clients were not accepted',
  )
  await sleep(1500)
  await Promise.all(clients.map(client => client.body?.cancel()))
  await eventually(
    async () => (await relay(port, 'GET', '/api/status')).active_clients === 0,
    'closed clients did not release relay slots',
    20000,
  )
  const fresh = await fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(10000) })
  assert.ok(fresh.ok, 'new client was rejected after four closed clients')
  await fresh.body?.cancel()
  report.phases.push({ name: 'probe:client-cleanup:passed', at: new Date().toISOString() })
}

async function probeSlowClient(port, source) {
  phase('probe:slow-client')
  await relay(port, 'POST', '/api/settings', {
    room_url: `${source}/live-a.flv?burst=1`,
    output_mode: 'flv',
    resolve: true,
    enable_stream: true,
  })
  await assertRelayMode(port, 'flv')
  const socket = net.connect(port, '127.0.0.1')
  try {
    await once(socket, 'connect')
    socket.pause()
    socket.write(`GET /live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`)
    await eventually(
      async () => (await relay(port, 'GET', '/api/status')).active_clients === 1,
      'slow client did not occupy one relay permit',
    )
    // Leave the downstream TCP receive window closed while an unpaced, valid
    // FLV source fills it.  The proxy must release the permit by write timeout.
    await eventually(
      async () => (await relay(port, 'GET', '/api/status')).active_clients === 0,
      'slow non-reading client was not released by write deadline',
      20000,
    )
    report.phases.push({ name: 'probe:slow-client:passed', at: new Date().toISOString() })
  } finally {
    socket.destroy()
    await relay(port, 'POST', '/api/settings', {
      room_url: `${source}/live-a.flv`,
      output_mode: 'flv',
      resolve: true,
      enable_stream: true,
    })
    await assertRelayMode(port, 'flv')
  }
}

async function main() {
  await fs.mkdir(runDir, { recursive: true })
  report.harnessSha256 = createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex')
  await fs.access(runtimeExe)
  await fs.access(ffmpeg)
  await fs.access(installedObs)
  report.backendSha256 = createHash('sha256')
    .update(await fs.readFile(runtimeExe))
    .digest('hex')
  const relayPort = await freePort()
  const obsPort = await freePort()
  ownedPorts.push(relayPort, obsPort)
  const source = await createFixtures()
  ownedPorts.push(fixture.address().port)
  phase('start-relay')
  backend = spawnOwned(
    runtimeExe,
    ['--host', '127.0.0.1', '--port', String(relayPort), '--data-dir', dataDir, '--no-browser'],
    'video-box',
  )
  backend.port = relayPort
  await recordOwnedProcess('video-box', backend.pid)
  await eventually(
    async () => (await relay(relayPort, 'GET', '/api/status')).service_id === 'oba-video-relay',
    'video-box startup',
    45000,
  )
  await relay(relayPort, 'POST', '/api/settings', {
    room_url: `${source}/live-a.flv`,
    output_mode: 'flv',
    resolve: true,
    enable_stream: true,
  })
  await eventually(
    async () => (await relay(relayPort, 'GET', '/api/status')).result?.ok,
    'FLV resolve',
    45000,
  )
  await assertRelayMode(relayPort, 'flv')
  await probeClientCleanup(relayPort)
  await probeSlowClient(relayPort, source)
  phase('start-isolated-obs')
  await setupObs(obsPort, `http://127.0.0.1:${relayPort}/live`)
  await waitForMediaPlaying('baseline')
  await captureEvidence('baseline')
  sampler = setInterval(() => {
    if (shuttingDown || samplePromise) return
    samplePromise = sample()
      .catch(error => {
        if (!shuttingDown)
          report.failures.push({
            phase: 'sample',
            at: new Date().toISOString(),
            error: error.message,
          })
      })
      .finally(() => {
        samplePromise = undefined
      })
  }, 5000)
  frameSampler = setInterval(async () => {
    if (shuttingDown || frameBusy || framePromise) return
    frameBusy = true
    framePromise = sampleFrame()
      .catch(error => {
        if (!shuttingDown)
          report.failures.push({
            phase: report.phases.at(-1)?.name || 'frame-monitor',
            at: new Date().toISOString(),
            epoch: frameEpoch,
            error: error.message,
          })
      })
      .finally(() => {
        frameBusy = false
        framePromise = undefined
      })
  }, 250)
  await sample()
  const perModeSeconds = smoke ? 15 : Math.floor(durationSeconds / 3)
  const modes = [
    { name: 'flv', output_mode: 'flv', seconds: perModeSeconds },
    { name: 'transcode', output_mode: 'transcode', seconds: perModeSeconds },
    { name: 'hls', output_mode: 'hls', seconds: perModeSeconds },
  ]
  for (const item of modes) {
    const phaseDeadline = Date.now() + item.seconds * 1000
    phase(`mode:${item.name}`)
    faultActive = true
    frameEpoch++
    await relay(relayPort, 'POST', '/api/settings', {
      room_url: item.name === 'hls' ? `${source}/hls-a/live.m3u8` : `${source}/live-a.flv`,
      output_mode: item.output_mode,
      resolve: true,
      enable_stream: true,
    })
    await assertRelayMode(
      relayPort,
      item.name === 'hls' ? 'hls' : item.name === 'transcode' ? 'transcode' : 'flv',
    )
    await captureEvidence(`${item.name}-ready`)
    lastFrameHash = undefined
    lastFrameChangedAt = performance.now()
    lastFrameResponseEnd = lastFrameChangedAt
    faultActive = false
    phase(`warmup:${item.name}`)
    await sleep(smoke ? 10_000 : 300_000)
    await sample()
    const modeBaseline = report.samples.at(-1)
    await sleep(3000)
    await captureEvidence(`${item.name}-before-fault`)
    for (const fault of ['down', 'switch', 'silent']) {
      phase(`fault:${item.name}:${fault}`, { fault })
      faultActive = true
      frameEpoch++
      setFixtureFault(fault === 'switch' ? 'down' : fault)
      if (fault === 'switch') {
        fixtureState.generation++
        await relay(relayPort, 'POST', '/api/settings', {
          room_url: item.name === 'hls' ? `${source}/hls-b/live.m3u8` : `${source}/live-b.flv`,
          output_mode: item.output_mode,
          resolve: true,
          enable_stream: true,
        })
        await assertRelayMode(
          relayPort,
          item.name === 'hls' ? 'hls' : item.name === 'transcode' ? 'transcode' : 'flv',
        )
      }
      await sleep(fault === 'silent' ? 18_000 : smoke ? 3_000 : 8_000)
      const readyAt = Date.now()
      setFixtureFault('healthy')
      await verifyRecovery(`${item.name}:${fault}`, readyAt)
      await assertRelayMode(
        relayPort,
        item.name === 'hls' ? 'hls' : item.name === 'transcode' ? 'transcode' : 'flv',
      )
      faultActive = false
      frameEpoch++
    }
    while (Date.now() < phaseDeadline) {
      await sleep(1000)
    }
    await captureEvidence(`${item.name}-after`)
    await sample()
    const initialRss = relayRss(modeBaseline)
    const finalRss = relayRss(report.samples.at(-1))
    const initialThreads = relayTree(modeBaseline).reduce(
      (total, process) => total + Number(process.ThreadCount || 0),
      0,
    )
    const finalThreads = relayTree(report.samples.at(-1)).reduce(
      (total, process) => total + Number(process.ThreadCount || 0),
      0,
    )
    if (
      !Number.isFinite(initialRss) ||
      initialRss <= 0 ||
      !Number.isFinite(finalRss) ||
      finalRss <= 0
    )
      throw new Error(`${item.name} resource sample is missing relay RSS`)
    const allowed = Math.max(32 * 1024 * 1024, initialRss * 0.2)
    const growth = finalRss - initialRss
    const processes = relayTree(report.samples.at(-1))
    const ffmpegCount = processes.filter(
      process => process.Name?.toLowerCase() === 'ffmpeg.exe',
    ).length
    report.phases.push({
      name: `memory:${item.name}`,
      initialRss,
      finalRss,
      growth,
      allowed,
      initialThreads,
      finalThreads,
      ffmpegCount,
    })
    if (item.name !== 'transcode' && ffmpegCount)
      throw new Error(
        `${item.name} unexpectedly retained ${ffmpegCount} relay ffmpeg child processes`,
      )
    if (item.name === 'transcode' && ffmpegCount !== 1)
      throw new Error(
        `transcode requires exactly one relay ffmpeg child process, observed ${ffmpegCount}`,
      )
    if (growth > allowed) throw new Error(`${item.name} memory growth ${growth} exceeds ${allowed}`)
    if (finalThreads > initialThreads + 8)
      throw new Error(
        `${item.name} relay tree thread growth ${finalThreads - initialThreads} exceeds 8`,
      )
  }
  if (report.failures.length)
    throw new Error(`${report.failures.length} background stability monitor failures`)
  report.passed = true
}

async function cleanup() {
  shuttingDown = true
  faultActive = true
  frameEpoch++
  if (sampler) clearInterval(sampler)
  if (frameSampler) clearInterval(frameSampler)
  const pending = [samplePromise, framePromise].filter(Boolean)
  if (pending.length) {
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      sleep(20000).then(() => false),
    ])
    if (!drained)
      report.failures.push({ phase: 'cleanup', error: 'sampler drain exceeded 20 seconds' })
  }
  if (ws) ws.close()
  for (const encoder of hlsEncoders) if (encoder.exitCode === null) encoder.kill()
  for (const encoder of fixtureEncoders) if (encoder.exitCode === null) encoder.kill()
  if (fixture) {
    fixture.closeAllConnections()
    await new Promise(resolve => fixture.close(resolve))
  }
  if (backend?.port) await relay(backend.port, 'POST', '/api/shutdown').catch(() => {})
  for (const child of [obs, backend])
    if (child?.exitCode === null) {
      await Promise.race([once(child, 'exit'), sleep(5000)]).catch(() => {})
      if (child.exitCode === null)
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {})
    }
  if (backend?.port) {
    const stopped = await eventually(
      async () => {
        const alive = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `if (Get-Process -Id ${backend.pid} -ErrorAction SilentlyContinue) { 'alive' }`,
          ],
          { windowsHide: true },
        )
        try {
          await fetch(`http://127.0.0.1:${backend.port}/api/status`, {
            signal: AbortSignal.timeout(1000),
          })
          return false
        } catch {
          return !alive.stdout.trim()
        }
      },
      'owned relay process or listener survived cleanup',
      10000,
    ).catch(error => {
      report.failures.push({ phase: 'cleanup', error: error.message })
      return false
    })
    report.cleanup = { backendStopped: Boolean(stopped) }
  }
  const survivors = []
  const { stdout: inventoryJson } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  const inventory = JSON.parse(inventoryJson.trim() || '[]').map(process => ({
    ...process,
    CreationDate: normalizeCreationDate(process.CreationDate),
  }))
  for (const identity of ownedIdentities) {
    const current = inventory.find(process => process.ProcessId === identity.ProcessId)
    if (
      current &&
      current.CreationDate === identity.CreationDate &&
      current.ExecutablePath === identity.ExecutablePath
    )
      survivors.push(identity)
  }
  const listeningPorts = []
  for (const port of ownedPorts) {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ],
      { windowsHide: true },
    )
    if (Number(stdout.trim())) listeningPorts.push(port)
  }
  report.cleanup = { ...report.cleanup, ownedIdentities, survivors, listeningPorts }
  if (survivors.length || listeningPorts.length)
    report.failures.push({
      phase: 'cleanup',
      error: `owned survivors=${survivors.length}, listeningPorts=${listeningPorts.join(',')}`,
    })
  if (report.failures.length) {
    report.passed = false
    process.exitCode = 1
  }
  const endedAt = new Date().toISOString()
  report.actualDurationSeconds = Math.round(
    (Date.parse(endedAt) - Date.parse(report.startedAt)) / 1000,
  )
  const output = JSON.stringify({ ...report, endedAt }, null, 2)
  await fs.writeFile(path.join(runDir, 'report.json'), output)
  await fs.writeFile(path.join(outputRoot, 'report.json'), output)
  log(`Report: ${path.join(runDir, 'report.json')}`)
}
if (process.argv.includes('--help')) {
  process.stdout.write(
    'Usage: node scripts/test-video-box-stability.mjs [--smoke] [--duration-seconds=3600] [--runtime=<video-box.exe>] [--report-dir=<directory>]\\n',
  )
} else {
  try {
    await main()
  } catch (error) {
    report.failures.push({ phase: 'run', error: error.stack || error.message })
    process.exitCode = 1
    log(`FAIL ${error.stack || error.message}`)
  } finally {
    await cleanup()
  }
}
