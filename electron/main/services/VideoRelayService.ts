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

class VideoRelayService {
  private child: ChildProcess | null = null

  get supported() {
    return process.platform === 'win32'
  }

  get panelUrl() {
    return PANEL_URL
  }

  async start(): Promise<RelayServiceStatus> {
    if (!this.supported) {
      return this.unsupportedStatus()
    }

    const existing = await this.status()
    if (existing.serviceRunning) {
      return existing
    }

    const executable = this.getExecutablePath()
    if (!executable) {
      return this.withError('找不到转播服务运行文件，请确认 resources/video-box 已随应用打包。')
    }

    this.child = spawn(executable, ['--no-browser'], {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: 'ignore',
    })
    this.child.once('exit', () => {
      this.child = null
    })
    this.child.once('error', () => {
      this.child = null
    })

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await this.sleep(350)
      const running = await this.status(false, STARTUP_STATUS_TIMEOUT_MS)
      if (running.serviceRunning) {
        return running
      }
    }

    return this.withError('转播服务启动超时，请检查端口 5000 是否被占用。')
  }

  async status(resolve = false, timeoutMs = STATUS_TIMEOUT_MS): Promise<RelayServiceStatus> {
    if (!this.supported) {
      return this.unsupportedStatus()
    }

    if (!this.resourceReady()) {
      return this.withError('找不到转播服务运行文件，请确认 resources/video-box 已随应用打包。')
    }

    try {
      const url = resolve ? `${STATUS_URL}?resolve=1` : STATUS_URL
      const data = await this.requestJson<RelayStatusPayload>(url, { timeoutMs })
      return this.withData(data)
    } catch (error) {
      return {
        supported: true,
        serviceRunning: false,
        resourceReady: true,
        panelUrl: PANEL_URL,
        error: this.errorMessage(error),
      }
    }
  }

  async updateSettings(
    settings: Record<string, unknown> & { resolve?: boolean; enable_stream?: boolean },
  ): Promise<RelayServiceStatus> {
    const running = await this.start()
    if (!running.serviceRunning) {
      return running
    }

    try {
      const data = await this.requestJson<RelayStatusPayload>(SETTINGS_URL, {
        method: 'POST',
        body: JSON.stringify(settings),
        timeoutMs: settings.resolve ? SETTINGS_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      })
      return this.withData(data)
    } catch (error) {
      return this.withError(this.errorMessage(error))
    }
  }

  async control(action: 'start' | 'stop'): Promise<RelayServiceStatus> {
    const running = action === 'start' ? await this.start() : await this.status()
    if (!running.serviceRunning) {
      return running
    }

    try {
      await this.requestJson<RelayStatusPayload>(CONTROL_URL, {
        method: 'POST',
        body: JSON.stringify({ action }),
        timeoutMs: action === 'start' ? SETTINGS_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      })
      return this.status()
    } catch (error) {
      return this.withError(this.errorMessage(error))
    }
  }

  async shutdown(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (!this.supported) {
      return { ok: false, error: '当前平台暂不支持转播服务。' }
    }

    try {
      const response = await this.requestJson<{ ok: boolean; message?: string }>(SHUTDOWN_URL, {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 3000,
      })
      this.child = null
      return response
    } catch (error) {
      return { ok: false, error: this.errorMessage(error) }
    }
  }

  async openPanel() {
    if (!this.supported) return false
    await this.start()
    await shell.openExternal(PANEL_URL)
    return true
  }

  async cleanup() {
    if (!this.child) return
    await this.shutdown()
  }

  private getResourceRoot() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'video-box')
    }
    const appRoot = process.env.APP_ROOT ?? path.join(app.getAppPath(), '..')
    return path.join(appRoot, 'resources', 'video-box')
  }

  private getExecutablePath() {
    const executable = path.join(this.getResourceRoot(), 'video-box.exe')
    return fs.existsSync(executable) ? executable : null
  }

  private resourceReady() {
    return this.getExecutablePath() !== null
  }

  private async requestJson<T>(
    url: string,
    options: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500)
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timeout)
    }
  }

  private unsupportedStatus(): RelayServiceStatus {
    return {
      supported: false,
      serviceRunning: false,
      resourceReady: false,
      panelUrl: PANEL_URL,
      error: '转播功能当前仅支持 Windows。',
    }
  }

  private withError(error: string): RelayServiceStatus {
    return {
      supported: this.supported,
      serviceRunning: false,
      resourceReady: this.resourceReady(),
      panelUrl: PANEL_URL,
      error,
    }
  }

  private withData(data: RelayStatusPayload): RelayServiceStatus {
    return {
      supported: true,
      serviceRunning: true,
      resourceReady: true,
      panelUrl: PANEL_URL,
      data,
    }
  }

  private errorMessage(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return '解析耗时较长，请稍后查看转播状态。'
    }
    return error instanceof Error ? error.message : String(error)
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const videoRelayService = new VideoRelayService()
