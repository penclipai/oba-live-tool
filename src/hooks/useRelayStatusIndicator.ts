import { useEffect, useState } from 'react'
import type { RelayServiceStatus } from 'shared/electron-api'
import { IPC_CHANNELS } from 'shared/ipcChannels'

export type RelayIndicatorState = 'idle' | 'listening' | 'active'

const RELAY_STATUS_POLL_INTERVAL_MS = 3000

function resolveRelayIndicatorState(status: RelayServiceStatus): RelayIndicatorState {
  const result = status.data?.result
  const hasRoomInfo = Boolean(result && (result.anchor_name || result.title))
  const isActive = Boolean(
    status.serviceRunning &&
      status.data?.stream_enabled &&
      result?.ok &&
      result.is_live &&
      result.selected_url?.trim(),
  )

  if (isActive) return 'active'
  if (status.serviceRunning && hasRoomInfo) return 'listening'
  return 'idle'
}

export function useRelayStatusIndicator() {
  const [state, setState] = useState<RelayIndicatorState>('idle')

  useEffect(() => {
    let mounted = true

    const refresh = async () => {
      try {
        const status = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.relay.status)
        if (mounted) {
          setState(resolveRelayIndicatorState(status))
        }
      } catch {
        if (mounted) {
          setState('idle')
        }
      }
    }

    refresh()
    const timer = window.setInterval(refresh, RELAY_STATUS_POLL_INTERVAL_MS)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  return state
}
