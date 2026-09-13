/**
 * Production Electron-side MMS client lifecycle.
 * Discovers/spawns the standalone daemon, connects via LocalMmsClient, reconnects
 * with bounded backoff, and never exposes the owner token outside main.
 *
 * Electron does not acquire MMS ownership.
 */

import { spawn, type ChildProcess } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'
import { EventEmitter } from 'events'
import type { WebContents } from 'electron'
import type { AttachedBrowserCommand, AttachedBrowserCommandHandler } from '../../mms/protocol/connectionCommands'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../../shared/browser/connectionCommands'
import { BROWSER_VIEWER_CAPABILITY } from '../../shared/browser/host'
import { BROWSER_SETUP_CAPABILITY } from '../../shared/browser/setup'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { resolveDaemonHostInvocation } from '../../cli/daemonHost'
import {
  canonicalizeHome,
  pollUntilRuntimeReady,
  resolveRuntimeStatus,
  SERVICE_POLL_INTERVAL_MS,
  SERVICE_START_TIMEOUT_MS,
  type MmsRuntimeRecord
} from '../../cli/mmsRuntime'
import {
  formatOwnerBusyMessage,
  readOwnerRecord,
  resolveOwnerStatus,
  type MmsOwnerRecord
} from '../../mms/ownership/MmsOwnerLease'
import { LocalMmsClient } from '../../mms/protocol/client'
import { MMS_PROTOCOL_VERSION, type ProtocolEvent, type ProtocolHelloOk } from '../../mms/protocol/types'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import { AGENT_DEFINITION_CAPABILITY } from '../../shared/agentPlatform'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../../shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY } from '../../shared/workflowRunPlatform'
import { INTEGRATION_CAPABILITY } from '../../shared/integrationPlatform'
import type { TrustedProfileBinding } from '../../mms/protocol/domainRegistry'
import { resolveLocalEndpoint } from '../../mms/protocol/endpoint'
import type {
  ControlStatus,
  CreatePairingResult,
  PairingGrant,
  RemoteScope
} from '../../shared/controlTypes'

export type GuiMmsConnectionState =
  | 'idle'
  | 'starting_daemon'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'stopped'

/** Unsigned cold starts can be delayed by first-run antivirus inspection on Windows. */
export const GUI_DAEMON_START_TIMEOUT_MS = 90_000

export interface GuiMmsControllerOptions {
  homeDir?: string
  /** When true, never spawn a daemon (tests / externally managed). */
  disableAutoStart?: boolean
  /**
   * Wait for an external daemon instead of spawning one.
   * Set by `scripts/dev.mjs` via MOUSSE_DEV_MANAGED_DAEMON=1 so npm run dev owns MMS.
   */
  managedDaemon?: boolean
  /** Inject endpoint for tests. */
  endpointOverride?: string
  /** Inject owner token for tests (never from renderer). */
  ownerTokenOverride?: string
  /** Max reconnect attempts before failed state. */
  maxReconnectAttempts?: number
  /** Base reconnect backoff ms. */
  reconnectBaseMs?: number
  requestTimeoutMs?: number
}

export interface ThreadSnapshotResult {
  thread: unknown
  messages: unknown[]
  queue: unknown[]
  claimed: unknown[]
  agents?: unknown[]
  tasks?: unknown[]
  ptys?: unknown[]
  pendingQuestions?: Array<{ requestId: string; questions: unknown }>
  activity?: string
  activeTurn: { active: boolean; running: boolean }
  connectionFailed: boolean
  revision: number
}

/**
 * Manages the GUI's LocalMmsClient against the daemon owner/runtime.
 * Emits: state, event, window-event, resnapshot, window-resnapshot, error
 */
interface WindowSession {
  sender: WebContents
  client: LocalMmsClient
  binding: TrustedProfileBinding | null
  closing?: Promise<void>
}

export interface GuiAttachedBrowserHost {
  handleCommand(sender: WebContents, command: AttachedBrowserCommand, signal: AbortSignal): Promise<Awaited<ReturnType<AttachedBrowserCommandHandler>>>
  releaseWindow(sender: WebContents): Promise<void>
  acknowledgeClosed(sender: WebContents): Promise<void>
  shutdown(): Promise<void>
}

const GUI_PLATFORM_CAPABILITIES = [
  PROFILES_V1_CAPABILITY,
  AGENT_DEFINITION_CAPABILITY,
  WORKFLOW_DEFINITIONS_CAPABILITY,
  WORKFLOW_RUN_CAPABILITY,
  INTEGRATION_CAPABILITY,
  BROWSER_VIEWER_CAPABILITY,
  BROWSER_SETUP_CAPABILITY
] as const

export class GuiMmsController extends EventEmitter {
  readonly homeDir: string
  private client: LocalMmsClient | null = null
  private readonly senderAls = new AsyncLocalStorage<WebContents>()
  private readonly windowSessions = new Map<number, WindowSession>()
  private readonly windowSessionOpenings = new Map<number, Promise<WindowSession>>()
  private attachedBrowserHost?: GuiAttachedBrowserHost
  private readonly windowEventUnsubs = new Map<number, () => void>()
  private baseBinding: TrustedProfileBinding | null = null
  private state: GuiMmsConnectionState = 'idle'
  private quitting = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private eventUnsub: (() => void) | null = null
  private disconnectTimer: ReturnType<typeof setInterval> | null = null
  private lastHello: ProtocolHelloOk | null = null
  private startedDaemon: ChildProcess | null = null
  private readonly maxReconnect: number
  private readonly reconnectBaseMs: number
  private readonly disableAutoStart: boolean
  /** External process owns the daemon (dev script); wait/reconnect, never spawn. */
  private readonly managedDaemon: boolean
  private readonly endpointOverride?: string
  private readonly ownerTokenOverride?: string
  private readonly requestTimeoutMs?: number

  constructor(opts: GuiMmsControllerOptions = {}) {
    super()
    this.homeDir = canonicalizeHome(
      opts.homeDir ?? process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
    )
    const managedEnv =
      process.env.MOUSSE_DEV_MANAGED_DAEMON === '1' ||
      process.env.MOUSSE_DEV_MANAGED_DAEMON === 'true'
    this.managedDaemon = opts.managedDaemon === true || managedEnv
    this.disableAutoStart = opts.disableAutoStart === true || this.managedDaemon
    this.endpointOverride = opts.endpointOverride
    this.ownerTokenOverride = opts.ownerTokenOverride
    this.maxReconnect = opts.maxReconnectAttempts ?? 12
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500
    this.requestTimeoutMs = opts.requestTimeoutMs
  }

  get connectionState(): GuiMmsConnectionState {
    return this.state
  }

  get connected(): boolean {
    return this.state === 'ready' && Boolean(this.client?.connected)
  }

  get hello(): ProtocolHelloOk | null {
    return this.lastHello
  }

  get requiresResnapshot(): boolean {
    return this.client?.requiresResnapshot ?? false
  }

  /** Owner token stays in main only — never return this to renderer. */
  private resolveOwnerToken(): string {
    if (this.ownerTokenOverride) return this.ownerTokenOverride
    const owner = readOwnerRecord(this.homeDir)
    if (!owner?.token) {
      throw new Error('MMS owner token unavailable; daemon is not ready')
    }
    return owner.token
  }

  private resolveEndpoint(owner: MmsOwnerRecord | null): string {
    if (this.endpointOverride) return this.endpointOverride
    if (owner?.endpoint) return owner.endpoint
    return resolveLocalEndpoint(this.homeDir).path
  }

  private setState(next: GuiMmsConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.emit('state', next)
  }

  /**
   * Ensure daemon is ready and connect. Starts daemon when absent.
   * Does not steal a live foreign owner's lease.
   */
  async start(): Promise<ProtocolHelloOk> {
    if (this.quitting) throw new Error('GuiMmsController is stopped')
    if (this.connected && this.lastHello) return this.lastHello

    // Tests may inject endpoint+token without a full runtime publication.
    if (!(this.endpointOverride && this.ownerTokenOverride)) {
      await this.ensureDaemonReady()
    }
    return this.connectOnce()
  }

  /**
   * Disconnect the GUI client only — never stops the daemon.
   */
  async stop(): Promise<void> {
    this.quitting = true
    await Promise.allSettled([...this.windowSessionOpenings.values()])
    await this.attachedBrowserHost?.shutdown()
    this.clearAllTimersAndListeners()
    this.setState('stopped')
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        /* ignore */
      }
      this.client = null
    }
    for (const unsubscribe of this.windowEventUnsubs.values()) unsubscribe()
    this.windowEventUnsubs.clear()
    await Promise.all([...this.windowSessions.entries()].map(([senderId, session]) => this.closeWindowSession(senderId, session)))
    this.windowSessions.clear()
    this.lastHello = null
    this.baseBinding = null
    // Do not kill startedDaemon — daemon lifetime is independent of Electron.
    this.startedDaemon = null
    // Allow a later start() after stop (tests / relaunch of UI client).
    this.quitting = false
  }

  /** Clear reconnect/disconnect monitors and event unsub (all failure/stop paths). */
  private clearAllTimersAndListeners(): void {
    this.clearReconnectTimer()
    this.detachEventHandlers()
  }

  private enterFailed(err?: Error): void {
    this.clearAllTimersAndListeners()
    this.setState('failed')
    if (err) this.emit('error', err)
  }

  /** Request against the live client; throws if not connected. */
  runWithSender<T>(sender: WebContents, fn: () => T): T {
    return this.senderAls.run(sender, fn)
  }

  /** Establish the exact window connection and profile binding before its renderer can attach guests. */
  async prepareWindow(sender: WebContents): Promise<TrustedProfileBinding> {
    await this.senderAls.run(sender, () => this.clientForCurrentSender())
    const binding = this.getWindowBindingForSender(sender.id)
    if (!binding) throw new Error('Window MMS profile binding is unavailable')
    return binding
  }

  setAttachedBrowserHost(host: GuiAttachedBrowserHost): void {
    if (this.windowSessions.size || this.windowSessionOpenings.size) throw new Error('Install browser host before opening window sessions')
    this.attachedBrowserHost = host
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const client = await this.clientForCurrentSender()
    const sender = this.senderAls.getStore()
    if (method === 'profiles.bind' && sender) await this.attachedBrowserHost?.releaseWindow(sender)
    const result = await client.request<T>(method, params)
    if (method === 'profiles.bind') {
      const sender = this.senderAls.getStore()
      if (sender) {
        const session = this.windowSessions.get(sender.id)
        const bound = result as unknown as { profile?: { id?: string }; epoch?: number }
        if (session && bound?.profile?.id && typeof bound.epoch === 'number' && Number.isSafeInteger(bound.epoch)) {
          session.binding = { profileId: bound.profile.id, epoch: bound.epoch }
          await session.client.subscribe(0)
          await this.attachedBrowserHost?.acknowledgeClosed(sender)
        }
      }
    }
    return result
  }

  getWindowBinding(): TrustedProfileBinding | null {
    const sender = this.senderAls.getStore()
    if (!sender) return null
    return this.windowSessions.get(sender.id)?.binding ?? null
  }

  /** Sender identity captured by the trusted IPC wrapper for this async call. */
  getCurrentSenderId(): number | null {
    return this.senderAls.getStore()?.id ?? null
  }

  getWindowBindingForSender(senderId: number): TrustedProfileBinding | null {
    const session = this.windowSessions.get(senderId)
    return session?.client.connected ? session.binding : null
  }

  /** Private host requests never reconnect or change the owning window connection. */
  async requestAttachedBrowser<T>(sender: WebContents, method: string, params: unknown): Promise<T> {
    const session = this.windowSessions.get(sender.id)
    if (!session?.client.connected || sender.isDestroyed()) throw new Error('Browser window connection is closed')
    return session.client.request<T>(method, params)
  }

  getBaseBinding(): TrustedProfileBinding | null {
    return this.baseBinding
  }

  private async clientForCurrentSender(): Promise<LocalMmsClient> {
    const sender = this.senderAls.getStore()
    if (!sender) {
      if (!this.client || !this.client.connected) {
        if (this.quitting || this.state === 'stopped') {
          throw new Error('MMS client not connected')
        }
        const connection = this.waitForConnection()
        this.scheduleReconnect('request_while_disconnected')
        await connection
      }
      if (!this.client || !this.client.connected) {
        throw new Error('MMS client not connected')
      }
      return this.client
    }
    if (this.quitting || sender.isDestroyed()) throw new Error('Window MMS session is closing')
    let session = this.windowSessions.get(sender.id)
    if (session && !session.client.connected) {
      await this.closeWindowSession(sender.id, session)
      session = undefined
    }
    if (!session) {
      let opening = this.windowSessionOpenings.get(sender.id)
      if (!opening) {
        opening = this.openWindowSession(sender)
        this.windowSessionOpenings.set(sender.id, opening)
        void opening.finally(() => {
          if (this.windowSessionOpenings.get(sender.id) === opening) this.windowSessionOpenings.delete(sender.id)
        }).catch(() => {})
      }
      session = await opening
    }
    return session.client
  }

  private async openWindowSession(sender: WebContents): Promise<WindowSession> {
    let destroyed = sender.isDestroyed()
    let openedSession: WindowSession | undefined
    let client: LocalMmsClient | undefined
    const onDestroyed = () => {
      destroyed = true
      if (openedSession) void this.closeWindowSession(sender.id, openedSession).catch(() => { /* Retained for stop retry. */ })
    }
    sender.once('destroyed', onDestroyed)
    try {
      if (!this.client || !this.client.connected) {
        await this.start()
      }
    const owner = this.resolveOwnerToken()
    const endpoint = this.endpointOverride ?? this.resolveEndpoint(readOwnerRecord(this.homeDir)!)
    const windowClient = new LocalMmsClient({
      homeDir: this.homeDir,
      ownerToken: owner,
      endpoint,
      clientType: 'gui',
      requestedCapabilities: [...GUI_PLATFORM_CAPABILITIES, ...(this.attachedBrowserHost ? [BROWSER_ATTACHED_V1_CAPABILITY] : [])],
      requestTimeoutMs: this.requestTimeoutMs
    })
    client = windowClient
    if (this.attachedBrowserHost) {
      windowClient.setAttachedBrowserCommandHandler((command, { signal }) => this.attachedBrowserHost!.handleCommand(sender, command, signal))
    }
    await windowClient.connect()
    const bound = await windowClient.request<{ profile: { id: string }; epoch: number }>('profiles.bind', {
      profile: 'default'
    }).catch(async () => {
      const listed = await windowClient.request<{ defaultProfileId: string }>('profiles.status')
      const retry = await windowClient.request<{ profile: { id: string }; epoch: number }>('profiles.bind', {
        profile: listed.defaultProfileId
      })
      return retry
    })
    const session: WindowSession = {
      sender,
      client: windowClient,
      binding: { profileId: bound.profile.id, epoch: bound.epoch }
    }
    openedSession = session
    if (this.quitting || destroyed || sender.isDestroyed()) {
      await this.closeWindowSession(sender.id, session)
      throw new Error('Window MMS session closed while opening')
    }
    this.windowSessions.set(sender.id, session)
    const unsubscribe = windowClient.onEvent((event, delivery) => {
      if (sender.isDestroyed()) return
      this.emit('window-event', { senderId: sender.id, event, replay: delivery?.replay === true })
      if (windowClient.requiresResnapshot) this.emit('window-resnapshot', { senderId: sender.id })
    })
    this.windowEventUnsubs.set(sender.id, unsubscribe)
    await windowClient.subscribe(0)
    await this.attachedBrowserHost?.acknowledgeClosed(sender)
    return session
    } catch (error) {
      if (!destroyed) sender.off('destroyed', onDestroyed)
      if (openedSession) await this.closeWindowSession(sender.id, openedSession).catch(() => undefined)
      else if (client) await client.close().catch(() => undefined)
      throw error
    }
  }

  private async closeWindowSession(senderId: number, session: WindowSession): Promise<void> {
    if (session.closing) return session.closing
    const operation = (async () => {
      await this.attachedBrowserHost?.releaseWindow(session.sender)
      await session.client.awaitCommandShutdown(30_000)
      await session.client.close()
      this.windowEventUnsubs.get(senderId)?.()
      this.windowEventUnsubs.delete(senderId)
      if (this.windowSessions.get(senderId) === session) this.windowSessions.delete(senderId)
    })()
    session.closing = operation
    void operation.catch(() => { if (session.closing === operation) session.closing = undefined })
    return operation
  }

  async controlStatus(): Promise<ControlStatus> {
    return this.request<ControlStatus>('control.status')
  }

  async controlLogin(): Promise<{ ok: boolean; error?: string }> {
    return this.request<{ ok: boolean; error?: string }>('control.login')
  }

  async controlLogout(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('control.logout')
  }

  async controlEnroll(serverUrl: string, pairingCode: string): Promise<{ ok: boolean; error?: string }> {
    return this.request<{ ok: boolean; error?: string }>('control.enroll', { serverUrl, pairingCode })
  }

  async controlDisconnect(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('control.disconnect')
  }

  async controlSetMode(mode: 'hosted' | 'self-hosted'): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('control.setMode', { mode })
  }

  async pairingCreate(options?: { scopes?: RemoteScope[]; ttlMs?: number }): Promise<CreatePairingResult> {
    return this.request<CreatePairingResult>('pairing.create', options)
  }

  async pairingList(): Promise<{ pairings: PairingGrant[] }> {
    return this.request<{ pairings: PairingGrant[] }>('pairing.list')
  }

  async pairingApprove(
    pairingId: string,
    scopes?: RemoteScope[]
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
    return this.request('pairing.approve', { pairingId, scopes })
  }

  async pairingReject(pairingId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('pairing.reject', { pairingId })
  }

  async pairingRevoke(pairingIdOrDeviceId: string): Promise<{ ok: boolean; revoked?: PairingGrant }> {
    return this.request<{ ok: boolean; revoked?: PairingGrant }>('pairing.revoke', { pairingIdOrDeviceId })
  }

  private waitForConnection(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (
      this.state === 'failed' &&
      (this.reconnectAttempts >= this.maxReconnect ||
        (this.disableAutoStart && !this.managedDaemon))
    ) {
      return Promise.reject(new Error('MMS reconnect is unavailable'))
    }
    const timeoutMs = Math.max(this.requestTimeoutMs ?? 0, SERVICE_START_TIMEOUT_MS)
    return new Promise<void>((resolve, reject) => {
      const onState = (state: GuiMmsConnectionState): void => {
        if (state === 'ready' && this.connected) finish()
        else if (state === 'stopped') finish(new Error('GuiMmsController is stopped'))
        else if (
          state === 'failed' &&
          (this.reconnectAttempts >= this.maxReconnect ||
            (this.disableAutoStart && !this.managedDaemon))
        ) {
          finish(new Error('MMS reconnect failed'))
        }
      }
      const timer = setTimeout(() => {
        finish(new Error(`MMS reconnect timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.off('state', onState)
        if (error) reject(error)
        else resolve()
      }
      this.on('state', onState)
      // Close the event-subscription race if readiness changed synchronously.
      if (this.connected) finish()
    })
  }

  async snapshotThread(threadId: string): Promise<ThreadSnapshotResult> {
    const result = await this.request<ThreadSnapshotResult>('thread.snapshot', { threadId })
    this.client?.clearResnapshotFlag()
    return result
  }

  /** Snapshot through one window's profile-bound session after an event gap. */
  async snapshotThreadForSender(senderId: number, threadId: string): Promise<ThreadSnapshotResult> {
    const session = this.windowSessions.get(senderId)
    if (!session || !session.client.connected) throw new Error('Window MMS session is not connected')
    const result = await session.client.request<ThreadSnapshotResult>('thread.snapshot', { threadId })
    session.client.clearResnapshotFlag()
    return result
  }

  clearResnapshotFlag(): void {
    this.client?.clearResnapshotFlag()
  }

  private async ensureDaemonReady(): Promise<MmsRuntimeRecord> {
    const runtime = resolveRuntimeStatus(this.homeDir)
    if (runtime.running && runtime.record) {
      return runtime.record
    }

    const owner = resolveOwnerStatus(this.homeDir)
    if (owner.owned && owner.record) {
      // Live owner but no runtime yet — wait for readiness publication.
      this.setState('connecting')
      const record = await pollUntilRuntimeReady(this.homeDir, {
        timeoutMs: SERVICE_START_TIMEOUT_MS,
        intervalMs: SERVICE_POLL_INTERVAL_MS
      })
      if (record) return record
      throw new Error(
        formatOwnerBusyMessage(owner.record, owner.heldUnreadable) +
          ' (owner live but runtime readiness not published)'
      )
    }

    if (owner.heldUnreadable) {
      throw new Error(formatOwnerBusyMessage(null, true))
    }

    // Dev script / tests own the daemon: poll until ready, never spawn a second process.
    if (this.disableAutoStart) {
      this.setState('connecting')
      const record = await pollUntilRuntimeReady(this.homeDir, {
        timeoutMs: SERVICE_START_TIMEOUT_MS,
        intervalMs: SERVICE_POLL_INTERVAL_MS
      })
      if (record) return record
      throw new Error(
        this.managedDaemon
          ? `MMS daemon is not ready (managed by npm run dev). Waited ${SERVICE_START_TIMEOUT_MS}ms.`
          : 'MMS daemon is not running and auto-start is disabled'
      )
    }

    this.setState('starting_daemon')
    const child = await this.spawnDaemon()
    const record = await this.waitForSpawnedDaemon(child)
    if (!record) {
      throw new Error(
        `MMS daemon failed to become ready within ${GUI_DAEMON_START_TIMEOUT_MS}ms. ` +
          `Startup details were written to ${join(this.homeDir, 'mms-startup.log')}`
      )
    }
    return record
  }

  private async spawnDaemon(): Promise<ChildProcess> {
    // Prefer the CLI entry packaged next to main; fall back to source-layout path in dev.
    const candidates = [
      join(__dirname, '../cli/index.js'),
      join(__dirname, '../../cli/index.js'),
      // electron-vite out layout
      join(process.cwd(), 'out/cli/index.js')
    ]
    let scriptPath: string | undefined
    for (const c of candidates) {
      if (existsSync(c)) {
        scriptPath = c
        break
      }
    }

    const host = resolveDaemonHostInvocation(
      scriptPath ?? (typeof import.meta.url === 'string' ? fileURLToPath(import.meta.url) : undefined)
    )
    // A packaged GUI must re-enter its own dual-mode executable. PATH launchers
    // and the copied console host are intended for user shells; resolving either
    // here can delay or prevent the daemon and leave a Start Menu launch headless.
    const isPackagedGuiHost = Boolean(
      process.versions.electron && /^mousse(?:\.exe)?$/i.test(basename(process.execPath))
    )
    const command = isPackagedGuiHost ? process.execPath : host.command
    const argsPrefix = isPackagedGuiHost ? ['--cli'] : host.argsPrefix
    const env = isPackagedGuiHost
      ? { ...process.env, MOUSSE_CLI: '1' }
      : host.env
    mkdirSync(this.homeDir, { recursive: true })
    const logPath = join(this.homeDir, 'mms-startup.log')
    const logFd = openSync(logPath, 'a')
    let child: ChildProcess
    try {
      child = spawn(
        command,
        [...argsPrefix, 'service', 'run', '--home', this.homeDir],
        {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...env, MOUSSE_HOME: this.homeDir },
          windowsHide: true
        }
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } finally {
      closeSync(logFd)
    }
    child.unref()
    this.startedDaemon = child
    return child
  }

  private async waitForSpawnedDaemon(child: ChildProcess): Promise<MmsRuntimeRecord | null> {
    const deadline = Date.now() + GUI_DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const runtime = resolveRuntimeStatus(this.homeDir)
      if (runtime.running && runtime.record) return runtime.record
      if (child.exitCode !== null || child.signalCode !== null) {
        let detail = ''
        try {
          const log = readFileSync(join(this.homeDir, 'mms-startup.log'), 'utf8').trim()
          detail = log ? ` Last startup output: ${log.slice(-2_000)}` : ''
        } catch {
          /* best effort diagnostics */
        }
        throw new Error(
          `MMS daemon exited before readiness (code ${child.exitCode ?? 'none'}, ` +
            `signal ${child.signalCode ?? 'none'}).${detail}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, SERVICE_POLL_INTERVAL_MS))
    }
    return null
  }

  private async connectOnce(): Promise<ProtocolHelloOk> {
    if (this.quitting) throw new Error('GuiMmsController is stopped')
    this.setState('connecting')

    const owner = readOwnerRecord(this.homeDir)
    if (!owner) {
      throw new Error('MMS owner record missing after readiness')
    }
    const token = this.ownerTokenOverride ?? owner.token
    const endpoint = this.resolveEndpoint(owner)

    const client = new LocalMmsClient({
      homeDir: this.homeDir,
      ownerToken: token,
      endpoint,
      clientType: 'gui',
      requestedCapabilities: [...GUI_PLATFORM_CAPABILITIES],
      requestTimeoutMs: this.requestTimeoutMs
    })

    try {
      const hello = await client.connect()
      if (hello.protocolVersion !== MMS_PROTOCOL_VERSION) {
        await client.close()
        throw new Error(
          `Incompatible MMS protocol version ${hello.protocolVersion}; GUI expects ${MMS_PROTOCOL_VERSION}`
        )
      }

      this.detachEventHandlers()
      this.client = client
      this.lastHello = hello
      try {
        const bound = await client.request<{ profile?: { id?: string }; epoch?: number }>('profiles.bind', { profile: 'default' })
        if (bound.profile?.id && typeof bound.epoch === 'number') {
          this.baseBinding = { profileId: bound.profile.id, epoch: bound.epoch }
        }
      } catch {
        // Older single-profile daemons remain usable through the legacy path.
        this.baseBinding = null
      }
      this.reconnectAttempts = 0

      this.eventUnsub = client.onEvent((event) => {
        this.emit('event', event)
        if (client.requiresResnapshot) {
          this.emit('resnapshot', { reason: 'gap', hello: this.lastHello })
        }
      })

      // Detect disconnect via polling connection flag after operations; also wrap close path.
      // LocalMmsClient rejects pending on disconnect; schedule reconnect unless quitting.
      this.watchDisconnect(client)

      await client.subscribe(client.lastKnownSequence > 0 ? client.lastKnownSequence : 0)
      if (client.requiresResnapshot) {
        this.emit('resnapshot', { reason: 'subscribe_gap_or_instance', hello })
      }

      this.setState('ready')
      return hello
    } catch (err) {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
      if (this.client === client) this.client = null
      this.enterFailed(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  private watchDisconnect(client: LocalMmsClient): void {
    // Single disconnect poll interval — cleared on stop/replace to avoid leaks.
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer)
      this.disconnectTimer = null
    }
    this.disconnectTimer = setInterval(() => {
      if (this.quitting || this.client !== client) return
      if (!client.connected && this.state === 'ready') {
        this.scheduleReconnect('disconnect')
      }
    }, 1000)
  }

  private scheduleReconnect(reason: string): void {
    if (this.quitting) return
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= this.maxReconnect) {
      this.enterFailed(new Error(`MMS reconnect exhausted after ${reason}`))
      return
    }
    this.setState('reconnecting')
    const attempt = this.reconnectAttempts++
    const delay = Math.min(30_000, this.reconnectBaseMs * Math.pow(2, attempt))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect(reason)
    }, delay)
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.quitting) return
    try {
      this.detachEventHandlers()
      if (this.client) {
        try {
          await this.client.close()
        } catch {
          /* ignore */
        }
        this.client = null
      }
      // Injected test endpoints skip daemon readiness; production waits for runtime.
      if (!(this.endpointOverride && this.ownerTokenOverride)) {
        await this.ensureDaemonReady()
      }
      const hello = await this.connectOnce()
      this.emit('resnapshot', { reason: `reconnect:${reason}`, hello })
    } catch (err) {
      if (this.quitting) return
      // Tests with auto-start off fail fast; managed daemon keeps retrying while dev restarts MMS.
      if (this.disableAutoStart && !this.managedDaemon) {
        this.enterFailed(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.scheduleReconnect('reconnect_failed')
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private detachEventHandlers(): void {
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer)
      this.disconnectTimer = null
    }
    if (this.eventUnsub) {
      try {
        this.eventUnsub()
      } catch {
        /* ignore */
      }
      this.eventUnsub = null
    }
  }
}

export function createGuiMmsController(opts?: GuiMmsControllerOptions): GuiMmsController {
  return new GuiMmsController(opts)
}
