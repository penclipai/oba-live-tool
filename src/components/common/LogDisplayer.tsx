import { useMemoizedFn } from 'ahooks'
import type { LogMessage } from 'electron-log'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { useIpcListener } from '@/hooks/useIpc'
import { cn } from '@/lib/utils'

interface ParsedLog {
  id: string
  timestamp: string
  module: string
  level: string
  message: string
}

// interface LogMessage {
//   logId: string
//   date: Date
//   scope?: string
//   level: string
//   data: string[]
// }

const MAX_LOG_MESSAGES = 200 // 仅展示最近的 200 条日志

interface LogDisplayerProps {
  collapsible?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

export default function LogDisplayer({
  collapsible = false,
  expanded = true,
  onExpandedChange,
}: LogDisplayerProps) {
  const [logMessages, setLogMessages] = useState<ParsedLog[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    if (viewportRef.current && autoScroll) {
      const scrollContainer = viewportRef.current
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      })
    }
  }, [autoScroll])

  const parseLogMessage = (log: LogMessage): ParsedLog | null => {
    if (!log.data || log.data.length === 0) {
      return null
    }
    return {
      id: crypto.randomUUID(),
      timestamp: log.date.toLocaleString(),
      module: log.scope ?? 'App',
      level: typeof log.level === 'string' ? log.level.toUpperCase() : 'INFO',
      // 只保留换行符之前的内容
      message: log.data.map(String).join(' ').split('\n')[0],
    }
  }

  useEffect(() => {
    if (!expanded) {
      viewportRef.current = null
      return
    }

    // 监听 ScrollArea 的 viewport 元素
    if (scrollAreaRef.current) {
      const viewport = scrollAreaRef.current.querySelector<HTMLDivElement>(
        '[data-radix-scroll-area-viewport]',
      )
      if (viewport) {
        // 使用 MutableRefObject 来避免只读属性错误
        viewportRef.current = viewport
      }
    }
  }, [expanded])

  useEffect(() => {
    if (expanded && autoScroll && logMessages.length > 0) {
      scrollToBottom()
    }
  }, [autoScroll, expanded, logMessages, scrollToBottom])

  // biome-ignore lint/correctness/useExhaustiveDependencies: parseLogMessage 不影响
  const handleLogMessage = useCallback((message: LogMessage) => {
    const parsed = parseLogMessage(message)
    if (parsed) {
      setLogMessages(prev => [...prev.slice(-MAX_LOG_MESSAGES + 1), parsed])
    }
  }, [])

  useIpcListener(IPC_CHANNELS.log, handleLogMessage)

  const autoScrollId = useId()
  const logContentId = useId()
  const latestLog = logMessages.at(-1)
  const latestError = [...logMessages]
    .reverse()
    .find(log => log.level === 'ERROR' || log.level === 'FATAL')
  const canCollapse = collapsible && onExpandedChange

  const toggleExpanded = () => {
    onExpandedChange?.(!expanded)
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 日志头部 */}
      <div
        className={cn(
          'flex items-center justify-between px-4 border-b',
          expanded ? 'py-2' : 'h-10',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="shrink-0 font-medium">运行日志</h3>
          <span className="shrink-0 text-xs text-muted-foreground">
            {logMessages.length} 条记录
          </span>
          {!expanded && latestLog && (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={latestLog.message}
            >
              {latestLog.message}
            </span>
          )}
          {!expanded && latestError && (
            <span className="shrink-0 text-xs font-medium text-destructive">存在错误</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {expanded && (
            <>
              {/* 自动滚动开关 */}
              <div className="flex items-center gap-2">
                <Switch id={autoScrollId} checked={autoScroll} onCheckedChange={setAutoScroll} />
                <label
                  htmlFor={autoScrollId}
                  className="text-xs text-muted-foreground cursor-pointer select-none"
                >
                  自动滚动
                </label>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLogMessages([])
                  scrollToBottom()
                }}
                className="text-xs h-7 px-2 text-muted-foreground hover:text-destructive"
              >
                清空
              </Button>
            </>
          )}
          {canCollapse && (
            <Button
              data-testid="global-log-toggle"
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              aria-expanded={expanded}
              aria-controls={logContentId}
              onClick={toggleExpanded}
            >
              {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
              {expanded ? '收起' : '展开'}
            </Button>
          )}
        </div>
      </div>

      {expanded ? (
        <ScrollArea ref={scrollAreaRef} className="flex-1" id={logContentId}>
          <div className="p-4 font-mono text-sm">
            {logMessages.map((log, index) => (
              <LogItem key={log.id} log={log} index={index} />
            ))}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  )
}

function LogItem({ log, index }: { log: ParsedLog; index: number }) {
  const getLevelColor = useMemoizedFn((level: string): string => {
    switch (level.toUpperCase()) {
      case 'ERROR':
        return 'text-destructive font-medium'
      case 'FATAL':
        return 'text-destructive font-bold'
      case 'WARN':
        return 'text-warning font-medium'
      case 'DEBUG':
        return 'text-blue-600'
      case 'INFO':
        return 'text-muted-foreground'
      case 'SUCCESS':
        return 'text-emerald-600'
      case 'NOTE':
        return 'text-purple-600'
      default:
        return 'text-muted-foreground'
    }
  })
  return (
    <div
      key={log.id}
      className={cn(
        'flex gap-2 items-start py-1 whitespace-nowrap',
        index % 2 === 0 ? 'bg-muted/40' : 'bg-background',
      )}
    >
      <span className="text-muted-foreground shrink-0">[{log.timestamp}]</span>
      <span className="text-foreground/70 shrink-0">[{log.module}]</span>
      <span className={cn('shrink-0', getLevelColor(log.level))}>{log.level}</span>
      <span className="text-foreground truncate">{log.message}</span>
    </div>
  )
}
