import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { app, shell } from 'electron'
import type { RelayServiceStatus, RelayStatusPayload } from 'shared/electron-api'

const RELAY_PORT = 5000
const PANEL_URL = `http://127.0.0.1:${RELAY_PORT}/`
const STATUS_URL = `${PANEL_URL}api/status`
const SETTINGS_URL = `${PANEL_URL}api/settings`
const CONTROL_URL = `${PANEL_URL}api/control`
const SHUTDOWN_URL = `${PANEL_URL}api/shutdown`
const STATUS_TIMEOUT_MS = 1500
const STARTUP_STATUS_TIMEOUT_MS = 800
const SETTINGS_TIMEOUT_MS = 45000
const CONTROL_TIMEOUT_MS = 15000
const SHUTDOWN_TIMEOUT_MS = 5000

type RelayErrorCode = NonNullable<RelayServiceStatus['errorCode']>

class RelayRequestError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class VideoRelayService {
  private child: ChildProcess | null = null
  private startPromise: Promise<RelayServiceStatus> | null = null
  private stopPromise: Promise<{ ok: boolean; message?: string; error?: string }> | null = null
  private lastGood: RelayServiceStatus | null = null
  private startCancelled = false

  get supported() {
    return process.platform === 'win32'
  }
  get panelUrl() {
    return PANEL_URL
  }

  async start(): Promise<RelayServiceStatus> {
    if (!this.supported) return this.unsupportedStatus()
    if (this.startPromise) return this.startPromise
    this.startCancelled = false
    const stopping = this.stopPromise
    this.startPromise = (async () => {
      if (stopping) await stopping
      return this.startInternal()
    })().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal(): Promise<RelayServiceStatus> {
    const existing = await this.status()
    if (this.startCancelled) return this.withError(undefined, 'refused', 'stopped')
    if (
      (existing.serviceRunning && existing.state === 'running') ||
      existing.errorCode === 'invalid-service'
    )
      return existing
    if (this.child) {
      if (this.hasExited(this.child)) this.clearChild(this.child, true)
      else
        return this.withError(
          '正在等待已启动的转播服务确认状态。',
          existing.errorCode ?? 'operation',
          'unknown',
          true,
        )
    }
    const executable = this.getExecutablePath()
    if (!executable)
      return this.withError(
        '找不到转播服务运行文件，请确认 video-box 已随应用打包。',
        'resource-missing',
      )

    const dataDir = path.join(app.getPath('userData'), 'video-relay')
    fs.mkdirSync(dataDir, { recursive: true })
    const child = spawn(
      executable,
      ['--no-browser', '--data-dir', dataDir, '--host', '0.0.0.0', '--port', String(RELAY_PORT)],
      {
        cwd: dataDir,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, VIDEO_BOX_DATA_DIR: dataDir },
      },
    )
    this.child = child
    child.once('exit', () => this.clearChild(child, true))
    child.once('error', () => this.clearChild(child))

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await this.sleep(350)
      if (this.startCancelled) {
        await this.stopOwnedChild(child)
        return this.withError(undefined, 'refused', 'stopped')
      }
      const running = await this.status(false, STARTUP_STATUS_TIMEOUT_MS)
      if (running.serviceRunning && running.state === 'running') return running
      if (running.errorCode === 'invalid-service') {
        await this.stopOwnedChild(child)
        return running
      }
    }
    await this.stopOwnedChild(child)
    return this.withError('转播服务启动超时，请检查端口 5000 是否被占用。', 'startup', 'unknown')
  }

  async status(
    resolve = false,
    timeoutMs = resolve ? SETTINGS_TIMEOUT_MS : STATUS_TIMEOUT_MS,
  ): Promise<RelayServiceStatus> {
    if (!this.supported) return this.unsupportedStatus()
    try {
      const data = await this.requestJson<RelayStatusPayload>(
        resolve ? CONTROL_URL : STATUS_URL,
        resolve
          ? { method: 'POST', body: JSON.stringify({ action: 'resolve' }), timeoutMs }
          : { timeoutMs },
      )
      this.validatePayload(data)
      return this.withData(data)
    } catch (error) {
      return this.statusError(error)
    }
  }

  async updateSettings(
    settings: Record<string, unknown> & { resolve?: boolean; enable_stream?: boolean },
  ): Promise<RelayServiceStatus> {
    const running = await this.start()
    if (!running.serviceRunning || running.state !== 'running') return running
    try {
      const data = await this.requestJson<RelayStatusPayload>(SETTINGS_URL, {
        method: 'POST',
        body: JSON.stringify(settings),
        timeoutMs: settings.resolve ? SETTINGS_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      })
      this.validatePayload(data)
      return this.withData(data)
    } catch (error) {
      return this.operationError(error)
    }
  }

  async control(action: 'start' | 'stop'): Promise<RelayServiceStatus> {
    const running = action === 'start' ? await this.start() : await this.status()
    if (!running.serviceRunning || running.state !== 'running') return running
    try {
      await this.requestJson<RelayStatusPayload>(CONTROL_URL, {
        method: 'POST',
        body: JSON.stringify({ action }),
        timeoutMs: action === 'start' ? SETTINGS_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      })
      return this.status()
    } catch (error) {
      return this.operationError(error)
    }
  }

  async shutdown(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (!this.supported) return { ok: false, error: '当前平台暂不支持转播服务。' }
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.shutdownInternal().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async shutdownInternal(): Promise<{ ok: boolean; message?: string; error?: string }> {
    this.startCancelled = true
    const starting = this.startPromise
    if (starting) await starting
    const status = await this.status()
    if (!status.serviceRunning || status.state !== 'running') {
      if (this.child) {
        const stopped = await this.stopOwnedChild(this.child)
        return stopped
          ? { ok: true, message: '转播服务已关闭。' }
          : { ok: false, error: '转播服务未能确认退出。' }
      }
      return status.errorCode === 'refused' || status.state === 'stopped'
        ? { ok: true, message: '转播服务未运行。' }
        : { ok: false, error: status.error ?? '无法确认转播服务状态。' }
    }
    try {
      const response = await this.requestJson<{ ok: boolean; message?: string }>(SHUTDOWN_URL, {
        method: 'POST',
        body: '{}',
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      })
      if (this.child && !(await this.waitForExit(this.child, SHUTDOWN_TIMEOUT_MS))) {
        if (!(await this.stopOwnedChild(this.child))) {
          return { ok: false, error: '转播服务未能在关闭请求后退出。' }
        }
      }
      return response
    } catch (error) {
      if (this.child) await this.stopOwnedChild(this.child)
      return { ok: false, error: this.errorMessage(error) }
    }
  }

  async openPanel(): Promise<{ ok: boolean; error?: string }> {
    const status = await this.start()
    if (!status.serviceRunning || status.state !== 'running')
      return { ok: false, error: status.error ?? '转播服务未能启动。' }
    try {
      await shell.openExternal(PANEL_URL)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: this.errorMessage(error) }
    }
  }

  /** Stops only the process this application started; a verified adopted service is left alone. */
  async cleanup(): Promise<void> {
    this.startCancelled = true
    const starting = this.startPromise
    if (starting) await starting
    const child = this.child
    if (!child) return
    // Automatic app shutdown owns only its child process. A valid service on the same
    // port may belong to another OBA instance, so never send it a shutdown request here.
    await this.stopOwnedChild(child)
  }

  private clearChild(child: ChildProcess, confirmedExited = false) {
    if (this.child === child && (confirmedExited || this.hasExited(child) || !child.pid))
      this.child = null
  }

  private async stopOwnedChild(child: ChildProcess): Promise<boolean> {
    if (this.hasExited(child)) {
      this.clearChild(child, true)
      return true
    }
    if (!(await this.waitForExit(child, 1000)) && child.pid) {
      try {
        if (process.platform === 'win32')
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          })
        else child.kill('SIGTERM')
      } catch {
        /* best effort for an owned pid only */
      }
    }
    if (await this.waitForExit(child, 3000)) {
      this.clearChild(child, true)
      return true
    }
    return false
  }

  private waitForExit(child: ChildProcess, timeoutMs: number) {
    if (this.hasExited(child)) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let done = false
      const finish = (exited: boolean) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        resolve(exited)
      }
      const onExit = () => finish(true)
      const onError = () => finish(true)
      const timeout = setTimeout(() => finish(false), timeoutMs)
      child.once('exit', onExit)
      child.once('error', onError)
    })
  }

  private getResourceRoot() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'video-box')
    const appRoot = process.env.APP_ROOT ?? path.join(app.getAppPath(), '..')
    return path.join(appRoot, 'build', 'video-box-runtime')
  }

  private getExecutablePath() {
    const executable = path.join(this.getResourceRoot(), 'video-box.exe')
    return fs.existsSync(executable) ? executable : null
  }

  private async requestJson<T>(
    url: string,
    options: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? STATUS_TIMEOUT_MS)
    try {
      let response: Response
      try {
        response = await fetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          throw new RelayRequestError('timeout', '请求超时。')
        if (this.hasErrorCode(error, 'ECONNREFUSED'))
          throw new RelayRequestError('refused', '无法连接转播服务。')
        throw new RelayRequestError('operation', '无法确认转播服务状态。')
      }
      if (!response.ok)
        throw new RelayRequestError('http', `转播服务返回 HTTP ${response.status}。`)
      try {
        return (await response.json()) as T
      } catch {
        throw new RelayRequestError('invalid-service', '端口 5000 上的服务不是 OBA 转播服务。')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private validatePayload(data: RelayStatusPayload) {
    if (
      data?.service_id !== 'oba-video-relay' ||
      data.protocol_version !== 1 ||
      !this.isSettings(data.settings) ||
      typeof data.active_clients !== 'number' ||
      typeof data.stream_enabled !== 'boolean' ||
      typeof data.stream_generation !== 'number' ||
      typeof data.source_version !== 'number' ||
      typeof data.uptime_seconds !== 'number' ||
      typeof data.obs_url !== 'string' ||
      !Array.isArray(data.lan_urls) ||
      !data.lan_urls.every(url => typeof url === 'string') ||
      !Array.isArray(data.logs) ||
      !data.logs.every(
        log =>
          log &&
          typeof log.time === 'number' &&
          typeof log.level === 'string' &&
          typeof log.message === 'string',
      ) ||
      (data.result !== null && !this.isResult(data.result))
    )
      throw new RelayRequestError('invalid-service', '端口 5000 上的服务不是 OBA 转播服务。')
  }

  private statusError(error: unknown): RelayServiceStatus {
    const code = this.errorCode(error)
    if (code === 'refused') return this.withError(undefined, code, 'stopped')
    if (this.stopPromise) return this.withError('正在停止转播服务。', code, 'stopping', true)
    if (this.startPromise) return this.withError('正在启动转播服务。', code, 'starting', true)
    if (code === 'timeout')
      return this.withError('正在等待转播服务确认状态。', code, 'unknown', true)
    return this.withError(this.errorMessage(error), code, 'unknown', code !== 'invalid-service')
  }

  private operationError(error: unknown): RelayServiceStatus {
    const code = this.errorCode(error)
    if (code === 'refused') return this.withError(undefined, code, 'stopped')
    if (code === 'invalid-service') return this.withError(this.errorMessage(error), code, 'unknown')
    if (code === 'timeout' || code === 'operation')
      return this.withError(this.errorMessage(error), code, 'unknown', true)
    return this.withError(this.errorMessage(error), code, 'running', true)
  }

  private isSettings(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const settings = value as Record<string, unknown>
    return (
      typeof settings.room_url === 'string' &&
      typeof settings.quality === 'string' &&
      typeof settings.output_mode === 'string' &&
      typeof settings.listen_host === 'string' &&
      typeof settings.port === 'number' &&
      typeof settings.cookie === 'string' &&
      typeof settings.upstream_proxy === 'string' &&
      typeof settings.chunk_size === 'number' &&
      typeof settings.transcode_preset === 'string'
    )
  }

  private isResult(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as Record<string, unknown>
    return (
      typeof result.ok === 'boolean' &&
      typeof result.is_live === 'boolean' &&
      typeof result.anchor_name === 'string' &&
      typeof result.title === 'string' &&
      typeof result.quality === 'string' &&
      typeof result.flv_url === 'string' &&
      typeof result.m3u8_url === 'string' &&
      typeof result.selected_url === 'string' &&
      typeof result.selected_type === 'string' &&
      typeof result.codec === 'string' &&
      typeof result.hevc === 'boolean' &&
      typeof result.output_mode === 'string' &&
      typeof result.error === 'string' &&
      typeof result.resolved_at === 'number'
    )
  }

  private unsupportedStatus(): RelayServiceStatus {
    return {
      supported: false,
      serviceRunning: false,
      resourceReady: false,
      panelUrl: PANEL_URL,
      state: 'stopped',
      error: '转播功能当前仅支持 Windows。',
      errorCode: 'unsupported',
    }
  }

  private withError(
    error: string | undefined,
    errorCode: RelayErrorCode,
    state: RelayServiceStatus['state'] = 'stopped',
    preserveLastGood = false,
  ): RelayServiceStatus {
    const previous = preserveLastGood ? this.lastGood : null
    return {
      supported: this.supported,
      serviceRunning: previous?.serviceRunning ?? false,
      resourceReady: this.getExecutablePath() !== null,
      panelUrl: PANEL_URL,
      state,
      ...(error ? { error } : {}),
      errorCode,
      ...(previous?.data ? { data: previous.data } : {}),
    }
  }

  private withData(data: RelayStatusPayload): RelayServiceStatus {
    const status: RelayServiceStatus = {
      supported: true,
      serviceRunning: true,
      resourceReady: true,
      panelUrl: PANEL_URL,
      state: 'running',
      data,
    }
    this.lastGood = status
    return status
  }

  private errorCode(error: unknown): RelayErrorCode {
    return error instanceof RelayRequestError ? error.code : 'operation'
  }
  private hasExited(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null
  }
  private hasErrorCode(error: unknown, expected: string) {
    let current = error
    for (let depth = 0; depth < 3; depth++) {
      if (!current || typeof current !== 'object') return false
      if ('code' in current && current.code === expected) return true
      current = 'cause' in current ? current.cause : undefined
    }
    return false
  }
  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    if (
      typeof error === 'object' &&
      error &&
      'message' in error &&
      typeof error.message === 'string'
    )
      return error.message
    return '转播服务操作失败。'
  }
  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const videoRelayService = new VideoRelayService()
