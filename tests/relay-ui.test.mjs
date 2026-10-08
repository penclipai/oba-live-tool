import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  panelOpenError,
  RelayUiState,
  relayOfflineMessage,
  relayStatusLabel,
} from '../src/pages/Relay/relayUiState.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')

function deferred() {
  let resolve
  const promise = new Promise(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function makeStatus(settings) {
  return {
    supported: true,
    serviceRunning: true,
    resourceReady: true,
    panelUrl: 'http://127.0.0.1:5000/',
    state: 'running',
    data: {
      service_id: 'oba-video-relay',
      protocol_version: 1,
      settings,
      result: null,
      active_clients: 0,
      stream_enabled: false,
      stream_generation: 0,
      source_version: 0,
      uptime_seconds: 0,
      obs_url: 'http://127.0.0.1:5000/live',
      lan_urls: [],
      logs: [],
    },
  }
}

function createRelayHarness(invoke) {
  const state = []
  const refs = []
  const effects = []
  const intervals = []
  let hookIndex = 0
  let initialRender = true
  const element = (type, props, key) => ({ type, key, props: props ?? {} })
  const react = {
    useState(initial) {
      const index = hookIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [
        state[index],
        value => (state[index] = typeof value === 'function' ? value(state[index]) : value),
      ]
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useCallback(callback) {
      hookIndex++
      return callback
    },
    useMemo(factory) {
      hookIndex++
      return factory()
    },
    useId() {
      hookIndex++
      return 'relay-test-id'
    },
    useEffect(effect) {
      hookIndex++
      if (initialRender) effects.push(effect)
    },
  }
  const iconStub = new Proxy({}, { get: () => () => null })
  const componentStub = new Proxy({}, { get: () => 'stub' })
  const moduleCache = new Map()
  const loadTypeScript = fileName => {
    if (moduleCache.has(fileName)) return moduleCache.get(fileName).exports
    const source = fs.readFileSync(fileName, 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
      },
      fileName,
    }).outputText
    const module = { exports: {} }
    moduleCache.set(fileName, module)
    const localRequire = specifier => {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime')
        return { jsx: element, jsxs: element, Fragment: 'fragment' }
      if (specifier === 'lucide-react') return iconStub
      if (specifier === 'shared/ipcChannels') {
        return {
          IPC_CHANNELS: {
            tasks: {
              relay: {
                status: 'status',
                updateSettings: 'updateSettings',
                control: 'control',
                shutdown: 'shutdown',
                openPanel: 'openPanel',
              },
            },
          },
        }
      }
      if (specifier === '@/hooks/useToast')
        return { useToast: () => ({ toast: { error() {}, success() {} } }) }
      if (specifier === '@/hooks/useRelayHistory') {
        const history = selector => selector({ urls: [], addUrl() {}, removeUrl() {} })
        return { useRelayHistory: history }
      }
      if (specifier === '@/lib/utils')
        return { cn: (...values) => values.filter(Boolean).join(' ') }
      if (specifier.startsWith('@/components/')) return componentStub
      if (specifier === './relayUiState')
        return loadTypeScript(path.join(repoRoot, 'src/pages/Relay/relayUiState.ts'))
      throw new Error(`Unexpected Relay dependency: ${specifier}`)
    }
    vm.runInNewContext(
      output,
      {
        clearInterval() {},
        module,
        exports: module.exports,
        navigator: { clipboard: { writeText: async () => {} } },
        requestAnimationFrame(callback) {
          callback()
        },
        require: localRequire,
        setInterval() {
          return 1
        },
        window: {
          clearInterval() {},
          ipcRenderer: { invoke },
          setInterval(callback) {
            intervals.push(callback)
            return intervals.length
          },
        },
      },
      { filename: fileName },
    )
    return module.exports
  }
  const Relay = loadTypeScript(path.join(repoRoot, 'src/pages/Relay/index.tsx')).default
  const render = () => {
    hookIndex = 0
    const tree = Relay()
    initialRender = false
    return tree
  }
  return {
    find(tree, predicate) {
      if (!tree || typeof tree !== 'object') return null
      if (predicate(tree)) return tree
      const children = tree.props?.children
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = this.find(child, predicate)
        if (found) return found
      }
      return null
    },
    render,
    runEffects() {
      for (const effect of effects) effect()
      effects.length = 0
    },
    runInterval(index = 0) {
      intervals[index]?.()
    },
  }
}

test('a form edit prevents an earlier status response from hydrating it', () => {
  const state = new RelayUiState()
  const revisionAtPoll = state.currentFormRevision()

  state.markEdited()

  assert.equal(state.canUpdateForm(revisionAtPoll), false)
})

test('Relay preserves text entered while an initial status poll is in flight', async () => {
  const poll = deferred()
  const harness = createRelayHarness(channel => {
    assert.equal(channel, 'status')
    return poll.promise
  })
  let tree = harness.render()
  harness.runEffects()
  const roomInput = harness.find(tree, node => node.props?.id === 'relay-room-url')
  roomInput.props.onChange({ target: { value: 'https://live.example/new-room' } })
  poll.resolve(
    makeStatus({
      room_url: 'https://live.example/old-room',
      quality: 'OD',
      output_mode: 'auto',
      upstream_proxy: '',
      transcode_preset: 'veryfast',
    }),
  )
  await poll.promise
  await Promise.resolve()

  tree = harness.render()
  assert.equal(
    harness.find(tree, node => node.props?.id === 'relay-room-url').props.value,
    'https://live.example/new-room',
  )
})

test('Relay does not hydrate a poll that starts after unsaved edits', async () => {
  const requests = []
  const harness = createRelayHarness(() => {
    const request = deferred()
    requests.push(request)
    return request.promise
  })
  let tree = harness.render()
  harness.runEffects()
  requests.shift().resolve(
    makeStatus({
      room_url: 'https://live.example/synced-room',
      quality: 'OD',
      output_mode: 'auto',
      upstream_proxy: '',
      transcode_preset: 'veryfast',
    }),
  )
  await Promise.resolve()

  tree = harness.render()
  harness
    .find(tree, node => node.props?.id === 'relay-room-url')
    .props.onChange({
      target: { value: 'https://live.example/unsaved-room' },
    })
  harness.runInterval()
  requests.shift().resolve(
    makeStatus({
      room_url: 'https://live.example/stale-room',
      quality: 'OD',
      output_mode: 'auto',
      upstream_proxy: '',
      transcode_preset: 'veryfast',
    }),
  )
  await Promise.resolve()

  tree = harness.render()
  assert.equal(
    harness.find(tree, node => node.props?.id === 'relay-room-url').props.value,
    'https://live.example/unsaved-room',
  )
})

test('Relay preserves newer room and Cookie edits while saving', async () => {
  const save = deferred()
  const harness = createRelayHarness(channel => {
    if (channel === 'updateSettings') return save.promise
    return new Promise(() => {})
  })
  let tree = harness.render()
  const roomInput = harness.find(tree, node => node.props?.id === 'relay-room-url')
  roomInput.props.onChange({ target: { value: 'https://live.example/initial-room' } })
  tree = harness.render()
  const saveButton = harness.find(
    tree,
    node =>
      typeof node.props?.onClick === 'function' && node.props.children?.[1] === '保存并开始转播',
  )
  const saving = saveButton.props.onClick()
  harness
    .find(tree, node => node.props?.id === 'relay-room-url')
    .props.onChange({
      target: { value: 'https://live.example/newer-room' },
    })
  harness
    .find(tree, node => node.props?.id === 'relay-cookie')
    .props.onChange({
      target: { value: 'newer-cookie' },
    })
  save.resolve(
    makeStatus({
      room_url: 'https://live.example/initial-room',
      quality: 'OD',
      output_mode: 'auto',
      upstream_proxy: '',
      transcode_preset: 'veryfast',
    }),
  )
  await saving

  tree = harness.render()
  assert.equal(
    harness.find(tree, node => node.props?.id === 'relay-room-url').props.value,
    'https://live.example/newer-room',
  )
  assert.equal(
    harness.find(tree, node => node.props?.id === 'relay-cookie').props.value,
    'newer-cookie',
  )
})

test('an edit made while saving is retained after the save response', () => {
  const state = new RelayUiState()
  const revisionAtSave = state.currentFormRevision()
  const save = state.beginAction('save-start')
  assert.ok(save)

  state.markEdited()
  assert.equal(state.canApply(save, true), true)
  assert.equal(state.canUpdateForm(revisionAtSave), false)
  state.endAction('save-start')
})

test('a poll started after an edit cannot hydrate the dirty form', () => {
  const state = new RelayUiState()
  state.markEdited()
  const pollRevision = state.currentFormRevision()

  assert.equal(state.canUpdateForm(pollRevision), false)
})

test('a stale poll cannot overwrite a newer mutation result', () => {
  const state = new RelayUiState()
  const poll = state.beginRequest()
  const stop = state.beginAction('stop')
  assert.ok(stop)

  assert.equal(state.canApply(stop, true), true)
  state.endAction('stop')
  assert.equal(state.canApply(poll), false)
})

test('repeated forced refreshes are rejected synchronously', () => {
  const state = new RelayUiState()
  assert.ok(state.beginAction('resolve'))
  assert.equal(state.beginAction('resolve'), null)
  state.endAction('resolve')
  assert.ok(state.beginAction('resolve'))
})

test('opening the panel shares the action gate with a concurrent save', () => {
  const state = new RelayUiState()
  assert.ok(state.beginAction('save-start'))
  assert.equal(state.beginAction('open-panel'), null)
  state.endAction('save-start')
  assert.ok(state.beginAction('open-panel'))
})

test('unknown service state has a status-pending badge instead of a stopped error', () => {
  assert.equal(relayStatusLabel('unknown', false), '状态待确认')
  assert.match(relayOfflineMessage('unknown'), /状态待确认/)
})

test('open panel reports its IPC failure to the user', () => {
  assert.equal(panelOpenError({ ok: false, error: '浏览器无法打开' }), '浏览器无法打开')
  assert.equal(panelOpenError({ ok: true }), null)
})

test('failed stop responses leave the coordinator ready for a retry', () => {
  const state = new RelayUiState()
  const stop = state.beginAction('stop')
  assert.ok(stop)
  assert.equal(state.canApply(stop, true), true)
  state.endAction('stop')
  assert.equal(state.action, null)
})
