export interface RelayRequestToken {
  epoch: number
  request: number
}

/**
 * Coordinates asynchronous relay requests with local form edits. This is kept
 * outside the component so the ordering rules are independently testable.
 */
export class RelayUiState {
  private activeAction: string | null = null
  private appliedRequest = 0
  private epoch = 0
  private formDirty = false
  private request = 0
  private formRevision = 0

  get action() {
    return this.activeAction
  }

  beginRequest(): RelayRequestToken {
    return { epoch: this.epoch, request: ++this.request }
  }

  beginAction(action: string): RelayRequestToken | null {
    if (this.activeAction) return null
    this.activeAction = action
    this.epoch += 1
    return this.beginRequest()
  }

  endAction(action: string) {
    if (this.activeAction === action) this.activeAction = null
  }

  canApply(token: RelayRequestToken, allowActiveAction = false) {
    if (token.epoch !== this.epoch || (!allowActiveAction && this.activeAction)) return false
    if (token.request < this.appliedRequest) return false
    this.appliedRequest = token.request
    return true
  }

  markEdited() {
    this.formRevision += 1
    this.formDirty = true
    return this.formRevision
  }

  currentFormRevision() {
    return this.formRevision
  }

  canUpdateForm(capturedRevision: number) {
    return !this.formDirty && capturedRevision === this.formRevision
  }

  markSaved(capturedRevision: number) {
    if (capturedRevision !== this.formRevision) return false
    this.formDirty = false
    return true
  }
}

export function relayStatusLabel(state: string | undefined, serviceReady: boolean) {
  if (state === 'unknown') return '状态待确认'
  if (serviceReady) return '后台运行中'
  if (state === 'starting') return '正在启动'
  if (state === 'stopping') return '正在关闭'
  return '服务未启动'
}

export function relayOfflineMessage(state: string | undefined, error: string | undefined) {
  if (state === 'unknown') return '状态待确认。请稍后刷新，或检查本地转播服务。'
  if (state === 'stopped') return '服务尚未启动。点击主按钮后会自动启动本地转播服务。'
  return error || '服务未启动。点击主按钮后会自动启动本地转播服务。'
}

export function panelOpenError(response: { ok: boolean; error?: string }) {
  return response.ok ? null : response.error || '打开转播控制台失败'
}
