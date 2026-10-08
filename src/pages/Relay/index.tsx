import {
  ChevronDown,
  CircleHelp,
  ClipboardCopy,
  ExternalLink,
  History,
  Play,
  Power,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  RelayLogEntry,
  RelayServiceStatus,
  RelaySettings,
  RelayStatusPayload,
} from 'shared/electron-api'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useRelayHistory } from '@/hooks/useRelayHistory'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'
import {
  panelOpenError,
  type RelayRequestToken,
  RelayUiState,
  relayOfflineMessage,
  relayStatusLabel,
} from './relayUiState'

type RelayForm = Pick<
  RelaySettings,
  'room_url' | 'quality' | 'output_mode' | 'upstream_proxy' | 'transcode_preset'
> & {
  cookie: string
}

const defaultForm: RelayForm = {
  room_url: '',
  quality: 'OD',
  output_mode: 'auto',
  upstream_proxy: '',
  transcode_preset: 'veryfast',
  cookie: '',
}

const qualityOptions = [
  { value: 'OD', label: '原画' },
  { value: 'BD', label: '蓝光' },
  { value: 'UHD', label: '超清' },
  { value: 'HD', label: '高清' },
  { value: 'SD', label: '标清' },
  { value: 'LD', label: '流畅' },
]

const outputModeOptions = [
  { value: 'auto', label: '自动' },
  { value: 'flv', label: '强制 FLV' },
  { value: 'hls', label: 'HLS' },
  { value: 'transcode', label: '转码为 FLV' },
]

const supportedRelayPlatforms = {
  domestic:
    '抖音|快手|虎牙|斗鱼|YY|B站|小红书|bigo|blued|网易CC|千度热播|猫耳FM|Look|TwitCasting|百度|微博|酷狗|花椒|流星|Acfun|畅聊|映客|音播|知乎|嗨秀|VV星球|17Live|浪Live|漂漂|六间房|乐嗨|花猫|淘宝|京东|咪咕|连接|来秀',
  overseas:
    'TikTok|SOOP|PandaTV|WinkTV|FlexTV|PopkonTV|TwitchTV|LiveMe|ShowRoom|CHZZK|Shopee|Youtube|Faceit|Picarto',
}

const MAX_RELAY_LOGS = 200

function relayInvoke<Channel extends Parameters<typeof window.ipcRenderer.invoke>[0]>(
  ...args: Parameters<typeof window.ipcRenderer.invoke<Channel>>
) {
  return window.ipcRenderer.invoke(...args)
}

function formatTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString()
}

function logKey(log: RelayLogEntry) {
  return `${log.time}:${log.level}:${log.message}`
}

function StatusBadge({
  running,
  error,
  children,
}: {
  running: boolean
  error?: string
  children: React.ReactNode
}) {
  return (
    <Badge variant={running && !error ? 'default' : 'secondary'} className="h-7 px-3">
      {children}
    </Badge>
  )
}

function CompactStatus({
  label,
  value,
  className,
}: {
  label: string
  value: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className="mt-1 truncate text-sm font-medium"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
    </div>
  )
}

function RelayLogPanel({ logs }: { logs: RelayLogEntry[] }) {
  const [logMessages, setLogMessages] = useState<RelayLogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const seenLogKeysRef = useRef(new Set<string>())
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const autoScrollId = useId()

  const scrollToBottom = useCallback(() => {
    if (!autoScroll || !viewportRef.current) return
    requestAnimationFrame(() => {
      if (viewportRef.current) {
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight
      }
    })
  }, [autoScroll])

  useEffect(() => {
    if (!expanded) {
      viewportRef.current = null
      return
    }
    viewportRef.current =
      scrollAreaRef.current?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]') ??
      null
    if (logMessages.length > 0) scrollToBottom()
  }, [expanded, logMessages, scrollToBottom])

  useEffect(() => {
    const freshLogs = logs.filter(log => !seenLogKeysRef.current.has(logKey(log)))
    if (freshLogs.length === 0) return

    for (const log of freshLogs) {
      seenLogKeysRef.current.add(logKey(log))
    }
    setLogMessages(prev => [...prev, ...freshLogs].slice(-MAX_RELAY_LOGS))
  }, [logs])

  const clearLogs = useCallback(() => {
    seenLogKeysRef.current = new Set(logs.map(logKey))
    setLogMessages([])
  }, [logs])

  const latestLog = logMessages.at(-1)
  const errorCount = logMessages.filter(log =>
    ['error', 'fatal'].includes(log.level.toLowerCase()),
  ).length

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card data-testid="relay-logs" className="overflow-hidden">
        <div className="flex h-10 min-w-0 items-center gap-2 px-3">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="group shrink-0 gap-2 px-1"
              data-testid="relay-log-toggle"
            >
              <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
              转播日志
              <span className="text-xs font-normal text-muted-foreground">
                {logMessages.length} 条记录
              </span>
            </Button>
          </CollapsibleTrigger>
          {errorCount > 0 && (
            <span className="shrink-0 text-xs font-medium text-destructive">
              {errorCount} 条错误
            </span>
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              latestLog ? getLogLevelColor(latestLog.level) : 'text-muted-foreground',
            )}
            title={latestLog?.message}
          >
            {latestLog?.message || '暂无日志，启动转播后会自动刷新。'}
          </span>
        </div>
        <CollapsibleContent>
          <div className="flex items-center justify-end gap-3 border-t px-3 py-1">
            <div className="flex items-center gap-2">
              <Switch id={autoScrollId} checked={autoScroll} onCheckedChange={setAutoScroll} />
              <Label
                htmlFor={autoScrollId}
                className="cursor-pointer text-xs text-muted-foreground"
              >
                自动滚动
              </Label>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearLogs}
              data-testid="relay-log-clear"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            >
              清空
            </Button>
          </div>
          <ScrollArea ref={scrollAreaRef} className="h-40 border-t" data-testid="relay-log-content">
            <div className="p-3 font-mono text-sm">
              {logMessages.length === 0 ? (
                <div className="text-muted-foreground">暂无日志，启动转播后会自动刷新。</div>
              ) : (
                logMessages.map((log, index) => (
                  <div
                    key={logKey(log)}
                    className={cn(
                      'flex min-w-0 items-start gap-2 py-1',
                      index % 2 === 0 ? 'bg-muted/40' : 'bg-background',
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">[{formatTime(log.time)}]</span>
                    <span className={cn('shrink-0 uppercase', getLogLevelColor(log.level))}>
                      {log.level}
                    </span>
                    <span className="min-w-0 break-words text-foreground">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function getLogLevelColor(level: string) {
  switch (level.toLowerCase()) {
    case 'error':
    case 'fatal':
      return 'font-medium text-destructive'
    case 'warn':
    case 'warning':
      return 'font-medium text-warning'
    case 'info':
      return 'text-muted-foreground'
    case 'http':
      return 'text-blue-600'
    default:
      return 'text-muted-foreground'
  }
}

export default function Relay() {
  const { toast } = useToast()
  const [status, setStatus] = useState<RelayServiceStatus | null>(null)
  const [form, setForm] = useState<RelayForm>(defaultForm)
  const [cookieTouched, setCookieTouched] = useState(false)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const relayUiStateRef = useRef(new RelayUiState())
  const relayHistoryUrls = useRelayHistory(state => state.urls)
  const addRelayHistoryUrl = useRelayHistory(state => state.addUrl)
  const removeRelayHistoryUrl = useRelayHistory(state => state.removeUrl)

  const data: RelayStatusPayload | undefined = status?.data
  const result = data?.result
  const serviceReady = Boolean(status?.serviceRunning && data)
  const isUnsupported = status?.supported === false
  const streamEnabled = Boolean(data?.stream_enabled)
  const currentRoomName = [result?.anchor_name, result?.title].filter(Boolean).join(' / ')

  const hydrateForm = useCallback((settings: RelaySettings, capturedRevision: number) => {
    if (!relayUiStateRef.current.canUpdateForm(capturedRevision)) return
    setForm({
      room_url: settings.room_url,
      quality: settings.quality,
      output_mode: settings.output_mode,
      upstream_proxy: settings.upstream_proxy,
      transcode_preset: settings.transcode_preset,
      cookie: '',
    })
    setCookieTouched(false)
  }, [])

  const applyStatus = useCallback(
    (
      nextStatus: RelayServiceStatus,
      token: RelayRequestToken,
      capturedFormRevision: number,
      allowActiveAction = false,
    ) => {
      if (!relayUiStateRef.current.canApply(token, allowActiveAction)) return false
      setStatus(nextStatus)
      if (nextStatus.data?.settings) {
        hydrateForm(nextStatus.data.settings, capturedFormRevision)
      }
      return true
    },
    [hydrateForm],
  )

  const refreshStatus = useCallback(
    async (resolve = false) => {
      const relayUiState = relayUiStateRef.current
      const action = resolve ? 'resolve' : null
      const token = action ? relayUiState.beginAction(action) : relayUiState.beginRequest()
      if (!token) return null
      if (!resolve && relayUiState.action) return null
      const capturedFormRevision = relayUiState.currentFormRevision()
      if (action) setLoadingAction(action)
      try {
        const nextStatus = await relayInvoke(IPC_CHANNELS.tasks.relay.status, resolve)
        applyStatus(nextStatus, token, capturedFormRevision, Boolean(action))
        return nextStatus
      } catch (error) {
        if (resolve) {
          toast.error(`刷新解析失败：${error instanceof Error ? error.message : '请稍后重试'}`)
        }
        return null
      } finally {
        if (action) {
          relayUiState.endAction(action)
          setLoadingAction(current => (current === action ? null : current))
        }
      }
    },
    [applyStatus, toast],
  )

  useEffect(() => {
    refreshStatus()
    const timer = window.setInterval(() => {
      refreshStatus()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshStatus])

  const buildSettingsPayload = useCallback(() => {
    const payload: Record<string, unknown> = {
      room_url: form.room_url.trim(),
      quality: form.quality,
      output_mode: form.output_mode,
      upstream_proxy: form.upstream_proxy.trim(),
      transcode_preset: form.transcode_preset.trim() || 'veryfast',
      enable_stream: true,
      resolve: true,
    }
    if (cookieTouched) {
      payload.cookie = form.cookie
    }
    return payload
  }, [cookieTouched, form])

  const saveAndStart = useCallback(async () => {
    if (!form.room_url.trim()) {
      toast.error('请先填写直播间地址')
      return
    }

    const action = 'save-start'
    const relayUiState = relayUiStateRef.current
    const token = relayUiState.beginAction(action)
    if (!token) return
    const capturedFormRevision = relayUiState.currentFormRevision()
    setLoadingAction(action)
    try {
      const updated = await relayInvoke(
        IPC_CHANNELS.tasks.relay.updateSettings,
        buildSettingsPayload(),
      )
      applyStatus(updated, token, capturedFormRevision, true)
      const result = updated.data?.result
      const roomLabel = [result?.anchor_name, result?.title].filter(Boolean).join(' / ')
      const roomInfoResolved = Boolean(updated.serviceRunning && result && roomLabel)
      const streamReady = Boolean(
        updated.serviceRunning && result?.ok && result.is_live && result.selected_url?.trim(),
      )

      const saveSucceeded = !updated.error && updated.state === 'running'
      if (saveSucceeded && relayUiState.markSaved(capturedFormRevision)) {
        if (updated.data?.settings) {
          hydrateForm(updated.data.settings, capturedFormRevision)
        }
        setCookieTouched(false)
      }

      if (roomInfoResolved && saveSucceeded) {
        const savedUrl = updated.data?.settings.room_url || form.room_url
        addRelayHistoryUrl(savedUrl, roomLabel)
      }

      if (updated.error || updated.state === 'unknown') {
        toast.error(updated.error || '操作状态待确认，请稍后刷新状态')
      } else if (streamReady) {
        toast.success('直播源已解析，OBS 可使用固定地址拉流')
      } else if (roomInfoResolved) {
        toast.error(result?.error || '直播间信息已保存，但当前未开播或暂无可用直播流')
      } else {
        toast.error(
          result?.error || updated.error || '直播源解析失败，请检查直播间地址、开播状态或 Cookie',
        )
      }
    } catch (error) {
      toast.error(`保存转播设置失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      relayUiState.endAction(action)
      setLoadingAction(current => (current === action ? null : current))
    }
  }, [addRelayHistoryUrl, applyStatus, buildSettingsPayload, form.room_url, hydrateForm, toast])

  const stopOutput = useCallback(async () => {
    const action = 'stop'
    const relayUiState = relayUiStateRef.current
    const token = relayUiState.beginAction(action)
    if (!token) return
    const capturedFormRevision = relayUiState.currentFormRevision()
    setLoadingAction(action)
    try {
      const response = await relayInvoke(IPC_CHANNELS.tasks.relay.control, 'stop')
      applyStatus(response, token, capturedFormRevision, true)
      if (response.error || response.state === 'unknown') {
        toast.error(response.error || '停止操作状态待确认，请稍后刷新')
      } else {
        toast.success('转播输出已停止')
      }
    } catch (error) {
      toast.error(`停止转播输出失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      relayUiState.endAction(action)
      setLoadingAction(current => (current === action ? null : current))
    }
  }, [applyStatus, toast])

  const shutdown = useCallback(async () => {
    const action = 'shutdown'
    const relayUiState = relayUiStateRef.current
    if (!relayUiState.beginAction(action)) return
    setLoadingAction(action)
    try {
      const response = await relayInvoke(IPC_CHANNELS.tasks.relay.shutdown)
      if (response.ok) {
        toast.success('转播服务已关闭')
        relayUiState.endAction(action)
        setLoadingAction(null)
        await refreshStatus()
      } else {
        toast.error(response.error || '转播服务关闭失败')
      }
    } catch (error) {
      toast.error(`关闭转播服务失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      relayUiState.endAction(action)
      setLoadingAction(current => (current === action ? null : current))
    }
  }, [refreshStatus, toast])

  const openPanel = useCallback(async () => {
    const action = 'open-panel'
    const relayUiState = relayUiStateRef.current
    if (!relayUiState.beginAction(action)) return
    setLoadingAction(action)
    try {
      const opened = await relayInvoke(IPC_CHANNELS.tasks.relay.openPanel)
      const error = panelOpenError(opened)
      if (error) toast.error(error)
    } catch (error) {
      toast.error(`打开转播控制台失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      relayUiState.endAction(action)
      setLoadingAction(current => (current === action ? null : current))
    }
  }, [toast])

  const copyObsUrl = useCallback(async () => {
    const url =
      data?.obs_url || status?.panelUrl.replace(/\/$/, '/live') || 'http://127.0.0.1:5000/live'
    await navigator.clipboard.writeText(url)
    toast.success('OBS 地址已复制')
  }, [data?.obs_url, status?.panelUrl, toast])

  const upstreamState = useMemo(() => {
    if (status?.state === 'unknown') return '状态待确认'
    if (!data) return '服务未启动'
    if (!data.stream_enabled) return '输出已停止'
    if (!result) return '等待解析'
    if (result.ok && result.is_live) return '直播中'
    if (result.ok) return '未开播'
    return result.error || '不可用'
  }, [data, result, status?.state])

  const setField = <Key extends keyof RelayForm>(key: Key, value: RelayForm[Key]) => {
    relayUiStateRef.current.markEdited()
    setForm(current => ({ ...current, [key]: value }))
  }

  const selectHistoryUrl = (url: string) => {
    setField('room_url', url)
  }

  return (
    <div className="min-w-0 space-y-3" data-testid="relay-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">转播</h1>
          <p className="text-sm text-muted-foreground">连接直播源，为 OBS 提供固定地址</p>
        </div>
        <StatusBadge running={serviceReady} error={status?.error}>
          {relayStatusLabel(status?.state, serviceReady)}
        </StatusBadge>
      </div>
      {isUnsupported && (
        <div className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
          转播功能当前仅支持 Windows。macOS 版本暂不托管 video-box 后台服务。
        </div>
      )}
      <Card data-testid="relay-workspace" className="overflow-hidden">
        <CardContent className="space-y-3 p-4">
          {(!serviceReady || status?.error) && (
            <p
              className={cn(
                'text-sm',
                status?.error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {status?.error || relayOfflineMessage(status?.state, status?.error)}
              {serviceReady && status?.error && '（下方显示最近一次确认的状态）'}
            </p>
          )}
          {currentRoomName && (
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">当前直播间</span>
              <span className="truncate text-sm font-medium" title={currentRoomName}>
                {currentRoomName}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="relay-room-url">直播间地址</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="查看支持平台"
                      >
                        <CircleHelp className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[420px]">
                      <div className="space-y-2 text-left text-xs leading-relaxed">
                        <div className="font-medium text-sm">支持平台</div>
                        <div>
                          <span className="font-medium">国内站点：</span>
                          <span className="break-words">{supportedRelayPlatforms.domestic}</span>
                        </div>
                        <div>
                          <span className="font-medium">海外站点：</span>
                          <span className="break-words">{supportedRelayPlatforms.overseas}</span>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {relayHistoryUrls.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  已保存 {relayHistoryUrls.length} 条
                </span>
              )}
            </div>
            <div className="flex min-w-0 gap-2">
              <Input
                className="min-w-0"
                id="relay-room-url"
                value={form.room_url}
                onChange={event => setField('room_url', event.target.value)}
                placeholder="https://live.douyin.com/..."
              />
              {relayHistoryUrls.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label="选择历史直播间"
                      title="选择历史直播间"
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[420px] max-w-[calc(100vw-2rem)] p-2">
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">历史直播间</div>
                    <div className="max-h-72 overflow-auto">
                      {relayHistoryUrls.map(item => (
                        <div
                          key={item.url}
                          className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            title={item.url}
                            onClick={() => selectHistoryUrl(item.url)}
                          >
                            <div className="truncate text-sm">{item.label || item.url}</div>
                            {item.label && (
                              <div className="truncate text-xs text-muted-foreground">
                                {item.url}
                              </div>
                            )}
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label="删除这条历史记录"
                            title="删除这条历史记录"
                            onClick={() => removeRelayHistoryUrl(item.url)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap gap-3">
              <div className="min-w-36 flex-1 space-y-1.5">
                <Label htmlFor="relay-output-mode">输出模式</Label>
                <Select
                  value={form.output_mode}
                  onValueChange={value =>
                    setField('output_mode', value as RelayForm['output_mode'])
                  }
                >
                  <SelectTrigger id="relay-output-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {outputModeOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-36 flex-1 space-y-1.5">
                <Label htmlFor="relay-quality">清晰度</Label>
                <Select value={form.quality} onValueChange={value => setField('quality', value)}>
                  <SelectTrigger id="relay-quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {qualityOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                onClick={saveAndStart}
                disabled={loadingAction !== null || isUnsupported}
                className="min-w-36"
              >
                <Play className="mr-2 h-4 w-4" />
                保存并开始转播
              </Button>
              {streamEnabled && (
                <Button
                  variant="outline"
                  onClick={stopOutput}
                  disabled={loadingAction !== null || !serviceReady}
                >
                  <Square className="mr-2 h-4 w-4" />
                  停止输出
                </Button>
              )}
            </div>
          </div>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="group h-8 px-0 text-muted-foreground hover:bg-transparent"
              >
                高级设置
                <ChevronDown className="ml-2 h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              <div className="space-y-2">
                <Label htmlFor="relay-cookie">Cookie</Label>
                <Textarea
                  id="relay-cookie"
                  value={form.cookie}
                  onChange={event => {
                    setField('cookie', event.target.value)
                    setCookieTouched(true)
                  }}
                  placeholder={
                    data?.settings.cookie
                      ? '已配置 Cookie；留空不会覆盖'
                      : '可选，用于需要登录态的直播源'
                  }
                  rows={3}
                  className="min-h-18 resize-y"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="relay-proxy">上游代理</Label>
                  <Input
                    id="relay-proxy"
                    value={form.upstream_proxy}
                    onChange={event => setField('upstream_proxy', event.target.value)}
                    placeholder="http://127.0.0.1:7890"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="relay-preset">转码 preset</Label>
                  <Input
                    id="relay-preset"
                    value={form.transcode_preset}
                    onChange={event => setField('transcode_preset', event.target.value)}
                    placeholder="veryfast"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
        <div
          className="flex flex-wrap items-center gap-3 border-t bg-muted/20 px-4 py-3"
          data-testid="relay-status"
        >
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <CompactStatus label="上游状态" value={upstreamState} />
            <CompactStatus label="输出" value={result?.selected_type || form.output_mode || '-'} />
            <CompactStatus
              label="编码"
              value={result?.codec ? `${result.codec}${result.hevc ? ' HEVC' : ''}` : '-'}
            />
            <CompactStatus label="OBS 连接" value={data?.active_clients ?? 0} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refreshStatus(true)}
            disabled={loadingAction !== null}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新解析
          </Button>
        </div>
        <div className="border-t px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">OBS 固定地址</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="查看 OBS 配置说明"
                  >
                    <CircleHelp className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-72">
                  <div className="space-y-1 text-left">
                    <div className="font-medium">OBS 配置</div>
                    <div>添加“媒体源”，取消勾选“本地文件”。</div>
                    <div>
                      输入框填写：
                      <code className="ml-1">http://127.0.0.1:5000/live</code>
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>{' '}
            <code className="min-w-0 flex-1 break-all text-sm" data-testid="relay-obs-url">
              {data?.obs_url || 'http://127.0.0.1:5000/live'}
            </code>
            <Button variant="outline" size="sm" onClick={copyObsUrl}>
              <ClipboardCopy className="mr-2 h-4 w-4" />
              复制
            </Button>
          </div>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="group h-8 px-0 text-muted-foreground hover:bg-transparent"
              >
                局域网地址
                {data?.lan_urls?.length ? (
                  <span className="ml-2 text-xs">({data.lan_urls.length})</span>
                ) : null}
                <ChevronDown className="ml-2 h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {(data?.lan_urls?.length ? data.lan_urls : ['启动服务后显示']).map(url => (
                <div key={url} className="rounded-md bg-muted/40 px-3 py-2 text-sm">
                  <code className="break-all">{url}</code>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>{' '}
        </div>
      </Card>
      <RelayLogPanel logs={data?.logs ?? []} />
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group px-2 text-muted-foreground">
            维护操作
            <ChevronDown className="ml-2 h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={openPanel}
              disabled={loadingAction !== null || isUnsupported}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              打开原控制台
            </Button>
            <Button
              variant="destructive"
              onClick={shutdown}
              disabled={loadingAction !== null || !serviceReady}
            >
              <Power className="mr-2 h-4 w-4" />
              关闭后台服务
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            关闭后台服务将断开 OBS 连接；暂停转播请使用“停止输出”。
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
