import { IPC_CHANNELS } from 'shared/ipcChannels'
import { videoRelayService } from '#/services/VideoRelayService'
import { typedIpcMainHandle } from '#/utils'

export function setupRelayIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.start, () => {
    return videoRelayService.start()
  })

  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.status, (_, resolve = false) => {
    return videoRelayService.status(resolve)
  })

  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.updateSettings, (_, settings) => {
    return videoRelayService.updateSettings(settings)
  })

  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.control, (_, action) => {
    return videoRelayService.control(action)
  })

  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.shutdown, () => {
    return videoRelayService.shutdown()
  })

  typedIpcMainHandle(IPC_CHANNELS.tasks.relay.openPanel, () => {
    return videoRelayService.openPanel()
  })
}
