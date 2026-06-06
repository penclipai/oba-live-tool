import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { STORAGE_KEYS } from '@/utils/storage'

export interface RelayHistoryItem {
  url: string
  label?: string
  lastUsedAt: number
}

interface RelayHistoryStore {
  urls: RelayHistoryItem[]
  addUrl: (url: string, label?: string) => void
  removeUrl: (url: string) => void
}

const MAX_RELAY_HISTORY = 20

export const useRelayHistory = create<RelayHistoryStore>()(
  persist(
    set => ({
      urls: [],
      addUrl: (url, label) => {
        const trimmedUrl = url.trim()
        if (!trimmedUrl) return

        set(state => {
          const nextItem: RelayHistoryItem = {
            url: trimmedUrl,
            label: label?.trim() || undefined,
            lastUsedAt: Date.now(),
          }
          const dedupedUrls = state.urls.filter(item => item.url !== trimmedUrl)
          return {
            urls: [nextItem, ...dedupedUrls].slice(0, MAX_RELAY_HISTORY),
          }
        })
      },
      removeUrl: url => {
        const trimmedUrl = url.trim()
        if (!trimmedUrl) return
        set(state => ({
          urls: state.urls.filter(item => item.url !== trimmedUrl),
        }))
      },
    }),
    {
      name: STORAGE_KEYS.RELAY_HISTORY,
      version: 1,
    },
  ),
)
