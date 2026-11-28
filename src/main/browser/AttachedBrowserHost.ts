import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WebContents } from 'electron'
import type { AttachedBrowserCommand } from '../../mms/protocol/connectionCommands'
import type { TrustedProfileBinding } from '../../mms/protocol/domainRegistry'
import type { BrowserWorkerResponse } from '../../shared/browser/types'
import { browserNavigationUrl } from '../../shared/browser/validation'
import { assertOwnedPath } from '../../mms/profiles/pathSafety'
import { ElectronAttachedBrowserBackend, TrustedGuestRegistry, wrapElectronWebContents } from './automation'
import type { AttachedWindowTabs } from './automation/backend'
import { TabActivity, type ActivityClock } from './automation/tabActivity'
import type { AttachedControlState } from '../../shared/browser/attached'
import type { InAppBrowserActivity, InAppBrowserCursor, InAppBrowserTabCommand } from '../../shared/browser/inApp'
import type {
  BrowserAttachmentAcknowledgeClosedParams,
  BrowserAttachmentOwnerParams,
  BrowserAttachmentRegisterParams,
  BrowserAttachmentRegisterResult,
  BrowserAttachmentUnregisterParams
} from '../../shared/browser/host'

interface HostConnection {
  binding(senderId: number): TrustedProfileBinding | null
  request<T>(sender: WebContents, method: string, params: unknown): Promise<T>
}

interface Registration {
  readonly sender: WebContents
  readonly guest: WebContents
  readonly localTabId: string
  readonly uiTabId: string
  readonly registrationId: string
  readonly registrationEpoch: number
  readonly binding: TrustedProfileBinding
  threadId?: string
  /** The thread the window shows the tab in; `null`: kept in every thread. Agents of other threads never see it. */
  ownerThreadId: string | null
  /** The window opened the tab because an agent asked for it (`browser_tabs` new, or its first tab): agents may close it. */
  agentOpened: boolean
  /** Who is using the tab: the person's input in it and around it, and the agent's steps. */
  readonly activity: TabActivity
  readonly stopActivity: Array<() => void>
  artifactRoot?: string
  readonly closureToken: string
  state?: AttachedControlState
  readonly pending: Set<Promise<unknown>>
  stopping: boolean
  selectingThread?: string
  closing?: Promise<void>
}

interface OrphanedRegistration {
  readonly registrationId: string
  readonly registrationEpoch: number
  readonly closureToken: string
  readonly binding: TrustedProfileBinding
}

interface PendingOpen {
  readonly sender: WebContents
  readonly threadId: string
  resolve(uiTabId: string): void
  reject(error: unknown): void
}

/** Clocks and waits for the tabs' activity (tests pass fakes). */
export interface AttachedBrowserHostOptions {
  readonly activityClock?: ActivityClock
  readonly conflictBackoffMs?: readonly number[]
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** How long a window has to register a tab an agent asked for. */
  readonly openTabTimeoutMs?: number
}

interface WindowHost {
  sender: WebContents
  binding: TrustedProfileBinding
  registry: TrustedGuestRegistry
  backend: ElectronAttachedBrowserBackend
  records: Map<string, Registration>
  sessions: Map<string, Registration>
  pending: Set<Promise<unknown>>
  stopping: boolean
  closing?: Promise<void>
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'browser_binding_invalid' })
}
/** The daemon's identifiers (`MmsBrowserService`): a thread of another computer is `nod_…:<thread id>`. */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value)) invalid('Invalid browser identifier')
  return value
}
function sameBinding(a: TrustedProfileBinding | null, b: TrustedProfileBinding): boolean {
  return a?.profileId === b.profileId && a.epoch === b.epoch
}

/** Owns real did-attach-webview handles. Renderer IDs are lookup hints only. */
export class AttachedBrowserHost {
  private readonly observed = new Map<number, Map<number, WebContents>>()
  private readonly windows = new Map<number, WindowHost>()
  private readonly context = new AsyncLocalStorage<{ host: WindowHost; record: Registration; command: AttachedBrowserCommand }>()
  private readonly orphaned = new Map<string, OrphanedRegistration>()
  private readonly pendingOpens = new Map<string, PendingOpen>()

  constructor(private readonly connection: HostConnection, private readonly options: AttachedBrowserHostOptions = {}) {}

  observeGuest(sender: WebContents, guest: WebContents): void {
    if (guest.hostWebContents !== sender) invalid('Browser guest does not belong to this window')
    let guests = this.observed.get(sender.id)
    if (!guests) {
      guests = new Map()
      this.observed.set(sender.id, guests)
      sender.once('destroyed', () => {
        this.observed.delete(sender.id)
        void this.releaseWindow(sender).catch(() => { /* Retained for shutdown retry. */ })
      })
    }
    guests.set(guest.id, guest)
    guest.once('destroyed', () => {
      guests!.delete(guest.id)
      const host = this.windows.get(sender.id)
      if (!host) return
      for (const record of [...host.records.values()]) {
        if (record.guest === guest) {
          void this.releaseRecord(host, record).catch(() => { /* Retained for window shutdown retry. */ })
        }
      }
    })
  }

  async registerTab(sender: WebContents, input: { localTabId: string; webContentsId: number; threadId?: string; openRequestId?: string; agentOpened?: boolean }): Promise<{ uiTabId: string }> {
    const localTabId = identifier(input.localTabId)
    const openRequestId = input.openRequestId === undefined ? undefined : identifier(input.openRequestId)
    if (!Number.isSafeInteger(input.webContentsId) || input.webContentsId < 1) invalid('Invalid guest handle')
    const threadId = input.threadId === undefined ? undefined : identifier(input.threadId)
    const guest = this.observed.get(sender.id)?.get(input.webContentsId)
    if (!guest || guest.isDestroyed() || sender.isDestroyed() || guest.hostWebContents !== sender) invalid('Guest has not been attached to this window')
    const binding = this.connection.binding(sender.id)
    if (!binding) invalid('Bind the app window to a profile before using its browser')
    let host = this.windows.get(sender.id)
    if (host && (!sameBinding(binding, host.binding) || host.stopping)) invalid('Previous browser profile is still closing')
    if (!host) { host = this.createWindow(sender, binding); this.windows.set(sender.id, host) }
    let existing = host.records.get(localTabId)
    if (existing && existing.guest !== guest && existing.guest.isDestroyed()) {
      // The window unloaded this tab's last page and is loading it again: the old page's registration ends first.
      await this.releaseRecord(host, existing).catch(() => { /* Retained for window shutdown retry. */ })
      existing = host.records.get(localTabId)
      if (host.stopping || guest.isDestroyed() || this.windows.get(sender.id) !== host) invalid('Browser binding changed during registration')
    }
    if (existing) {
      if (!existing.artifactRoot) invalid('Tab registration is still in progress')
      if (existing.guest !== guest || (existing.threadId && threadId && existing.threadId !== threadId)) invalid('Replaced tab must be released before registration')
      if (threadId) await this.selectTab(sender, localTabId, threadId)
      return { uiTabId: existing.uiTabId }
    }
    if (host.records.size >= 128) invalid('Too many attached tabs in this window')
    const record: Registration = {
      sender, guest, localTabId, uiTabId: randomUUID(), registrationId: randomUUID(), registrationEpoch: 1,
      binding: { ...binding }, threadId, ownerThreadId: threadId ?? null, agentOpened: input.agentOpened === true || openRequestId !== undefined,
      activity: new TabActivity(this.options.activityClock), stopActivity: [],
      closureToken: randomBytes(32).toString('base64url'), pending: new Set(), stopping: false
    }
    const guestHandle = wrapElectronWebContents(guest)
    host.registry.registerGuest({ guest: guestHandle, owner: wrapElectronWebContents(sender),
      profileId: binding.profileId, profileEpoch: String(binding.epoch), uiTabId: record.uiTabId,
      thread: threadId ? { kind: 'thread', threadId } : { kind: 'unbound' } })
    // The person's clicks, wheels and keys in the page and their own navigations: never a script in the page.
    record.stopActivity.push(
      guestHandle.onUserInput?.((kind) => record.activity.noteUserInput('guest', kind)) ?? (() => {}),
      guestHandle.onUserNavigation?.(() => record.activity.noteUserNavigation()) ?? (() => {}),
      record.activity.onChange(() => this.emitActivity(record))
    )
    host.records.set(localTabId, record)
    const operation = (async () => { try {
      const params = {
        registrationId: record.registrationId, registrationEpoch: record.registrationEpoch, uiTabId: record.uiTabId,
        closureToken: record.closureToken, ...(threadId ? { threadId } : {})
      } satisfies BrowserAttachmentRegisterParams
      const result = await this.connection.request<BrowserAttachmentRegisterResult>(sender, 'browser.attachments.register', params)
      if (host.stopping || !sameBinding(this.connection.binding(sender.id), record.binding) || guest.isDestroyed()) invalid('Browser binding changed during registration')
      if (result.registrationId !== record.registrationId || result.registrationEpoch !== record.registrationEpoch ||
          result.uiTabId !== record.uiTabId || result.profileId !== binding.profileId || result.profileEpoch !== binding.epoch ||
          !isAbsolute(result.artifactRoot) || result.closureToken !== record.closureToken) {
        invalid('Daemon returned a mismatched browser registration')
      }
      record.artifactRoot = result.artifactRoot
      // A tab an agent asked for (`browser_tabs` new) is ready for it.
      const pending = openRequestId ? this.pendingOpens.get(openRequestId) : undefined
      if (pending && pending.sender === sender && pending.threadId === threadId) {
        this.pendingOpens.delete(openRequestId!)
        pending.resolve(record.uiTabId)
      }
      return { uiTabId: record.uiTabId }
    } catch (error) {
      record.stopping = true
      this.disposeActivity(record)
      host.registry.revokeUiTab(record.uiTabId)
      // A dispatched registration may exist even if its response was lost. Retain
      // ownership until unregister succeeds, so profile drain can retry cleanup.
      await this.unregisterOrRetain(record)
      if (host.records.get(localTabId) === record) host.records.delete(localTabId)
      throw error
    } })()
    host.pending.add(operation)
    record.pending.add(operation)
    void operation.finally(() => {
      host.pending.delete(operation)
      record.pending.delete(operation)
    }).catch(() => {})
    return operation
  }

  async selectTab(sender: WebContents, localTabId: string, threadId: string): Promise<void> {
    const host = this.windows.get(sender.id), record = host?.records.get(identifier(localTabId))
    if (!host || !record || !record.artifactRoot || host.stopping || record.stopping || !sameBinding(this.connection.binding(sender.id), record.binding)) invalid('Browser tab is unavailable')
    identifier(threadId)
    if (record.threadId && record.threadId !== threadId) invalid('Browser tab belongs to another thread')
    if (record.selectingThread) invalid('Browser tab selection is already in progress')
    record.selectingThread = threadId
    const operation = (async () => {
      await this.connection.request(sender, 'browser.attachments.select', { uiTabId: record.uiTabId, threadId })
      if (host.stopping || record.stopping || host.records.get(localTabId) !== record || !sameBinding(this.connection.binding(sender.id), record.binding)) invalid('Browser binding changed during selection')
      host.registry.assignThread(record.uiTabId, threadId)
      record.threadId = threadId
    })()
    record.pending.add(operation)
    try { await operation } finally {
      record.pending.delete(operation)
      if (record.selectingThread === threadId) record.selectingThread = undefined
    }
  }

  async handleCommand(sender: WebContents, command: AttachedBrowserCommand, signal: AbortSignal): Promise<BrowserWorkerResponse> {
    const denied = (message: string): BrowserWorkerResponse => ({ version: 1, id: command.request.id, ok: false, error: { code: 'policy_denied', message } })
    const host = this.windows.get(sender.id)
    const record = host && [...host.records.values()].find((item) => item.registrationId === command.registrationId)
    if (!host || !record || host.stopping || record.stopping || sender.isDestroyed() || record.guest.isDestroyed()) return denied('Attached browser is unavailable')
    if (command.registrationEpoch !== record.registrationEpoch || command.profileId !== record.binding.profileId || command.profileEpoch !== record.binding.epoch || command.request.profileId !== record.binding.profileId || !sameBinding(this.connection.binding(sender.id), record.binding)) return denied('Stale browser registration')
    const request = command.request
    if (request.method === 'session.open') {
      // Another thread's tab is never opened for an agent, whatever the daemon chose.
      if (record.ownerThreadId !== null && record.ownerThreadId !== request.params.threadId) return denied('Browser tab belongs to another thread')
    } else if (host.sessions.get(String(request.params.sessionId)) !== record) return denied('Browser session belongs to another tab')
    // A daemon-admitted session can claim a registered tab of its thread, or one kept in every thread that no session
    // drives (as its first tab or any other). Native ownership stays here, and a refused open gives the tab back.
    let rebound: { previous: string | undefined } | undefined
    if (request.method === 'session.open' && record.threadId !== request.params.threadId && request.params.uiTabId === record.uiTabId) {
      if ([...host.sessions.values()].includes(record) || host.backend.drivenByAny(record.uiTabId)) {
        return { version: 1, id: request.id, ok: false, error: { code: 'human_controlled', message: 'This browser tab is in use by another agent execution' } }
      }
      const threadId = identifier(request.params.threadId)
      rebound = { previous: record.threadId }
      host.registry.reassignThread(record.uiTabId, threadId)
      record.threadId = threadId
    }
    if (request.method === 'session.open' && (request.params.uiTabId !== record.uiTabId || request.params.threadId !== record.threadId || !record.threadId)) return denied('Browser target or thread does not match the selected tab')
    const operation = this.context.run({ host, record, command }, async () => {
      const response = await host.backend.call(request, { signal, timeoutMs: 60_000 })
      if (!response.ok && rebound && !record.stopping && !host.stopping) {
        // Refused: the tab goes back to the thread that had it.
        if (rebound.previous) host.registry.reassignThread(record.uiTabId, rebound.previous)
        else host.registry.unassignThread(record.uiTabId)
        record.threadId = rebound.previous
      }
      if (response.ok && request.method === 'session.open') {
        const session = (response.result as { session?: { id?: unknown } })?.session
        const id = identifier(session?.id)
        host.sessions.set(id, record)
        if (host.stopping || record.stopping || !sameBinding(this.connection.binding(sender.id), record.binding)) {
          await this.closeBackendSession(host, record, id)
          return denied('Browser binding changed during open')
        }
      } else if (response.ok && request.method === 'session.close') host.sessions.delete(String(request.params.sessionId))
      return response
    })
    record.pending.add(operation)
    try { return await operation } finally { record.pending.delete(operation) }
  }

  /** The person used a tab outside its page: the toolbar, the agent's shield, the address bar or the element picker. */
  reportActivity(sender: WebContents, input: InAppBrowserActivity): void {
    const record = this.windows.get(sender.id)?.records.get(identifier(input.localTabId))
    if (!record || record.stopping) return
    if (input.kind === 'input') record.activity.noteUserInput('window')
    else if (input.pin !== 'address' && input.pin !== 'picker') invalid('Invalid browser activity')
    else if (input.kind === 'pin') record.activity.pin(input.pin)
    else if (input.kind === 'unpin') record.activity.unpin(input.pin)
    else invalid('Invalid browser activity')
  }

  /** The window moved a tab to another thread, or kept it in every thread (`null`). */
  setTabOwner(sender: WebContents, localTabId: string, threadId: string | null): void {
    const host = this.windows.get(sender.id), record = host?.records.get(identifier(localTabId))
    if (!host || !record || record.stopping) return
    const owner = threadId === null ? null : identifier(threadId)
    if (record.ownerThreadId === owner) return
    record.ownerThreadId = owner
    if (owner !== null) {
      // Other threads' agents lose the tab, as when it closes, and a handover hold on it ends.
      host.backend.tabOwnerChanged(record.uiTabId, owner)
      if (record.threadId && record.threadId !== owner) {
        // The sessions that opened on it have ended: the new thread's agent may open it.
        for (const [sessionId, held] of [...host.sessions]) if (held === record) host.sessions.delete(sessionId)
      }
    }
    // The daemon hears it too: the thread that lost the tab asks for a new one, and its ended sessions close.
    if (!record.artifactRoot || sender.isDestroyed() || !sameBinding(this.connection.binding(sender.id), record.binding)) return
    const operation = this.connection.request(sender, 'browser.attachments.owner', {
      uiTabId: record.uiTabId, ...(owner === null ? {} : { threadId: owner })
    } satisfies BrowserAttachmentOwnerParams)
    record.pending.add(operation)
    void operation.catch(() => { /* A tab that closed meanwhile has nothing left to move. */ }).finally(() => record.pending.delete(operation))
  }

  /** **Resume agent**: the person hands a tab back to the agent that asked them to step in. Taking over needs no call. */
  async resumeAgent(sender: WebContents, localTabId: string): Promise<void> {
    const host = this.windows.get(sender.id), record = host?.records.get(identifier(localTabId))
    if (!host || !record?.state?.sessionId || !record.threadId || host.stopping || record.stopping || !sameBinding(this.connection.binding(sender.id), record.binding)) invalid('No active browser session on this tab')
    await this.connection.request(sender, 'browser.sessions.resume', { sessionId: record.state.sessionId, threadId: record.threadId })
  }

  async releaseWindow(sender: WebContents): Promise<void> {
    const host = this.windows.get(sender.id)
    if (!host) return
    if (host.closing) return host.closing
    host.stopping = true
    host.backend.beginShutdown()
    const operation = (async () => {
      for (const record of host.records.values()) {
        record.stopping = true
        this.disposeActivity(record)
        host.registry.revokeUiTab(record.uiTabId)
        this.emitState(record, { owner: 'disconnected' })
      }
      for (const [requestId, pending] of [...this.pendingOpens]) {
        if (pending.sender !== sender) continue
        this.pendingOpens.delete(requestId)
        pending.reject(Object.assign(new Error('The window closed before the new tab was ready'), { code: 'session_closed' }))
      }
      await Promise.allSettled([...host.pending])
      await Promise.allSettled([...host.records.values()].flatMap((record) => [...record.pending]))
      await host.backend.shutdown({ timeoutMs: 30_000 })
      host.registry.clear()
      for (const record of host.records.values()) await this.unregisterOrRetain(record)
      host.records.clear(); host.sessions.clear()
      if (this.windows.get(sender.id) === host) this.windows.delete(sender.id)
    })()
    host.closing = operation
    void operation.catch(() => { if (host.closing === operation) host.closing = undefined })
    return operation
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.windows.values()].map((host) => this.releaseWindow(host.sender)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Attached browser is still closing')
    if (this.orphaned.size) throw new Error('Attached browser closure proofs require a same-profile replacement window connection')
  }

  async acknowledgeClosed(sender: WebContents): Promise<void> {
    const binding = this.connection.binding(sender.id)
    if (!binding || sender.isDestroyed()) invalid('Replacement browser window connection is unavailable')
    for (const [key, orphan] of [...this.orphaned]) {
      if (!sameBinding(binding, orphan.binding)) continue
      await this.connection.request(sender, 'browser.attachments.acknowledgeClosed', {
        registrationId: orphan.registrationId,
        registrationEpoch: orphan.registrationEpoch,
        closureToken: orphan.closureToken
      } satisfies BrowserAttachmentAcknowledgeClosedParams)
      this.orphaned.delete(key)
    }
  }

  private createWindow(sender: WebContents, binding: TrustedProfileBinding): WindowHost {
    const records = new Map<string, Registration>()
    const registry = new TrustedGuestRegistry({ ownerBinding: (input) => {
      const record = [...records.values()].find((item) => item.uiTabId === input.uiTabId)
      return Boolean(record && record.binding.profileId === input.profileId && String(record.binding.epoch) === input.profileEpoch && !record.guest.isDestroyed() && !sender.isDestroyed() && sameBinding(this.connection.binding(sender.id), record.binding))
    } })
    const backend = new ElectronAttachedBrowserBackend({ registry, browserVersion: process.versions.chrome,
      activityFor: (uiTabId) => [...records.values()].find((item) => item.uiTabId === uiTabId)?.activity,
      tabs: this.windowTabs(sender, records, () => host),
      ...(this.options.activityClock ? { activityClock: this.options.activityClock } : {}),
      ...(this.options.conflictBackoffMs ? { conflictBackoffMs: this.options.conflictBackoffMs } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      policy: { authorize: (input) => {
        const owned = this.context.getStore()
        if (!owned || owned.record.sender !== sender || input.profileId !== owned.record.binding.profileId || input.method !== owned.command.request.method || !sameBinding(this.connection.binding(sender.id), owned.record.binding)) return { allowed: false, code: 'policy_denied', message: 'Browser command was not admitted by the daemon' }
        const url = input.url ?? (input.action?.type === 'navigate' ? input.action.url : undefined)
        if (url !== undefined) { try { browserNavigationUrl(url) } catch { return { allowed: false, code: 'policy_denied', message: 'Unsupported navigation URL' } } }
        return { allowed: true }
      } },
      artifacts: { write: async (input) => {
        const fileRoot = this.ownedArtifactRoot(input.profileId, input.sessionId)
        if (input.mediaType !== 'image/png' || input.bytes.byteLength > 16 * 1024 * 1024) invalid('Screenshot exceeds attached browser limits')
        await mkdir(fileRoot, { recursive: true })
        const artifactId = 'art_' + randomUUID()
        const file = assertOwnedPath(fileRoot, join(fileRoot, `${artifactId}.png`), 'attached screenshot')
        await writeFile(file, input.bytes, { flag: 'wx', mode: 0o600 })
        return { artifactId, byteLength: input.bytes.byteLength, sha256: createHash('sha256').update(input.bytes).digest('hex') }
      } },
      journal: { append: async (record) => {
        const fileRoot = this.ownedArtifactRoot(record.profileId, record.sessionId)
        await mkdir(fileRoot, { recursive: true })
        const file = assertOwnedPath(fileRoot, join(fileRoot, 'actions.jsonl'), 'attached action journal')
        await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 })
      } }
    })
    const host: WindowHost = { sender, binding: { ...binding }, registry, backend, records, sessions: new Map(), pending: new Set(), stopping: false }
    backend.onControlStateChange((state) => {
      const record = [...records.values()].find((item) => item.uiTabId === state.uiTabId)
      if (record) { record.state = state; this.emitState(record, state) }
    })
    // The agent cursor is drawn by the window over its tab, never injected into the page.
    backend.onAgentCursor(({ uiTabId, cursor }) => {
      const record = [...records.values()].find((item) => item.uiTabId === uiTabId)
      if (record && !record.sender.isDestroyed() && sameBinding(this.connection.binding(record.sender.id), record.binding)) {
        record.sender.send('browser:agent-cursor', { uiTabId: record.localTabId, profileId: record.binding.profileId, cursor } satisfies InAppBrowserCursor)
      }
    })
    return host
  }

  /** What a window's agents may do with its tabs (`browser_tabs`): only the thread's own and those kept in every thread. */
  private windowTabs(sender: WebContents, records: Map<string, Registration>, host: () => WindowHost): AttachedWindowTabs {
    const live = (record: Registration) => !record.stopping && Boolean(record.artifactRoot) && !record.guest.isDestroyed()
    const byUiTab = (uiTabId: string) => [...records.values()].find((item) => item.uiTabId === uiTabId && live(item))
    return {
      visible: (threadId, ownOnly) => [...records.values()]
        .filter((record) => live(record) && (record.ownerThreadId === threadId || (!ownOnly && record.ownerThreadId === null)))
        .map((record) => record.uiTabId),
      claim: (uiTabId, threadId, ownOnly) => {
        const record = byUiTab(uiTabId)
        if (!record) invalid('Browser tab is unavailable')
        if (record.ownerThreadId !== null && record.ownerThreadId !== threadId) invalid('Browser tab belongs to another thread')
        if (ownOnly && record.ownerThreadId !== threadId) invalid('This run uses only its thread\'s own tabs')
        if (record.threadId === threadId) return
        // A tab kept in every thread is driven by the agent that last took it.
        host().registry.reassignThread(record.uiTabId, identifier(threadId))
        record.threadId = threadId
      },
      open: ({ threadId, activate }, signal) => new Promise<string>((resolve, reject) => {
        if (sender.isDestroyed() || host().stopping) { reject(Object.assign(new Error('The window is closing'), { code: 'session_closed' })); return }
        const requestId = randomUUID()
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = () => { this.pendingOpens.delete(requestId); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
        const onAbort = () => { settle(); reject(Object.assign(new Error('Opening a tab was cancelled'), { code: 'cancelled' })) }
        if (signal?.aborted) { onAbort(); return }
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => { settle(); reject(Object.assign(new Error('The window did not open the tab in time'), { code: 'timeout' })) }, this.options.openTabTimeoutMs ?? 30_000)
        timer.unref?.()
        this.pendingOpens.set(requestId, { sender, threadId, resolve: (uiTabId) => { settle(); resolve(uiTabId) }, reject: (error) => { settle(); reject(error) } })
        sender.send('browser:tab-command', { kind: 'open', requestId, threadId, activate } satisfies InAppBrowserTabCommand)
      }),
      closable: (uiTabId, threadId) => {
        const record = byUiTab(uiTabId)
        return Boolean(record && record.agentOpened && record.ownerThreadId === threadId)
      },
      // Typing in one tab takes the window's keyboard focus from the tab, address bar or picker the person uses.
      personBusyElsewhere: (uiTabId) => [...records.values()].some((record) => record.uiTabId !== uiTabId && live(record) && record.activity.userActive()),
      close: (uiTabId) => {
        const record = byUiTab(uiTabId)
        if (record && !sender.isDestroyed()) sender.send('browser:tab-command', { kind: 'close', localTabId: record.localTabId } satisfies InAppBrowserTabCommand)
      },
      reanchor: (sessionId, uiTabId) => {
        const record = byUiTab(uiTabId)
        if (!record) invalid('Browser tab is unavailable')
        host().sessions.set(identifier(sessionId), record)
      },
      anyUserActive: () => [...records.values()].some((record) => live(record) && record.activity.userActive())
    }
  }

  private emitActivity(record: Registration): void {
    this.emitState(record, { ...(record.state ?? {}), activity: record.activity.state() })
  }

  private disposeActivity(record: Registration): void {
    for (const stop of record.stopActivity.splice(0)) {
      try { stop() } catch { /* already gone */ }
    }
    record.activity.dispose()
  }

  private async closeBackendSession(host: WindowHost, record: Registration, sessionId: string): Promise<void> {
    const request = {
      version: 1 as const,
      id: 'close_' + randomUUID(),
      profileId: record.binding.profileId,
      method: 'session.close' as const,
      params: { sessionId }
    }
    const command: AttachedBrowserCommand = {
      commandId: 'cleanup_' + randomUUID(),
      registrationId: record.registrationId,
      registrationEpoch: record.registrationEpoch,
      profileId: record.binding.profileId,
      profileEpoch: record.binding.epoch,
      request
    }
    const response = await this.context.run({ host, record, command }, () => host.backend.call(request))
    if (!response.ok) invalid(`Attached browser session cleanup failed: ${response.error?.message ?? 'unknown error'}`)
    host.sessions.delete(sessionId)
  }

  private async releaseRecord(host: WindowHost, record: Registration): Promise<void> {
    if (record.closing) return record.closing
    record.stopping = true
    this.disposeActivity(record)
    host.registry.revokeUiTab(record.uiTabId)
    this.emitState(record, { owner: 'disconnected' })
    const operation = (async () => {
      await Promise.allSettled([...record.pending])
      if (host.records.get(record.localTabId) !== record) return
      for (const [sessionId, owner] of [...host.sessions]) {
        if (owner === record) await this.closeBackendSession(host, record, sessionId)
      }
      await this.unregisterOrRetain(record)
      if (host.records.get(record.localTabId) === record) host.records.delete(record.localTabId)
    })()
    record.closing = operation
    void operation.catch(() => { if (record.closing === operation) record.closing = undefined })
    return operation
  }

  private async unregisterOrRetain(record: Registration): Promise<void> {
    if (!record.sender.isDestroyed() && sameBinding(this.connection.binding(record.sender.id), record.binding)) {
      try {
        await this.connection.request(record.sender, 'browser.attachments.unregister', {
          registrationId: record.registrationId,
          registrationEpoch: record.registrationEpoch
        } satisfies BrowserAttachmentUnregisterParams)
        return
      } catch (error) {
        if (sameBinding(this.connection.binding(record.sender.id), record.binding)) throw error
      }
    }
    this.orphaned.set(`${record.registrationId}:${record.registrationEpoch}`, {
      registrationId: record.registrationId,
      registrationEpoch: record.registrationEpoch,
      closureToken: record.closureToken,
      binding: { ...record.binding }
    })
  }

  private ownedArtifactRoot(profileId: string, sessionId: string): string {
    const owned = this.context.getStore()
    if (!owned?.record.artifactRoot || owned.record.binding.profileId !== profileId) invalid('No admitted browser artifact owner')
    identifier(profileId); identifier(sessionId)
    return assertOwnedPath(owned.record.artifactRoot, join(owned.record.artifactRoot, profileId, sessionId), 'attached artifact staging')
  }

  private emitState(record: Registration, state: Partial<AttachedControlState>): void {
    if (!record.sender.isDestroyed() && sameBinding(this.connection.binding(record.sender.id), record.binding)) {
      record.sender.send('browser:automation-state', {
        ...state, uiTabId: record.localTabId, profileId: record.binding.profileId, ...(record.threadId ? { threadId: record.threadId } : {})
      })
    }
  }
}
