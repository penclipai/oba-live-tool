import type { LogMessage } from 'electron-log'
import type { ProgressInfo, UpdateDownloadedEvent } from 'electron-updater'
import { IPC_CHANNELS } from './ipcChannels'

export interface IpcChannels {
  // LiveControl
  [IPC_CHANNELS.tasks.liveControl.connect]: (params: {
    chromePath?: string
    headless?: boolean
    storageState?: string
    platform: LiveControlPlatform
    account: Account
  }) => boolean
  [IPC_CHANNELS.tasks.liveControl.disconnect]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.liveControl.disconnectedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.liveControl.notifyAccountName]: (
    params:
      | {
          ok: true
          accountId: string
          accountName: string | null
        }
      | { ok: false },
  ) => void

  // AutoMessage
  [IPC_CHANNELS.tasks.autoMessage.start]: (accountId: string, config: AutoCommentConfig) => boolean
  [IPC_CHANNELS.tasks.autoMessage.stop]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.autoMessage.stoppedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.autoMessage.sendBatchMessages]: (
    accountId: string,
    messages: string[],
    count: number,
  ) => boolean
  [IPC_CHANNELS.tasks.autoMessage.updateConfig]: (
    accountId: string,
    config: Parital<AutoCommentConfig>,
  ) => void

  // AutoPopup
  [IPC_CHANNELS.tasks.autoPopUp.start]: (accountId: string, config: AutoPopupConfig) => boolean
  [IPC_CHANNELS.tasks.autoPopUp.stop]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.autoPopUp.stoppedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.autoPopUp.updateConfig]: (
    accountId: string,
    config: Parital<AutoPopupConfig>,
  ) => void
  [IPC_CHANNELS.tasks.autoPopUp.registerShortcuts]: (
    accountId: string,
    shortcuts: { accelerator: string; goodsIds: number[] }[],
  ) => void
  [IPC_CHANNELS.tasks.autoPopUp.unregisterShortcuts]: () => void

  // AutoReply
  [IPC_CHANNELS.tasks.autoReply.startCommentListener]: (
    accountId: string,
    config: CommentListenerConfig,
  ) => boolean
  [IPC_CHANNELS.tasks.autoReply.stopCommentListener]: (accountId: string) => void
  [IPC_CHANNELS.tasks.autoReply.sendReply]: (accountId: string, replyContent: string) => void
  [IPC_CHANNELS.tasks.autoReply.listenerStopped]: (accountId: string) => void
  [IPC_CHANNELS.tasks.autoReply.showComment]: (data: {
    comment: LiveMessage
    accountId: string
  }) => void

  // AIChat
  [IPC_CHANNELS.tasks.aiChat.normalChat]: (params: {
    messages: AIChatMessage[]
    provider: string
    model: string
    apiKey: string
    customBaseURL?: string
  }) => string | null
  [IPC_CHANNELS.tasks.aiChat.testApiKey]: (params: {
    apiKey: string
    provider: string
    customBaseURL?: string
  }) => { success: boolean; models?: string[]; error?: string }
  [IPC_CHANNELS.tasks.aiChat.chat]: (params: {
    messages: AIChatMessage[]
    provider: string
    model: string
    apiKey: string
    customBaseURL?: string
  }) => void
  [IPC_CHANNELS.tasks.aiChat.stream]: (
    data:
      | {
          chunk: string
          type: 'content' | 'reasoning'
        }
      | { done: boolean },
  ) => void
  [IPC_CHANNELS.tasks.aiChat.error]: (data: { error: string }) => void

  // 视频号上墙
  [IPC_CHANNELS.tasks.pinComment]: (params: { accountId: string; content: string }) => void

  // 一键发红包
  [IPC_CHANNELS.tasks.redPacket.send]: (accountId: string, duration: string) => boolean

  // 转播
  [IPC_CHANNELS.tasks.relay.start]: () => Promise<RelayServiceStatus>
  [IPC_CHANNELS.tasks.relay.status]: (resolve?: boolean) => Promise<RelayServiceStatus>
  [IPC_CHANNELS.tasks.relay.updateSettings]: (
    settings: Partial<RelaySettings> & { resolve?: boolean; enable_stream?: boolean },
  ) => Promise<RelayServiceStatus>
  [IPC_CHANNELS.tasks.relay.control]: (action: 'start' | 'stop') => Promise<RelayServiceStatus>
  [IPC_CHANNELS.tasks.relay.shutdown]: () => Promise<{
    ok: boolean
    message?: string
    error?: string
  }>
  [IPC_CHANNELS.tasks.relay.openPanel]: () => Promise<{ ok: boolean; error?: string }>

  // Updater
  [IPC_CHANNELS.updater.checkUpdate]: () => Promise<
    { latestVersion: string; currentVersion: string; releaseNote?: string } | undefined
  >
  [IPC_CHANNELS.updater.startDownload]: (source: string) => void
  [IPC_CHANNELS.updater.quitAndInstall]: () => void
  [IPC_CHANNELS.updater.updateAvailable]: (info: VersionInfo) => void
  [IPC_CHANNELS.updater.updateError]: (error: ErrorType) => void
  [IPC_CHANNELS.updater.downloadProgress]: (progress: ProgressInfo) => void
  [IPC_CHANNELS.updater.updateDownloaded]: (event?: UpdateDownloadedEvent) => void

  // Chrome
  [IPC_CHANNELS.chrome.selectPath]: () => string | null
  [IPC_CHANNELS.chrome.getPath]: (edge?: boolean) => string | null
  [IPC_CHANNELS.chrome.toggleDevTools]: () => void
  [IPC_CHANNELS.chrome.setPath]: (path: string) => void
  [IPC_CHANNELS.chrome.saveState]: (accountId: string, state: string) => void

  // App
  [IPC_CHANNELS.app.openLogFolder]: () => void
  [IPC_CHANNELS.app.openExternal]: (url: string) => void
  [IPC_CHANNELS.app.notifyUpdate]: (arg: {
    currentVersion: string
    latestVersion: string
    releaseNote?: string
  }) => void
  [IPC_CHANNELS.app.getProviders]: () => Record<string, ProviderInfo>
  [IPC_CHANNELS.app.providersUpdated]: (providers: Record<string, ProviderInfo>) => void

  [IPC_CHANNELS.account.switch]: (params: { account: Account }) => void

  // Log
  [IPC_CHANNELS.log]: (message: LogMessage) => void
}

export interface ElectronAPI {
  ipcRenderer: {
    invoke: <Channel extends keyof IpcChannels>(
      channel: Channel,
      ...args: Parameters<IpcChannels[Channel]>
    ) => ReturnType<IpcChannels[Channel]> extends Promise<infer _U>
      ? ReturnType<IpcChannels[Channel]>
      : Promise<ReturnType<IpcChannels[Channel]>>

    send: <Channel extends keyof IpcChannels>(
      channel: Channel,
      ...args: Parameters<IpcChannels[Channel]>
    ) => void

    on: <Channel extends keyof IpcChannels>(
      channel: Channel,
      listener: (...args: Parameters<IpcChannels[Channel]>) => void,
    ) => () => void
  }
}

export interface RelaySettings {
  room_url: string
  quality: string
  output_mode: 'auto' | 'hls' | 'transcode' | 'flv'
  listen_host: string
  port: number
  cookie: string
  upstream_proxy: string
  chunk_size: number
  transcode_preset: string
}

export interface RelayResolveResult {
  ok: boolean
  is_live: boolean
  anchor_name: string
  title: string
  quality: string
  flv_url: string
  m3u8_url: string
  selected_url: string
  selected_type: string
  codec: string
  hevc: boolean
  output_mode: string
  error: string
  resolved_at: number
}

export interface RelayLogEntry {
  time: number
  level: string
  message: string
}

export interface RelayStatusPayload {
  service_id: 'oba-video-relay'
  protocol_version: 1
  settings: RelaySettings
  result: RelayResolveResult | null
  active_clients: number
  stream_enabled: boolean
  stream_generation: number
  source_version: number
  uptime_seconds: number
  obs_url: string
  lan_urls: string[]
  logs: RelayLogEntry[]
}

export interface RelayServiceStatus {
  supported: boolean
  serviceRunning: boolean
  resourceReady: boolean
  panelUrl: string
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'unknown'
  error?: string
  errorCode?:
    | 'unsupported'
    | 'resource-missing'
    | 'refused'
    | 'timeout'
    | 'http'
    | 'invalid-service'
    | 'startup'
    | 'operation'
    | 'shell'
  data?: RelayStatusPayload
}
