import { createHash } from 'node:crypto'
import { OwnedWorkBarrier } from '../../execution/OwnedWorkBarrier'
import type {
  ChatResourceContext, ChatResourceControl, ChatResourceCursor, ChatResourceEvent,
  ChatResourceParticipant, ChatResourcePresence, ChatResourceSnapshot, ChatResourceTarget,
  ChatSharedBrowserAction, ChatSharedFile, ChatSharedFileWriteResult, ChatSharedTerminal, ChatTerminalOutput
} from '../../../shared/chatResources'
import type { BrowserViewerSnapshot } from '../../../shared/browser/viewer'

export interface TrustedChatResourceBinding {
  profileId: string
  groupId: string
  threadId: string
  workspaceRoot: string
  participant: ChatResourceParticipant
}

/** Root-owned adapters must enforce thread/GUI browser authority and workspace leases. */
export interface ChatResourceHost {
  admit(context: ChatResourceContext): Promise<TrustedChatResourceBinding> | TrustedChatResourceBinding
  browser: {
    list(binding: TrustedChatResourceBinding): Promise<BrowserViewerSnapshot[]>
    open(binding: TrustedChatResourceBinding, url: string): Promise<BrowserViewerSnapshot>
    observe(binding: TrustedChatResourceBinding, sessionId: string, tabId?: string): Promise<BrowserViewerSnapshot>
    control(binding: TrustedChatResourceBinding, sessionId: string, owner: 'human' | 'agent'): Promise<BrowserViewerSnapshot>
    action(binding: TrustedChatResourceBinding, action: ChatSharedBrowserAction): Promise<BrowserViewerSnapshot>
    close(binding: TrustedChatResourceBinding, sessionId: string): Promise<void>
  }
  terminal: {
    list(binding: TrustedChatResourceBinding): Promise<ChatSharedTerminal[]>
    create(binding: TrustedChatResourceBinding, columns: number, rows: number): Promise<ChatSharedTerminal>
    output(binding: TrustedChatResourceBinding, terminalId: string, afterSequence: number): Promise<ChatTerminalOutput>
    write(binding: TrustedChatResourceBinding, terminalId: string, data: string): Promise<void>
    resize(binding: TrustedChatResourceBinding, terminalId: string, columns: number, rows: number): Promise<void>
    close(binding: TrustedChatResourceBinding, terminalId: string): Promise<void>
  }
  file: {
    read(binding: TrustedChatResourceBinding, path: string): Promise<string>
    /** Compare and write while holding the existing workspace writer lease. */
    write(binding: TrustedChatResourceBinding, path: string, content: string, expectedRevision: string): Promise<ChatSharedFileWriteResult>
  }
}

interface GroupResources {
  profileId: string
  groupId: string
  threadId: string
  workspaceRoot: string
  browsers: Map<string, BrowserViewerSnapshot>
  terminals: Map<string, ChatSharedTerminal>
  files: Map<string, ChatSharedFile>
  presence: Map<string, ChatResourcePresence>
  browserControls: Map<string, ChatResourceControl>
  terminalControls: Map<string, ChatResourceControl>
  sequence: number
}

export class ChatResourceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ChatResourceError' }
}

export function chatFileRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function normalizeChatResourcePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\r\n]/.test(path) || /^[\\/]|^[a-z]:/i.test(path)) throw new ChatResourceError('invalid_params', 'Choose a relative workspace file')
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new ChatResourceError('invalid_params', 'File path is outside the group workspace')
  return parts.join('/')
}

/** One authority broker per profile, shared by every GUI client and group agent. */
export class ChatResourceService {
  private readonly lifecycle = new OwnedWorkBarrier()
  private readonly groups = new Map<string, GroupResources>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: ChatResourceEvent) => void>()
  private readonly now: () => number
  private readonly presenceTtlMs: number
  private readonly controlTtlMs: number
  private readonly timer: ReturnType<typeof setInterval>
  private stopped = false

  constructor(readonly profileId: string, private readonly host: ChatResourceHost, options: {
    now?: () => number; presenceTtlMs?: number; controlTtlMs?: number
  } = {}) {
    this.now = options.now ?? Date.now
    this.presenceTtlMs = Math.max(1000, Math.min(60_000, options.presenceTtlMs ?? 15_000))
    this.controlTtlMs = Math.max(1000, Math.min(120_000, options.controlTtlMs ?? 30_000))
    this.timer = setInterval(() => this.prune(), 1000)
    this.timer.unref()
  }

  subscribe(listener: (event: ChatResourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async snapshot(context: ChatResourceContext): Promise<ChatResourceSnapshot> {
    return this.lifecycle.run('chat-resource:snapshot', () => this.snapshotOwned(context))
  }

  async presenceUpdate(context: ChatResourceContext, target: ChatResourceTarget, cursor?: ChatResourceCursor): Promise<ChatResourcePresence[]> {
    return this.lifecycle.run('chat-resource:presenceUpdate', () => this.presenceUpdateOwned(context, target, cursor))
  }

  async presenceLeave(context: ChatResourceContext): Promise<void> {
    return this.lifecycle.run('chat-resource:presenceLeave', () => this.presenceLeaveOwned(context))
  }

  async browserOpen(context: ChatResourceContext, url: string): Promise<BrowserViewerSnapshot> {
    return this.lifecycle.run('chat-resource:browserOpen', () => this.browserOpenOwned(context, url))
  }

  async browserObserve(context: ChatResourceContext, sessionId: string, tabId?: string): Promise<BrowserViewerSnapshot> {
    return this.lifecycle.run('chat-resource:browserObserve', () => this.browserObserveOwned(context, sessionId, tabId))
  }

  async browserControl(context: ChatResourceContext, sessionId: string, acquire: boolean): Promise<BrowserViewerSnapshot> {
    return this.lifecycle.run('chat-resource:browserControl', () => this.browserControlOwned(context, sessionId, acquire))
  }

  async browserAction(context: ChatResourceContext, action: ChatSharedBrowserAction): Promise<BrowserViewerSnapshot> {
    return this.lifecycle.run('chat-resource:browserAction', () => this.browserActionOwned(context, action))
  }

  async browserClose(context: ChatResourceContext, sessionId: string): Promise<void> {
    return this.lifecycle.run('chat-resource:browserClose', () => this.browserCloseOwned(context, sessionId))
  }

  async terminalCreate(context: ChatResourceContext, columns = 100, rows = 30): Promise<ChatSharedTerminal> {
    return this.lifecycle.run('chat-resource:terminalCreate', () => this.terminalCreateOwned(context, columns, rows))
  }

  async terminalOutput(context: ChatResourceContext, terminalId: string, afterSequence = 0): Promise<ChatTerminalOutput> {
    return this.lifecycle.run('chat-resource:terminalOutput', () => this.terminalOutputOwned(context, terminalId, afterSequence))
  }

  async terminalControl(context: ChatResourceContext, terminalId: string, acquire: boolean): Promise<ChatSharedTerminal> {
    return this.lifecycle.run('chat-resource:terminalControl', () => this.terminalControlOwned(context, terminalId, acquire))
  }

  async terminalWrite(context: ChatResourceContext, terminalId: string, data: string): Promise<void> {
    return this.lifecycle.run('chat-resource:terminalWrite', () => this.terminalWriteOwned(context, terminalId, data))
  }

  async terminalResize(context: ChatResourceContext, terminalId: string, columns: number, rows: number): Promise<void> {
    return this.lifecycle.run('chat-resource:terminalResize', () => this.terminalResizeOwned(context, terminalId, columns, rows))
  }

  async terminalClose(context: ChatResourceContext, terminalId: string): Promise<void> {
    return this.lifecycle.run('chat-resource:terminalClose', () => this.terminalCloseOwned(context, terminalId))
  }

  async fileRead(context: ChatResourceContext, path: string): Promise<ChatSharedFile> {
    return this.lifecycle.run('chat-resource:fileRead', () => this.fileReadOwned(context, path))
  }

  async fileWrite(context: ChatResourceContext, path: string, content: string, expectedRevision: string): Promise<ChatSharedFileWriteResult> {
    return this.lifecycle.run('chat-resource:fileWrite', () => this.fileWriteOwned(context, path, content, expectedRevision))
  }

  private async snapshotOwned(context: ChatResourceContext): Promise<ChatResourceSnapshot> {
    const { binding, group } = await this.admit(context)
    await this.refresh(group, binding)
    this.pruneGroup(group)
    return { profileId: this.profileId, groupId: group.groupId, threadId: binding.threadId, viewerClientId: context.clientId,
      browsers: structuredClone([...group.browsers.values()]),
      browserControls: structuredClone(Object.fromEntries(group.browserControls)),
      terminals: [...group.terminals.values()].map((item) => ({ ...item, control: group.terminalControls.get(item.id) })),
      files: structuredClone([...group.files.values()]), presence: structuredClone([...group.presence.values()]), sequence: group.sequence }
  }

  private async presenceUpdateOwned(context: ChatResourceContext, target: ChatResourceTarget, cursor?: ChatResourceCursor): Promise<ChatResourcePresence[]> {
    const { binding, group } = await this.admit(context)
    await this.requireResource(group, binding, target)
    this.validateCursor(group, target, cursor)
    this.pruneGroup(group)
    const key = `${context.clientId}\0${target.kind}\0${target.id}`
    if (!group.presence.has(key) && group.presence.size >= 256) throw new ChatResourceError('resource_limit', 'Group presence is full')
    const now = this.now()
    group.presence.set(key, { clientId: context.clientId, participant: structuredClone(binding.participant),
      target: { ...target }, ...(cursor ? { cursor: { ...cursor } } : {}), updatedAt: now, expiresAt: now + this.presenceTtlMs })
    const controls = target.kind === 'browser' ? group.browserControls : target.kind === 'terminal' ? group.terminalControls : undefined
    const control = controls?.get(target.id)
    if (control?.clientId === context.clientId && control.participantId === context.participantId) control.expiresAt = now + this.controlTtlMs
    this.emit(group, 'presence', target.id)
    return structuredClone([...group.presence.values()])
  }

  private async presenceLeaveOwned(context: ChatResourceContext): Promise<void> {
    const { group } = await this.admit(context)
    this.leaveClient(group, context.clientId)
  }

  disconnect(clientId: string): void {
    for (const group of this.groups.values()) this.leaveClient(group, clientId)
  }

  private async browserOpenOwned(context: ChatResourceContext, url: string): Promise<BrowserViewerSnapshot> {
    return this.withLock(`${context.groupId}:browser`, async () => {
      const { binding, group } = await this.admit(context)
      await this.refreshBrowsers(group, binding)
      if (group.browsers.size >= 16) throw new ChatResourceError('resource_limit', 'Group browser limit reached')
      if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//i.test(url)) throw new ChatResourceError('invalid_params', 'Choose an HTTP or HTTPS browser URL')
      const snapshot = await this.host.browser.open(binding, url)
      this.storeBrowser(group, snapshot)
      this.emit(group, 'browser', snapshot.session!.id)
      return snapshot
    })
  }

  private async browserObserveOwned(context: ChatResourceContext, sessionId: string, tabId?: string): Promise<BrowserViewerSnapshot> {
    const { binding, group } = await this.admit(context)
    await this.requireResource(group, binding, { kind: 'browser', id: sessionId })
    const result = await this.host.browser.observe(binding, sessionId, tabId)
    this.storeBrowser(group, result)
    this.emit(group, 'browser', sessionId)
    return result
  }

  private async browserControlOwned(context: ChatResourceContext, sessionId: string, acquire: boolean): Promise<BrowserViewerSnapshot> {
    return this.withLock(`${context.groupId}:browser:${sessionId}`, async () => {
      const { binding, group } = await this.admit(context)
      await this.requireResource(group, binding, { kind: 'browser', id: sessionId })
      this.pruneGroup(group)
      this.assertControl(group.browserControls, sessionId, context, !acquire)
      const snapshot = await this.host.browser.control(binding, sessionId, acquire ? 'human' : 'agent')
      this.storeBrowser(group, snapshot)
      if (acquire) group.browserControls.set(sessionId, this.control(context))
      else group.browserControls.delete(sessionId)
      this.emit(group, 'browser', sessionId)
      return snapshot
    })
  }

  private async browserActionOwned(context: ChatResourceContext, action: ChatSharedBrowserAction): Promise<BrowserViewerSnapshot> {
    return this.withLock(`${context.groupId}:browser:${action.sessionId}`, async () => {
      const { binding, group } = await this.admit(context)
      await this.requireResource(group, binding, { kind: 'browser', id: action.sessionId })
      this.pruneGroup(group)
      this.assertControl(group.browserControls, action.sessionId, context, true)
      const snapshot = await this.host.browser.action(binding, action)
      this.storeBrowser(group, snapshot)
      group.browserControls.set(action.sessionId, this.control(context))
      this.emit(group, 'browser', action.sessionId)
      return snapshot
    })
  }

  private async browserCloseOwned(context: ChatResourceContext, sessionId: string): Promise<void> {
    return this.withLock(`${context.groupId}:browser:${sessionId}`, async () => {
      const { binding, group } = await this.admit(context)
      await this.requireResource(group, binding, { kind: 'browser', id: sessionId })
      this.pruneGroup(group)
      this.assertControl(group.browserControls, sessionId, context, false)
      await this.host.browser.close(binding, sessionId)
      group.browsers.delete(sessionId); group.browserControls.delete(sessionId)
      this.removeResourcePresence(group, 'browser', sessionId)
      this.emit(group, 'browser', sessionId)
    })
  }

  private async terminalCreateOwned(context: ChatResourceContext, columns = 100, rows = 30): Promise<ChatSharedTerminal> {
    this.validateDimensions(columns, rows)
    return this.withLock(`${context.groupId}:terminal`, async () => {
      const { binding, group } = await this.admit(context)
      await this.refreshTerminals(group, binding)
      if (group.terminals.size >= 16) throw new ChatResourceError('resource_limit', 'Group terminal limit reached')
      const terminal = await this.host.terminal.create(binding, columns, rows)
      this.storeTerminal(group, terminal)
      group.terminalControls.set(terminal.id, this.control(context))
      this.emit(group, 'terminal', terminal.id)
      return { ...terminal, control: group.terminalControls.get(terminal.id) }
    })
  }

  private async terminalOutputOwned(context: ChatResourceContext, terminalId: string, afterSequence = 0): Promise<ChatTerminalOutput> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ChatResourceError('invalid_params', 'Invalid terminal output sequence')
    const { binding, group } = await this.admit(context)
    await this.requireResource(group, binding, { kind: 'terminal', id: terminalId })
    return this.host.terminal.output(binding, terminalId, afterSequence)
  }

  private async terminalControlOwned(context: ChatResourceContext, terminalId: string, acquire: boolean): Promise<ChatSharedTerminal> {
    return this.withLock(`${context.groupId}:terminal:${terminalId}`, async () => {
      const { binding, group } = await this.admit(context)
      await this.requireResource(group, binding, { kind: 'terminal', id: terminalId })
      this.pruneGroup(group)
      this.assertControl(group.terminalControls, terminalId, context, !acquire)
      if (acquire) group.terminalControls.set(terminalId, this.control(context))
      else group.terminalControls.delete(terminalId)
      this.emit(group, 'terminal', terminalId)
      return { ...group.terminals.get(terminalId)!, control: group.terminalControls.get(terminalId) }
    })
  }

  private async terminalWriteOwned(context: ChatResourceContext, terminalId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || data.length > 256_000) throw new ChatResourceError('invalid_params', 'Terminal input exceeds its bound')
    await this.terminalMutation(context, terminalId, (binding) => this.host.terminal.write(binding, terminalId, data))
  }

  private async terminalResizeOwned(context: ChatResourceContext, terminalId: string, columns: number, rows: number): Promise<void> {
    this.validateDimensions(columns, rows)
    await this.terminalMutation(context, terminalId, (binding) => this.host.terminal.resize(binding, terminalId, columns, rows), (group) => {
      const terminal = group.terminals.get(terminalId)!
      terminal.columns = columns; terminal.rows = rows
    })
  }

  private async terminalCloseOwned(context: ChatResourceContext, terminalId: string): Promise<void> {
    await this.terminalMutation(context, terminalId, (binding) => this.host.terminal.close(binding, terminalId), (group) => {
      group.terminals.delete(terminalId); group.terminalControls.delete(terminalId)
      this.removeResourcePresence(group, 'terminal', terminalId)
    })
  }

  private async fileReadOwned(context: ChatResourceContext, path: string): Promise<ChatSharedFile> {
    path = normalizeChatResourcePath(path)
    return this.withLock(`${context.groupId}:file:${path}`, async () => {
      const { binding, group } = await this.admit(context)
      const content = await this.host.file.read(binding, path)
      this.assertContent(content)
      if (!group.files.has(path) && group.files.size >= 32) throw new ChatResourceError('resource_limit', 'Group file limit reached')
      const file = { path, content, revision: chatFileRevision(content) }
      const previous = group.files.get(path)
      group.files.set(path, file)
      if (previous && previous.revision !== file.revision) this.emit(group, 'file', path)
      return { ...file }
    })
  }

  private async fileWriteOwned(context: ChatResourceContext, path: string, content: string, expectedRevision: string): Promise<ChatSharedFileWriteResult> {
    path = normalizeChatResourcePath(path)
    this.assertContent(content)
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new ChatResourceError('invalid_params', 'A current file revision is required')
    return this.withLock(`${context.groupId}:file:${path}`, async () => {
      const { binding, group } = await this.admit(context)
      if (!group.files.has(path) && group.files.size >= 32) throw new ChatResourceError('resource_limit', 'Group file limit reached')
      const result = await this.host.file.write(binding, path, content, expectedRevision)
      this.assertContent(result.file.content)
      if (result.file.path !== path || result.file.revision !== chatFileRevision(result.file.content)) throw new ChatResourceError('invalid_host_result', 'Shared file result does not match its document')
      group.files.set(path, { ...result.file })
      this.emit(group, 'file', path)
      return result
    })
  }

  prune(): void { for (const group of this.groups.values()) this.pruneGroup(group) }

  getActiveCount(): number { return this.lifecycle.count }

  beginShutdown(): void {
    this.stopped = true
    this.lifecycle.beginShutdown()
    clearInterval(this.timer)
  }

  async dispose(): Promise<void> {
    this.beginShutdown()
    await this.lifecycle.waitForIdle()
    this.listeners.clear(); this.groups.clear()
  }

  private async admit(context: ChatResourceContext): Promise<{ binding: TrustedChatResourceBinding; group: GroupResources }> {
    if (this.stopped) throw new ChatResourceError('service_unavailable', 'Shared resources are closed')
    for (const value of [context.profileId, context.groupId, context.clientId, context.participantId]) if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) throw new ChatResourceError('invalid_params', 'Invalid resource context')
    if (context.profileId !== this.profileId) throw new ChatResourceError('profile_mismatch', 'Resources belong to another profile')
    const binding = await this.host.admit(context)
    if (binding.profileId !== this.profileId || binding.groupId !== context.groupId || binding.participant.id !== context.participantId || !binding.threadId || !binding.workspaceRoot) throw new ChatResourceError('membership_required', 'Group resource admission failed')
    let group = this.groups.get(context.groupId)
    if (group && (group.threadId !== binding.threadId || group.workspaceRoot !== binding.workspaceRoot)) throw new ChatResourceError('resource_binding_changed', 'Group workspace changed; reopen its resources')
    if (!group) {
      if (this.groups.size >= 256) throw new ChatResourceError('resource_limit', 'Shared group limit reached')
      group = { profileId: this.profileId, groupId: context.groupId, threadId: binding.threadId, workspaceRoot: binding.workspaceRoot,
        browsers: new Map(), terminals: new Map(), files: new Map(), presence: new Map(), browserControls: new Map(), terminalControls: new Map(), sequence: 0 }
      this.groups.set(context.groupId, group)
    }
    return { binding, group }
  }

  private async refresh(group: GroupResources, binding: TrustedChatResourceBinding): Promise<void> {
    await Promise.all([this.refreshBrowsers(group, binding), this.refreshTerminals(group, binding), this.refreshFiles(group, binding)])
  }

  private async refreshFiles(group: GroupResources, binding: TrustedChatResourceBinding): Promise<void> {
    await Promise.all([...group.files.keys()].map((path) => this.withLock(`${group.groupId}:file:${path}`, async () => {
      try {
        const content = await this.host.file.read(binding, path)
        this.assertContent(content)
        const revision = chatFileRevision(content)
        if (group.files.get(path)?.revision !== revision) {
          group.files.set(path, { path, content, revision })
          for (const presence of group.presence.values()) if (presence.target.kind === 'file' && presence.target.id === path && presence.cursor?.kind === 'file' && presence.cursor.revision !== revision) delete presence.cursor
          this.emit(group, 'file', path)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        group.files.delete(path)
        this.removeResourcePresence(group, 'file', path)
        this.emit(group, 'file', path)
      }
    })))
  }

  private async refreshBrowsers(group: GroupResources, binding: TrustedChatResourceBinding): Promise<void> {
    const snapshots = await this.host.browser.list(binding)
    if (snapshots.length > 16) throw new ChatResourceError('resource_limit', 'Group browser limit exceeded')
    const next = new Map<string, BrowserViewerSnapshot>()
    for (const snapshot of snapshots) { this.assertBrowser(group, snapshot); if (snapshot.session?.lifecycle !== 'closed') next.set(snapshot.session!.id, snapshot) }
    group.browsers = next
  }

  private async refreshTerminals(group: GroupResources, binding: TrustedChatResourceBinding): Promise<void> {
    const terminals = await this.host.terminal.list(binding)
    if (terminals.length > 16) throw new ChatResourceError('resource_limit', 'Group terminal limit exceeded')
    const next = new Map<string, ChatSharedTerminal>()
    for (const terminal of terminals) { this.assertTerminal(group, terminal); if (terminal.alive) next.set(terminal.id, terminal) }
    group.terminals = next
  }

  private async requireResource(group: GroupResources, binding: TrustedChatResourceBinding, target: ChatResourceTarget): Promise<void> {
    if (!target || !['browser', 'terminal', 'file'].includes(target.kind) || typeof target.id !== 'string' || !target.id) throw new ChatResourceError('invalid_params', 'Invalid shared resource')
    if (target.kind === 'browser') { await this.refreshBrowsers(group, binding); if (group.browsers.has(target.id)) return }
    if (target.kind === 'terminal') { await this.refreshTerminals(group, binding); if (group.terminals.has(target.id)) return }
    if (target.kind === 'file') { normalizeChatResourcePath(target.id); if (group.files.has(target.id)) return }
    throw new ChatResourceError('resource_not_found', 'Resource does not belong to this group')
  }

  private assertBrowser(group: GroupResources, snapshot: BrowserViewerSnapshot): void {
    if (!snapshot.session || snapshot.session.profileId !== group.profileId || snapshot.session.threadId !== group.threadId || snapshot.session.backend !== 'managed-chromium') throw new ChatResourceError('resource_owner_mismatch', 'Browser does not belong to the group managed workspace')
  }

  private storeBrowser(group: GroupResources, snapshot: BrowserViewerSnapshot): void { this.assertBrowser(group, snapshot); group.browsers.set(snapshot.session!.id, structuredClone(snapshot)) }
  private assertTerminal(group: GroupResources, terminal: ChatSharedTerminal): void {
    if (!terminal.id || terminal.threadId !== group.threadId) throw new ChatResourceError('resource_owner_mismatch', 'Terminal does not belong to this group')
  }
  private storeTerminal(group: GroupResources, terminal: ChatSharedTerminal): void { this.assertTerminal(group, terminal); group.terminals.set(terminal.id, { ...terminal }) }

  private validateCursor(group: GroupResources, target: ChatResourceTarget, cursor?: ChatResourceCursor): void {
    if (!cursor) return
    if (cursor.kind !== target.kind) throw new ChatResourceError('invalid_params', 'Cursor does not match the resource')
    if (cursor.kind === 'browser') {
      const observation = group.browsers.get(target.id)?.observation
      if (!observation || cursor.generation !== observation.generation || cursor.tabId !== observation.tabId || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) || cursor.x < 0 || cursor.y < 0 || cursor.x > observation.viewport.cssWidth || cursor.y > observation.viewport.cssHeight) throw new ChatResourceError('stale_cursor', 'Browser cursor belongs to an obsolete viewport')
    } else if (cursor.kind === 'terminal') {
      const terminal = group.terminals.get(target.id)!
      if (!Number.isInteger(cursor.column) || !Number.isInteger(cursor.row) || cursor.column < 0 || cursor.row < 0 || cursor.column >= terminal.columns || cursor.row >= terminal.rows) throw new ChatResourceError('invalid_params', 'Terminal cursor is outside its viewport')
    } else {
      const file = group.files.get(target.id)!
      if (cursor.revision !== file.revision) throw new ChatResourceError('stale_cursor', 'File cursor belongs to an obsolete revision')
      const lines = file.content.split('\n')
      for (const [line, column] of [[cursor.line, cursor.column], [cursor.endLine ?? cursor.line, cursor.endColumn ?? cursor.column]]) if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || line > lines.length || column < 1 || column > lines[line - 1].replace(/\r$/, '').length + 1) throw new ChatResourceError('invalid_params', 'File selection is outside its document')
    }
  }

  private assertContent(content: string): void {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 512 * 1024 || content.includes('\0')) throw new ChatResourceError('invalid_params', 'Shared text file exceeds its bound or contains binary data')
  }
  private validateDimensions(columns: number, rows: number): void {
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 2 || columns > 500 || rows < 2 || rows > 300) throw new ChatResourceError('invalid_params', 'Invalid terminal dimensions')
  }
  private control(context: ChatResourceContext): ChatResourceControl { return { clientId: context.clientId, participantId: context.participantId, expiresAt: this.now() + this.controlTtlMs } }
  private assertControl(controls: Map<string, ChatResourceControl>, id: string, context: ChatResourceContext, required: boolean): void {
    const control = controls.get(id)
    if (control && (control.clientId !== context.clientId || control.participantId !== context.participantId)) throw new ChatResourceError('control_busy', 'Another participant is controlling this resource')
    if (required && !control) throw new ChatResourceError('control_required', 'Take control before changing this resource')
  }
  private async terminalMutation(context: ChatResourceContext, terminalId: string, mutation: (binding: TrustedChatResourceBinding) => Promise<void>, update?: (group: GroupResources) => void): Promise<void> {
    await this.withLock(`${context.groupId}:terminal:${terminalId}`, async () => {
      const { binding, group } = await this.admit(context)
      await this.requireResource(group, binding, { kind: 'terminal', id: terminalId })
      this.pruneGroup(group); this.assertControl(group.terminalControls, terminalId, context, true)
      await mutation(binding)
      group.terminalControls.set(terminalId, this.control(context))
      update?.(group)
      this.emit(group, 'terminal', terminalId)
    })
  }
  private removeResourcePresence(group: GroupResources, kind: ChatResourceTarget['kind'], id: string): void {
    for (const [key, presence] of group.presence) if (presence.target.kind === kind && presence.target.id === id) group.presence.delete(key)
  }
  private leaveClient(group: GroupResources, clientId: string): void {
    let changed = false
    for (const [key, presence] of group.presence) if (presence.clientId === clientId) { group.presence.delete(key); changed = true }
    for (const controls of [group.browserControls, group.terminalControls]) for (const [id, control] of controls) if (control.clientId === clientId) { controls.delete(id); changed = true }
    if (changed) this.emit(group, 'presence')
  }
  private pruneGroup(group: GroupResources): void {
    const now = this.now(); let changed = false
    for (const [key, presence] of group.presence) {
      const target = presence.target
      const exists = target.kind === 'browser' ? group.browsers.has(target.id) : target.kind === 'terminal' ? group.terminals.has(target.id) : group.files.has(target.id)
      if (presence.expiresAt <= now || !exists) { group.presence.delete(key); changed = true; continue }
      const cursor = presence.cursor
      if (cursor?.kind === 'file' && cursor.revision !== group.files.get(target.id)?.revision
        || cursor?.kind === 'browser' && (cursor.generation !== group.browsers.get(target.id)?.observation?.generation || cursor.tabId !== group.browsers.get(target.id)?.observation?.tabId)) {
        delete presence.cursor; changed = true
      }
    }
    for (const [controls, resources] of [[group.browserControls, group.browsers], [group.terminalControls, group.terminals]] as const) for (const [id, control] of controls) if (control.expiresAt <= now || !resources.has(id)) { controls.delete(id); changed = true }
    if (changed) this.emit(group, 'presence')
  }
  private emit(group: GroupResources, kind: ChatResourceEvent['kind'], resourceId?: string): void {
    const event: ChatResourceEvent = { profileId: this.profileId, groupId: group.groupId, sequence: ++group.sequence, kind, ...(resourceId ? { resourceId } : {}) }
    for (const listener of this.listeners) { try { listener(event) } catch { /* A disconnected viewer does not roll back a completed mutation. */ } }
  }
  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.locks.set(key, tail)
    await previous
    try { return await run() }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key) }
  }
}
