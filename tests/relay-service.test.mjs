import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const serviceFile = path.join(root, 'electron/main/services/VideoRelayService.ts')

function payload() {
  return {
    service_id: 'oba-video-relay',
    protocol_version: 1,
    settings: {
      room_url: '',
      quality: 'auto',
      output_mode: 'auto',
      listen_host: '127.0.0.1',
      port: 5000,
      cookie: '',
      upstream_proxy: '',
      chunk_size: 1024,
      transcode_preset: 'veryfast',
    },
    result: null,
    active_clients: 0,
    stream_enabled: false,
    stream_generation: 0,
    source_version: 0,
    uptime_seconds: 0,
    obs_url: '',
    lan_urls: [],
    logs: [],
  }
}

function response(body = payload(), ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function refused() {
  return Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }),
  )
}

function deferred() {
  let resolve
  const promise = new Promise(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function harness({
  fetchImpl = async () => response(),
  shellImpl = async () => {},
  sourceText,
} = {}) {
  const children = []
  const timers = []
  let spawned = false
  const processMock = {
    ...process,
    platform: 'win32',
    resourcesPath: 'resources',
    env: {},
    default: null,
  }
  processMock.default = processMock
  const spawn = executable => {
    if (executable === 'taskkill') {
      const owned = children.at(-1)
      if (owned) {
        owned.killed = true
        owned.exitCode = 0
        owned.emit('exit')
      }
      return new EventEmitter()
    }
    spawned = true
    const child = new EventEmitter()
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      killed: false,
      pid: children.length + 100,
      kill() {
        child.killed = true
      },
    })
    children.push(child)
    return child
  }
  const fsMock = { existsSync: () => true, mkdirSync() {} }
  const electron = {
    app: { isPackaged: false, getPath: () => 'profile', getAppPath: () => root },
    shell: { openExternal: shellImpl },
  }
  const source =
    ts.transpileModule(sourceText ?? fs.readFileSync(serviceFile, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
      },
      fileName: serviceFile,
    }).outputText +
    '\nif (!module.exports.VideoRelayService) module.exports.VideoRelayService = VideoRelayService;'
  const module = { exports: {} }
  const require = specifier => {
    if (specifier === 'node:child_process') return { spawn }
    if (specifier === 'node:fs') return { default: fsMock, ...fsMock }
    if (specifier === 'node:path') return { default: path, ...path }
    if (specifier === 'node:process') return processMock
    if (specifier === 'electron') return electron
    if (specifier === 'shared/electron-api') return {}
    throw new Error(`unexpected import: ${specifier}`)
  }
  const context = {
    module,
    exports: module.exports,
    require,
    AbortController,
    DOMException,
    fetch: (...args) => fetchImpl(...args, { spawned }),
    setTimeout(callback, delay) {
      timers.push(delay)
      return globalThis.setTimeout(callback, delay)
    },
    clearTimeout: globalThis.clearTimeout,
    console,
  }
  vm.runInNewContext(source, context, { filename: serviceFile })
  return {
    Service: module.exports.VideoRelayService,
    children,
    timers,
    get spawned() {
      return spawned
    },
  }
}

test('concurrent starts spawn once and an old exit cannot clear the new child', async () => {
  const h = harness({
    fetchImpl: async (_url, _options, state) => (state.spawned ? response() : refused()),
  })
  const service = new h.Service()
  service.sleep = async () => {}
  const [first, second] = await Promise.all([service.start(), service.start()])
  assert.equal(first.state, 'running')
  assert.equal(second.state, 'running')
  assert.equal(h.children.length, 1)
  const oldChild = h.children[0]
  const newChild = new EventEmitter()
  Object.assign(newChild, { exitCode: null, signalCode: null, killed: false, pid: 999 })
  service.child = newChild
  oldChild.emit('exit')
  assert.equal(service.child, newChild)
})

test('starts queued behind a stop reserve one shared launch', async () => {
  const stop = deferred()
  const h = harness({
    fetchImpl: async (_url, _options, state) => (state.spawned ? response() : refused()),
  })
  const service = new h.Service()
  service.sleep = async () => {}
  service.stopPromise = stop.promise
  const first = service.start()
  const second = service.start()
  stop.resolve({ ok: true })
  await Promise.all([first, second])
  assert.equal(h.children.length, 1)
})

test('an unknown status never replaces a live owned child', async () => {
  const unavailable = async () => Promise.reject(new Error('temporary transport failure'))
  const h = harness({ fetchImpl: unavailable })
  const owned = new EventEmitter()
  Object.assign(owned, { exitCode: null, signalCode: null, killed: false, pid: 777 })
  h.children.push(owned)
  const service = new h.Service()
  service.child = owned
  const result = await service.start()
  assert.equal(result.state, 'unknown')
  assert.equal(h.spawned, false)
  assert.equal(service.child, owned)
  await service.cleanup()
  assert.equal(service.child, null)

  const stillLive = new EventEmitter()
  Object.assign(stillLive, { exitCode: null, signalCode: null, killed: false, pid: 778 })
  const retry = new h.Service()
  retry.child = stillLive
  await retry.start()
  assert.equal(h.spawned, false)
  assert.equal(retry.child, stillLive)
})

test('shutdown of an owned process works after a refused status and permits a restart', async () => {
  const h = harness({
    fetchImpl: async (_url, _options, state) => (state.spawned ? response() : refused()),
  })
  const owned = new EventEmitter()
  Object.assign(owned, { exitCode: null, signalCode: null, killed: false, pid: 779 })
  h.children.push(owned)
  const service = new h.Service()
  service.child = owned
  assert.equal((await service.shutdown()).ok, true)
  assert.equal(service.child, null)
  service.sleep = async () => {}
  assert.equal((await service.start()).state, 'running')
})

test('cleanup kills an owned child without posting shutdown to a foreign listener', async () => {
  let posts = 0
  const foreign = payload()
  foreign.settings = []
  const h = harness({
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') posts++
      return response(foreign)
    },
  })
  const owned = new EventEmitter()
  Object.assign(owned, { exitCode: null, signalCode: null, killed: false, pid: 780 })
  h.children.push(owned)
  const service = new h.Service()
  service.child = owned
  await service.cleanup()
  assert.equal(posts, 0)
  assert.equal(service.child, null)
})

test('automatic cleanup never posts shutdown to a valid service sharing the relay port', async () => {
  let posts = 0
  const h = harness({
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') posts++
      return response()
    },
  })
  const owned = new EventEmitter()
  Object.assign(owned, { exitCode: null, signalCode: null, killed: false, pid: 781 })
  h.children.push(owned)
  const service = new h.Service()
  service.child = owned
  await service.cleanup()
  assert.equal(posts, 0)
  assert.equal(service.child, null)

  const adopted = new h.Service()
  await adopted.cleanup()
  assert.equal(posts, 0)
  assert.equal(h.spawned, false)
})

test('shutdown cancels an in-flight start before it can leave an owned child behind', async () => {
  const h = harness({ fetchImpl: async () => refused() })
  const service = new h.Service()
  let releaseSleep
  service.sleep = () =>
    new Promise(resolve => {
      releaseSleep = resolve
    })
  const starting = service.start()
  await new Promise(resolve => setImmediate(resolve))
  const stopping = service.shutdown()
  releaseSleep()
  await starting
  await stopping
  assert.equal(service.child, null)
})

test('cleanup waits for an initial status request and prevents its late response from spawning', async () => {
  const initial = deferred()
  const h = harness({ fetchImpl: async () => initial.promise })
  const service = new h.Service()
  const starting = service.start()
  await new Promise(resolve => setImmediate(resolve))
  const cleaning = service.cleanup()
  initial.resolve(response())
  await Promise.all([starting, cleaning])
  assert.equal(h.children.length, 0)
  assert.equal(service.child, null)
})

test('invalid JSON is identified before settings can post a Cookie', async () => {
  let posts = 0
  const h = harness({
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') posts++
      return response({ another_application: true })
    },
  })
  const result = await new h.Service().updateSettings({ cookie: 'secret', resolve: true })
  assert.equal(result.errorCode, 'invalid-service')
  assert.equal(posts, 0)
})

test('a spoofed relay identity with malformed settings cannot receive a Cookie', async () => {
  let posts = 0
  const fake = payload()
  fake.settings = []
  const h = harness({
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') posts++
      return response(fake)
    },
  })
  const result = await new h.Service().updateSettings({ cookie: 'secret', resolve: true })
  assert.equal(result.errorCode, 'invalid-service')
  assert.equal(posts, 0)
})

test('the invalid-service regression fails on the pre-fix implementation', async () => {
  const legacySource = execFileSync(
    'git',
    ['show', 'HEAD:electron/main/services/VideoRelayService.ts'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  let posts = 0
  const h = harness({
    sourceText: legacySource,
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') posts++
      return response({ another_application: true })
    },
  })
  const result = await new h.Service().updateSettings({ cookie: 'secret', resolve: true })
  assert.equal(result.serviceRunning, true)
  assert.equal(posts, 1)
})

test('a refused idle status is a normal stopped state without a raw error', async () => {
  const h = harness({ fetchImpl: async () => refused() })
  const result = await new h.Service().status()
  assert.equal(result.state, 'stopped')
  assert.equal(result.errorCode, 'refused')
  assert.equal(result.error, undefined)
})

test('operation timeout preserves the last valid snapshot', async () => {
  let calls = 0
  const h = harness({
    fetchImpl: async () => {
      calls++
      if (calls <= 2) return response()
      throw new DOMException('', 'AbortError')
    },
  })
  const service = new h.Service()
  await service.status()
  service.start = async () => service.status()
  const timedOut = await service.control('start')
  assert.equal(timedOut.state, 'unknown')
  assert.equal(timedOut.serviceRunning, true)
  assert.ok(timedOut.data)
})

test('forced resolve posts the control action with a 45 second timeout', async () => {
  let resolveRequest
  const h = harness({
    fetchImpl: async (url, options) => {
      resolveRequest = { url, options }
      return response()
    },
  })
  await new h.Service().status(true)
  assert.equal(resolveRequest.url, 'http://127.0.0.1:5000/api/control')
  assert.equal(resolveRequest.options.method, 'POST')
  assert.equal(resolveRequest.options.body, JSON.stringify({ action: 'resolve' }))
  assert.ok(h.timers.includes(45000))
})

test('open panel reports shell failures instead of reporting success', async () => {
  const h = harness({
    shellImpl: async () => {
      throw new Error('browser unavailable')
    },
  })
  const result = await new h.Service().openPanel()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'browser unavailable')
})
