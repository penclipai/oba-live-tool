import { RadioTower } from 'lucide-react'
import { NavLink } from 'react-router'
import { autoReplyPlatforms } from '@/abilities'
import { useCurrentAutoMessage } from '@/hooks/useAutoMessage'
import { useCurrentAutoPopUp } from '@/hooks/useAutoPopUp'
import { useAutoReply } from '@/hooks/useAutoReply'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { type RelayIndicatorState, useRelayStatusIndicator } from '@/hooks/useRelayStatusIndicator'
import { cn } from '@/lib/utils'
import {
  CarbonBlockStorage,
  CarbonChat,
  CarbonContentDeliveryNetwork,
  CarbonGift,
  CarbonIbmEventAutomation,
  CarbonIbmWatsonTextToSpeech,
  CarbonSettings,
} from '../icons/carbon'

interface SidebarTab {
  id: string
  name: string
  isRunning?: boolean
  indicatorState?: Exclude<RelayIndicatorState, 'idle'>
  icon: React.ReactNode
  platform?: LiveControlPlatform[]
}

const indicatorMeta = {
  active: {
    className: 'bg-emerald-500',
    label: '转播输出中',
  },
  listening: {
    className: 'bg-yellow-400',
    label: '正在监听直播间',
  },
} satisfies Record<Exclude<RelayIndicatorState, 'idle'>, { className: string; label: string }>

export default function Sidebar() {
  const isAutoMessageRunning = useCurrentAutoMessage(context => context.isRunning)
  const isAutoPopupRunning = useCurrentAutoPopUp(context => context.isRunning)
  const { isRunning: isAutoReplyRunning } = useAutoReply()
  const platform = useCurrentLiveControl(context => context.platform)
  const relayIndicatorState = useRelayStatusIndicator()

  const tabs: SidebarTab[] = [
    {
      id: '/',
      name: '打开中控台',
      icon: <CarbonContentDeliveryNetwork className="w-5 h-5" />,
    },
    {
      id: '/auto-message',
      name: '自动发言',
      isRunning: isAutoMessageRunning,
      icon: <CarbonChat className="w-5 h-5" />,
    },
    {
      id: '/auto-popup',
      name: '自动弹窗',
      isRunning: isAutoPopupRunning,
      icon: <CarbonBlockStorage className="w-5 h-5" />,
    },
    {
      id: '/auto-reply',
      name: '自动回复',
      isRunning: isAutoReplyRunning,
      icon: <CarbonIbmEventAutomation className="w-5 h-5" />,
      platform: autoReplyPlatforms,
    },
    {
      id: '/red-packet',
      name: '一键发红包',
      icon: <CarbonGift className="w-5 h-5" />,
      platform: ['douyin', 'buyin'],
    },
    {
      id: '/relay',
      name: '转播',
      icon: <RadioTower className="w-5 h-5" />,
      indicatorState: relayIndicatorState === 'idle' ? undefined : relayIndicatorState,
    },
    {
      id: '/ai-chat',
      name: 'AI 助手',
      icon: <CarbonIbmWatsonTextToSpeech className="w-5 h-5" />,
    },
    {
      id: '/settings',
      name: '应用设置',
      icon: <CarbonSettings className="w-5 h-5" />,
    },
  ]

  const filteredTabs = tabs.filter(tab => {
    if (tab.platform) {
      return tab.platform.includes(platform)
    }
    return true
  })

  return (
    <aside className="w-64 min-w-[256px] bg-background border-r">
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-6">功能列表</h2>
        <nav className="space-y-2">
          {filteredTabs.map(tab => (
            <SidebarNavLink key={tab.id} tab={tab} />
          ))}
        </nav>
      </div>
    </aside>
  )
}

function SidebarNavLink({ tab }: { tab: SidebarTab }) {
  const indicatorState = tab.indicatorState ?? (tab.isRunning ? 'active' : undefined)
  const indicator = indicatorState ? indicatorMeta[indicatorState] : undefined

  return (
    <NavLink
      to={tab.id}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-all relative',
          isActive
            ? 'bg-primary/10 text-primary shadow-xs'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      {tab.icon}
      {tab.name}
      {indicator && (
        <span
          className={cn('absolute right-3 w-2 h-2 rounded-full animate-pulse', indicator.className)}
          role="status"
          aria-label={indicator.label}
          title={indicator.label}
        />
      )}
    </NavLink>
  )
}
