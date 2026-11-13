import { ERROR_INFO_CAPABILITY } from '../../shared/errors'
import { connectGuiClient } from './guiDaemonCompatibility'
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
import type { ThreadActivitySnapshot } from '../../shared/types'
import type { AttachedBrowserCommand, AttachedBrowserCommandHandler } from '../../mms/protocol/connectionCommands'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../../shared/browser/connectionCommands'
import { BROWSER_VIEWER_CAPABILITY } from '../../shared/browser/host'
import { BROWSER_SETUP_CAPABILITY } from '../../shared/browser/setup'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { resolveDaemonHostInvocation } from '../../cli/daemonHost'
import { daemonCommand } from './daemonCommand'
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
import { FIRST_SEND_BINDING_CAPABILITY, type ProtocolEvent, type ProtocolHelloOk } from '../../mms/protocol/types'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import { AGENT_DEFINITION_CAPABILITY } from '../../shared/agentPlatform'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../../shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY } from '../../shared/workflowRunPlatform'
import { INTEGRATION_CAPABILITY } from '../../shared/integrationPlatform'
import { CHAT_CAPABILITY } from '../../shared/chats'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import type { TrustedProfileBinding } from '../../mms/protocol/domainRegistry'
import { resolveLocalEndpoint } from '../../mms/protocol/endpoint'
import { isQualifiedId } from '../../shared/threadRef'
import type { TurnState } from '../../shared/types'
import { describeLinkError, type GuiConnectionLogSink } from './guiConnectionLog'

/** A window opens a thread at its newest messages; older ones load as it scrolls back (`thread.messages`). */
const GUI_SNAPSHOT_NEWEST = 200

/** First wait before a window's lost service connection is opened again; it doubles up to `WINDOW_REOPEN_MAX_MS`. */
export const WINDOW_REOPEN_BASE_MS = 500
export const WINDOW_REOPEN_MAX_MS = 30_000

/**
 * Where an answer to a read stands among the service's updates (#1042): the service that answered (`instance`) and its
 * event number, for the reader's profile, when it read the state (`revision`). An update numbered above the revision
 * was sent after the read and is newer than the answer, even when it arrives first.
 */
export interface ReadOrder {
  instance?: string
  revision?: number
}

/** What the service says about one thread's turn, read without its transcript (`turnStatusForSender`). */
export interface WindowTurnStatus extends ReadOrder {
  turnState?: TurnState
  activeTurn: { active: boolean; running: boolean }
  activity?: string
}

/** Every thread's status through one window's connection (`activityForSender`). */
export interface WindowActivity extends ReadOrder {
  activity: ThreadActivitySnapshot
}

/** An error about the service connection, with a code the connection log keeps (its text is never logged). */
function linkError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** An answer's order. A thread of another computer is answered there, in that computer's numbering: no revision. */
function readOrder(instance: string | undefined, threadId: string | undefined, revision: unknown): ReadOrder {
  return {
    ...(instance ? { instance } : {}),
    ...(typeof revision === 'number' && Number.isFinite(revision) && !(threadId && isQualifiedId(threadId)) ? { revision } : {})
  }
}

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
  /** The service's state of the thread's turn (absent from an older service). */
  turnState?: unknown
  connectionFailed: boolean
  /** A long transcript of another computer arrives as its newest part: the older messages are loaded from `before`. */
  earlier?: { before: string; count: number }
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
  /** Stops the window's `destroyed` listener for this connection, so connections opened again do not pile them up. */
  detachDestroyed?: () => void
}

interface WindowReopen {
  sender: WebContents
  timer: ReturnType<typeof setTimeout> | null
  attempts: number
  /**
   * Waits for the main connection: the service went away with it, or the main connection gave up. Opened again when
   * the main connection's reconnect brings it back (`reopenWindowsAfterService`), never on its own.
   */
  waiting: boolean
  /** The reopen itself is opening the connection (not a request of the window). */
  opening?: boolean
}

export interface GuiAttachedBrowserHost {
  handleCommand(sender: WebContents, command: AttachedBrowserCommand, signal: AbortSignal): Promise<Awaited<ReturnType<AttachedBrowserCommandHandler>>>
  releaseWindow(sender: WebContents): Promise<void>
  acknowledgeClosed(sender: WebContents): Promise<void>
  shutdown(): Promise<void>
}

const GUI_PLATFORM_CAPABILITIES = [
  ERROR_INFO_CAPABILITY,
  PROFILES_V1_CAPABILITY,
  AGENT_DEFINITION_CAPABILITY,
  WORKFLOW_DEFINITIONS_CAPABILITY,
  WORKFLOW_RUN_CAPABILITY,
  INTEGRATION_CAPABILITY,
  CHAT_CAPABILITY,
  NET_LOCAL_CAPABILITY,
  BROWSER_VIEWER_CAPABILITY,
  BROWSER_SETUP_CAPABILITY,
  FIRST_SEND_BINDING_CAPABILITY
] as const

export class GuiMmsController extends EventEmitter {
  readonly homeDir: string
  private client: LocalMmsClient | null = null
  private readonly senderAls = new AsyncLocalStorage<WebContents>()
  private readonly profileTransitions = new Map<number, number>()
  private readonly windowSessions = new Map<number, WindowSession>()
  private readonly windowSessionOpenings = new Map<number, Promise<WindowSession>>()
  private attachedBrowserHost?: GuiAttachedBrowserHost
  private readonly windowEventUnsubs = new Map<number, () => void>()
  private baseBinding: TrustedProfileBinding | null = null
  private state: GuiMmsConnectionState = 'idle'
  private quitting = false
  /**
   * Set while an update installs (`stopForInstall`). Unlike `quitting`, `stop()` does not clear it: nothing may start
   * or reconnect to the service until `resumeAfterInstall`, because a service started now runs the old executable and
   * keeps the installer from replacing it.
   */
  private installing = false
  private reconnectAttempts = 0
  /** The thread of this computer each window shows (`setShownThreadSource`). */
  private shownThreadOf: ((senderId: number) => string | null) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** The reconnect in progress; requests join it and `stop()` waits for it. */
  private reconnecting: Promise<boolean> | null = null
  private eventUnsub: (() => void) | null = null
  private disconnectTimer: ReturnType<typeof setInterval> | null = null
  private lastHello: ProtocolHelloOk | null = null
  private startedDaemon: ChildProcess | null = null
  private startPromise: Promise<ProtocolHelloOk> | null = null
  private readonly maxReconnect: number
  private readonly reconnectBaseMs: number
  private readonly disableAutoStart: boolean
  /** External process owns the daemon (dev script); wait/reconnect, never spawn. */
  private readonly managedDaemon: boolean
  private readonly endpointOverride?: string
  private readonly ownerTokenOverride?: string
  private readonly requestTimeoutMs?: number
  /** Where main writes what happens to its service connections (`<home>/logs/gui-connection.log`). */
  private linkLog: GuiConnectionLogSink | null = null
  /** Windows whose own connection closed without main closing it, waiting to be opened again. */
  private readonly windowReopens = new Map<number, WindowReopen>()
  /**
   * The profile each window was last bound to. A connection opened again for the window (after a service restart or a
   * dropped connection) is bound to it, not to the default: the window still shows that profile (#1042).
   */
  private readonly windowProfiles = new Map<number, string>()
  private readonly reopenWatched = new WeakSet<WebContents>()
  private disconnectUnsub: (() => void) | null = null

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

  /** True from `stopForInstall` until `resumeAfterInstall`. */
  get installingUpdate(): boolean {
    return this.installing
  }

  setConnectionLog(log: GuiConnectionLogSink | null): void {
    this.linkLog = log
  }

  private log(event: string, fields?: Parameters<GuiConnectionLogSink['write']>[1]): void {
    this.linkLog?.write(event, fields)
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
      throw linkError('owner_token_unavailable', 'MMS owner token unavailable; daemon is not ready')
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
    this.assertMayConnect()
    if (this.connected && this.lastHello) return this.lastHello
    // Connected before in this run, so the service went away: connecting again is the reconnect's work, which is what
    // tells the windows the service restarted and reads their lists again (#1042). A start here waits for it, or asks
    // for it when nothing has noticed the loss yet; it never connects around it.
    if (this.lastHello) return this.restoreService('request')
    if (this.startPromise) return this.startPromise
    // Renderer bootstrap requests and main's eager start share one discovery,
    // daemon spawn and base handshake. Window sessions keep their own fences.
    const operation = (async () => {
      // A reconnect in progress starts the service and connects itself; this start joins it rather than racing it.
      if (this.reconnecting) {
        await this.reconnecting.catch(() => false)
        if (this.connected && this.lastHello) return this.lastHello
      }
      this.assertMayConnect()
      // Tests may inject endpoint+token without a full runtime publication.
      if (!(this.endpointOverride && this.ownerTokenOverride)) await this.ensureDaemonReady()
      this.assertMayConnect()
      return this.connectOnce()
    })()
    this.startPromise = operation
    try {
      return await operation
    } finally {
      if (this.startPromise === operation) this.startPromise = null
    }
  }

  /**
   * Disconnect the GUI client only — never stops the daemon.
   */
  async stop(): Promise<void> {
    this.quitting = true
    this.clearReconnectTimer()
    for (const reopen of this.windowReopens.values()) if (reopen.timer) clearTimeout(reopen.timer)
    this.windowReopens.clear()
    await this.startPromise?.catch(() => undefined)
    await this.reconnecting?.catch(() => undefined)
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

  /**
   * Disconnects like `stop()` and keeps the controller from starting, reconnecting or spawning the service until
   * `resumeAfterInstall`. Windows stay open while Mousse quits for the installer and keep asking for data; without
   * this, the first such request after the service stopped would start it again from the executable being replaced.
   */
  async stopForInstall(): Promise<void> {
    this.installing = true
    await this.stop()
  }

  /** The installer did not start: the controller may connect (and start the service) again. */
  resumeAfterInstall(): void {
    this.installing = false
  }

  private assertMayConnect(): void {
    if (this.installing) throw linkError('installing', 'Mousse is installing an update')
    if (this.quitting) throw linkError('stopped', 'GuiMmsController is stopped')
  }

  /** Clear reconnect/disconnect monitors and event unsub (all failure/stop paths). */
  private clearAllTimersAndListeners(): void {
    this.clearReconnectTimer()
    this.detachEventHandlers()
  }

  private enterFailed(err?: Error): void {
    this.clearAllTimersAndListeners()
    this.setState('failed')
    this.log('service.failed', { error: err ? describeLinkError(err) : undefined, attempts: this.reconnectAttempts, gaveUp: this.gaveUp })
    if (err) this.reportError(err)
    // The main connection gave up: windows stop trying with it, and try again when it does (a request, or a reconnect).
    if (this.gaveUp) this.parkWindowReopens()
  }

  /**
   * A failed start or reconnect, for whoever listens (main logs it). Unheard, an `error` event throws, and a reconnect
   * attempt that failed while the service was still down became an unhandled rejection instead of the next attempt.
   */
  private reportError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err)
  }

  /**
   * The main connection stopped trying: its reconnects ran out, or a test controller that never reconnects failed.
   * Only a request (the person doing something in a window) tries again, once.
   */
  private get gaveUp(): boolean {
    return this.state === 'failed' && !this.reconnecting && !this.reconnectTimer &&
      (this.reconnectAttempts >= this.maxReconnect || (this.disableAutoStart && !this.managedDaemon))
  }

  /**
   * The one way a lost main connection is acted on (#1042). The connection's own close, its one-second check, a
   * window whose connection dropped with it and a request all come here, whichever notices first; the reconnect it
   * schedules is the only thing that connects again. That reconnect tells the windows the service restarted, reads
   * their lists again and opens their connections again (`attemptReconnect`), so none of it can be skipped.
   */
  private mainConnectionLost(noticedBy: string): void {
    if (this.quitting || this.installing) return
    const client = this.client
    if (this.state !== 'ready' || !client || client.connected) return
    this.log('service.lost', { noticedBy, lastSequence: client.lastKnownSequence })
    this.scheduleReconnect('disconnect')
  }

  /**
   * A request needs the main connection after it was lost: it waits for the reconnect, asks for one when nothing has
   * noticed the loss yet, and after the reconnect gave up tries once more (the person asked).
   */
  private async restoreService(noticedBy: string): Promise<ProtocolHelloOk> {
    if (this.state === 'ready' && this.client && !this.client.connected) this.mainConnectionLost(noticedBy)
    if (this.gaveUp) {
      this.log('service.retry', { by: noticedBy })
      await this.reconnect('retry')
      if (!this.connected || !this.lastHello) throw linkError('reconnect_unavailable', 'MMS reconnect is unavailable')
      return this.lastHello
    }
    if (!this.connected && !this.reconnectTimer && !this.reconnecting) this.scheduleReconnect('disconnect')
    await this.waitForConnection()
    if (!this.lastHello) throw linkError('not_connected', 'MMS client not connected')
    return this.lastHello
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

  /** `timeoutMs` overrides the client's per-method default for this call. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const sender = this.senderAls.getStore()
    const transition = method === 'profiles.bind' && sender
    if (transition) {
      this.profileTransitions.set(sender.id, (this.profileTransitions.get(sender.id) ?? 0) + 1)
      this.emit('window-profile-changing', {senderId: sender.id})
    }
    try {
      const client = await this.clientForCurrentSender()
      if (transition) await this.attachedBrowserHost?.releaseWindow(sender)
      const result = await client.request<T>(method, params, timeoutMs)
      if (transition) {
        const session = this.windowSessions.get(sender.id)
        const bound = result as unknown as {profile?:{id?:string};epoch?:number}
        if (session && bound?.profile?.id && typeof bound.epoch === 'number' && Number.isSafeInteger(bound.epoch)) {
          session.binding = {profileId:bound.profile.id,epoch:bound.epoch}
          this.rememberWindowProfile(sender, bound.profile.id)
          const subscribed = await session.client.subscribe(0)
          this.afterWindowSubscribe(sender.id, session.client, subscribed, 'profile-bound')
          await this.attachedBrowserHost?.acknowledgeClosed(sender)
        }
      }
      return result
    } finally {
      if (transition) {
        this.emit('window-profile-changing', {senderId:sender.id})
        const remaining = (this.profileTransitions.get(sender.id) ?? 1) - 1
        if (remaining > 0) this.profileTransitions.set(sender.id, remaining)
        else this.profileTransitions.delete(sender.id)
      }
    }
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

  /**
   * Says which thread each window shows. Every new connection of a window (its first, and each one that replaces a
   * closed one after a daemon restart or a dropped connection) tells the daemon again, so the thread stays loaded
   * there (`threads.focus`); the daemon forgets a window's shown threads when its connection closes.
   */
  setShownThreadSource(source: ((senderId: number) => string | null) | null): void {
    this.shownThreadOf = source
  }

  getWindowBindingForSender(senderId: number): TrustedProfileBinding | null {
    const session = this.windowSessions.get(senderId)
    return !this.profileTransitions.has(senderId) && !session?.closing && session?.client.connected ? session.binding : null
  }

  /**
   * The window is switching profiles: what its connection hears meanwhile (the new profile's replay) is not for the
   * profile it shows, and the window reads the new profile in full when the switch ends. Nothing was lost.
   */
  isProfileChanging(senderId: number): boolean {
    return this.profileTransitions.has(senderId)
  }

  /** The service a window's connection talks to: answers and updates are numbered per service instance. */
  instanceForSender(senderId: number): string | undefined {
    return this.windowSessions.get(senderId)?.client.hello?.instanceId
  }

  private rememberWindowProfile(sender: WebContents, profileId: string): void {
    if (!this.windowProfiles.has(sender.id)) sender.once('destroyed', () => this.windowProfiles.delete(sender.id))
    this.windowProfiles.set(sender.id, profileId)
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
        if (this.installing) throw linkError('installing', 'Mousse is installing an update')
        if (this.quitting || this.state === 'stopped') {
          throw linkError('not_connected', 'MMS client not connected')
        }
        this.mainConnectionLost('request')
        const connection = this.waitForConnection()
        this.scheduleReconnect('request_while_disconnected')
        await connection
      }
      if (!this.client || !this.client.connected) {
        throw linkError('not_connected', 'MMS client not connected')
      }
      return this.client
    }
    if (this.installing) throw linkError('installing', 'Mousse is installing an update')
    if (this.quitting || sender.isDestroyed()) throw linkError('window_closing', 'Window MMS session is closing')
    let session = this.windowSessions.get(sender.id)
    if (session && !session.client.connected) {
      // A lost connection, whether or not its close was seen yet: the one that replaces it catches the window up.
      if (!session.closing) this.reopenFor(sender)
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
      requestTimeoutMs: this.requestTimeoutMs,
      // Views of a window ask the same reads at the same moment; one request answers them all (#420).
      shareIdenticalReads: true
    })
    client = windowClient
    if (this.attachedBrowserHost) {
      windowClient.setAttachedBrowserCommandHandler((command, { signal }) => this.attachedBrowserHost!.handleCommand(sender, command, signal))
    }
    await connectGuiClient(windowClient, this.homeDir)
    const bound = await this.bindWindowClient(sender, windowClient)
    const session: WindowSession = {
      sender,
      client: windowClient,
      binding: { profileId: bound.profile.id, epoch: bound.epoch },
      detachDestroyed: () => sender.off('destroyed', onDestroyed)
    }
    openedSession = session
    this.rememberWindowProfile(sender, bound.profile.id)
    if (this.quitting || this.installing || destroyed || sender.isDestroyed()) {
      await this.closeWindowSession(sender.id, session)
      throw new Error('Window MMS session closed while opening')
    }
    this.windowSessions.set(sender.id, session)
    const unsubscribe = windowClient.onEvent((event, delivery) => {
      if (sender.isDestroyed()) return
      this.emit('window-event', { senderId: sender.id, event, replay: delivery?.replay === true, instance: windowClient.hello?.instanceId })
      if (windowClient.requiresResnapshot) this.emit('window-resnapshot', { senderId: sender.id })
    })
    const unsubscribeConnection = windowClient.onConnectionEvent(event => {
      const binding = session.binding
      if (sender.isDestroyed() || this.windowSessions.get(sender.id) !== session ||
        !binding || event.profileId !== binding.profileId || event.profileEpoch !== binding.epoch) return
      this.emit('window-connection-event', { senderId: sender.id, event })
    })
    // A connection main did not close (the service restarted, or dropped it as too slow to read) is opened again
    // at once instead of waiting for the window's next request; until then the window hears nothing (#1042).
    const unsubscribeClosed = windowClient.onConnectionClosed(error => this.windowConnectionLost(sender, session, error))
    this.windowEventUnsubs.set(sender.id, () => { unsubscribe(); unsubscribeConnection(); unsubscribeClosed() })
    const subscribed = await windowClient.subscribe(0)
    this.afterWindowSubscribe(sender.id, windowClient, subscribed, this.windowReopens.has(sender.id) ? 'reopened' : 'opened')
    await this.attachedBrowserHost?.acknowledgeClosed(sender)
    // A thread of this computer the window already shows is shown again on this connection; nothing waits for it.
    // Threads of other computers are focused through their router when they are selected.
    const shown = this.shownThreadOf?.(sender.id)
    if (shown && !isQualifiedId(shown)) void windowClient.request('threads.focus', { threadId: shown, focused: true }).catch(() => undefined)
    // This connection replaces a lost one: the window is caught up, once, whether its reopen or one of its requests
    // (the person doing something) opened it.
    const replaced = this.windowReopens.get(sender.id)
    if (replaced) {
      if (replaced.timer) clearTimeout(replaced.timer)
      this.windowReopens.delete(sender.id)
      this.log('window.reopened', { window: sender.id, attempts: replaced.attempts, byRequest: !replaced.opening })
      queueMicrotask(() => this.emit('window-session-reopened', { senderId: sender.id }))
    }
    return session
    } catch (error) {
      if (!destroyed) sender.off('destroyed', onDestroyed)
      if (openedSession) await this.closeWindowSession(sender.id, openedSession).catch(() => undefined)
      else if (client) await client.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * A window's subscription is in place. A gap it reported (the service's replay no longer holds what the window
   * missed) is acted on now: it used to wait for the next event, and after a finished turn none may come.
   */
  private afterWindowSubscribe(
    senderId: number,
    client: LocalMmsClient,
    subscribed: { sequence: number; gap: boolean; replay?: unknown[] },
    how: 'opened' | 'reopened' | 'profile-bound'
  ): void {
    this.log('window.subscribed', {
      window: senderId,
      how,
      sequence: subscribed.sequence,
      replayed: Array.isArray(subscribed.replay) ? subscribed.replay.length : 0,
      gap: client.requiresResnapshot
    })
    // Where the profile's counter stands: one lower than numbers already applied was started again (#1042).
    const profileId = this.windowSessions.get(senderId)?.binding?.profileId
    if (profileId) this.emit('window-subscribed', { senderId, profileId, instance: client.hello?.instanceId, sequence: subscribed.sequence, how })
    // `subscribed`: the replay itself lost events (the service no longer holds them), unlike a gap in live events.
    if (client.requiresResnapshot) this.emit('window-resnapshot', { senderId, subscribed: true })
  }

  /**
   * Binds a new window connection to the profile the window shows: the one it was last bound to, or the default for a
   * window that was never bound. A remembered profile that cannot be bound any more (it was removed) falls back to the
   * default, as a new window would.
   */
  private async bindWindowClient(sender: WebContents, client: LocalMmsClient): Promise<{ profile: { id: string }; epoch: number }> {
    const remembered = this.windowProfiles.get(sender.id)
    if (remembered) {
      try {
        return await client.request<{ profile: { id: string }; epoch: number }>('profiles.bind', { profile: remembered })
      } catch (error) {
        this.log('window.profile-unavailable', { window: sender.id, error: describeLinkError(error) })
      }
    }
    return client.request<{ profile: { id: string }; epoch: number }>('profiles.bind', { profile: 'default' }).catch(async () => {
      const listed = await client.request<{ defaultProfileId: string }>('profiles.status')
      return client.request<{ profile: { id: string }; epoch: number }>('profiles.bind', { profile: listed.defaultProfileId })
    })
  }

  /** A window's own connection closed. Main's own closes (`closeWindowSession`, `stop`) are not losses. */
  private windowConnectionLost(sender: WebContents, session: WindowSession, error: Error): void {
    if (session.closing || this.quitting || this.installing || sender.isDestroyed()) return
    if (this.windowSessions.get(sender.id) !== session) return
    this.log('window.lost', { window: sender.id, error: describeLinkError(error), lastSequence: session.client.lastKnownSequence })
    // A service restart closes this connection and the main one together. When the window notices first, it hands the
    // loss to the main connection's path rather than connecting around it.
    this.mainConnectionLost('window')
    this.scheduleWindowReopen(sender)
  }

  private reopenFor(sender: WebContents): WindowReopen {
    let reopen = this.windowReopens.get(sender.id)
    if (!reopen) {
      reopen = { sender, timer: null, attempts: 0, waiting: false }
      this.windowReopens.set(sender.id, reopen)
      // Once per window, however often its connection is opened again.
      if (!this.reopenWatched.has(sender)) {
        this.reopenWatched.add(sender)
        sender.once('destroyed', () => {
          const pending = this.windowReopens.get(sender.id)
          if (pending?.timer) clearTimeout(pending.timer)
          this.windowReopens.delete(sender.id)
        })
      }
    }
    return reopen
  }

  /**
   * Opens a window's lost connection again, after a short wait that doubles. It follows the main connection: while that
   * is down the window waits for its reconnect (which opens every waiting window), and it never starts the service or
   * connects the main connection itself. A window whose connection cannot be opened while the service is up stops
   * after as many tries as the main connection makes, and waits like the others.
   */
  private scheduleWindowReopen(sender: WebContents): void {
    if (this.quitting || this.installing || sender.isDestroyed()) {
      this.windowReopens.delete(sender.id)
      return
    }
    const reopen = this.reopenFor(sender)
    if (reopen.timer || reopen.waiting) return
    if (!this.connected || reopen.attempts >= this.maxReconnect) {
      this.waitForService(reopen)
      return
    }
    const delay = Math.min(WINDOW_REOPEN_MAX_MS, WINDOW_REOPEN_BASE_MS * 2 ** reopen.attempts)
    reopen.attempts += 1
    reopen.timer = setTimeout(() => {
      reopen.timer = null
      void this.reopenWindow(sender, reopen)
    }, delay)
    ;(reopen.timer as { unref?: () => void }).unref?.()
  }

  private waitForService(reopen: WindowReopen): void {
    if (reopen.timer) clearTimeout(reopen.timer)
    reopen.timer = null
    if (reopen.waiting) return
    reopen.waiting = true
    this.log('window.waiting', { window: reopen.sender.id, service: this.state, attempts: reopen.attempts })
  }

  /** The main connection gave up: windows stop trying too, until a request or a reconnect brings the service back. */
  private parkWindowReopens(): void {
    for (const reopen of this.windowReopens.values()) this.waitForService(reopen)
  }

  /**
   * The main connection is back after a reconnect: every window whose connection was lost is opened again now, each
   * then caught up (`window-session-reopened`). A window that did not notice its loss yet is found here too.
   */
  private reopenWindowsAfterService(): void {
    for (const [senderId, session] of this.windowSessions) {
      if (!session.client.connected && !session.closing && !session.sender.isDestroyed() && !this.windowReopens.has(senderId)) {
        this.reopenFor(session.sender)
      }
    }
    for (const reopen of [...this.windowReopens.values()]) {
      if (reopen.timer) clearTimeout(reopen.timer)
      reopen.timer = null
      reopen.waiting = false
      reopen.attempts = 0
      void this.reopenWindow(reopen.sender, reopen)
    }
  }

  private async reopenWindow(sender: WebContents, reopen: WindowReopen): Promise<void> {
    if (this.windowReopens.get(sender.id) !== reopen) return
    if (this.quitting || this.installing || sender.isDestroyed()) {
      this.windowReopens.delete(sender.id)
      return
    }
    if (!this.connected) {
      // The service went away with the main connection: its reconnect opens this window again.
      this.mainConnectionLost('window')
      this.waitForService(reopen)
      return
    }
    const current = this.windowSessions.get(sender.id)
    // The connection is open again already (a request opened it, or the drop was never real): it still needs catching
    // up. Otherwise opening it catches the window up (`openWindowSession`).
    const alreadyOpen = Boolean(current?.client.connected && !current.closing)
    try {
      reopen.opening = true
      if (!alreadyOpen) await this.prepareWindow(sender)
      if (this.windowReopens.get(sender.id) !== reopen) return
      this.windowReopens.delete(sender.id)
      this.log('window.reopened', { window: sender.id, attempts: reopen.attempts, byRequest: alreadyOpen })
      this.emit('window-session-reopened', { senderId: sender.id })
    } catch (error) {
      reopen.opening = false
      if (this.windowReopens.get(sender.id) !== reopen) return
      this.log('window.reopen-failed', { window: sender.id, attempts: reopen.attempts, error: describeLinkError(error) })
      this.scheduleWindowReopen(sender)
    }
  }

  /**
   * What the service says about a thread's turn, read through the window's own connection without the transcript: the
   * cheap check behind the catch-up (#1042). The answer carries where it stands among the window's updates
   * (`ReadOrder`), so the caller can tell an answer older than an update it already applied. With `clearsGap` the read
   * answers the connection's gap flag (cleared when it starts, restored if it fails), like `snapshotThreadForSender`.
   */
  async turnStatusForSender(senderId: number, threadId: string, clearsGap = false): Promise<WindowTurnStatus> {
    const session = this.windowSessions.get(senderId)
    if (!session || !session.client.connected) throw linkError('window_not_connected', 'Window MMS session is not connected')
    const needed = clearsGap && session.client.requiresResnapshot
    if (clearsGap) session.client.clearResnapshotFlag()
    const instance = session.client.hello?.instanceId
    let status: { turnState?: TurnState; activeTurn?: { active?: boolean; running?: boolean }; activity?: string; revision?: number }
    try {
      status = await session.client.request('thread.snapshot', { threadId, transcript: false })
    } catch (error) {
      if (needed) session.client.markResnapshotNeeded()
      throw error
    }
    return {
      ...(status?.turnState && typeof status.turnState === 'object' ? { turnState: status.turnState } : {}),
      activeTurn: { active: Boolean(status?.activeTurn?.active), running: Boolean(status?.activeTurn?.running) },
      ...(typeof status?.activity === 'string' ? { activity: status.activity } : {}),
      ...readOrder(instance, threadId, status?.revision)
    }
  }

  private async closeWindowSession(senderId: number, session: WindowSession): Promise<void> {
    this.emit('window-profile-changing', {senderId})
    if (session.closing) return session.closing
    const operation = (async () => {
      await this.attachedBrowserHost?.releaseWindow(session.sender)
      await session.client.awaitCommandShutdown(30_000)
      await session.client.close()
      this.windowEventUnsubs.get(senderId)?.()
      this.windowEventUnsubs.delete(senderId)
      if (this.windowSessions.get(senderId) === session) this.windowSessions.delete(senderId)
      if (!session.sender.isDestroyed()) session.detachDestroyed?.()
    })()
    session.closing = operation
    void operation.catch(() => { if (session.closing === operation) session.closing = undefined })
    return operation
  }

  private waitForConnection(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (
      this.state === 'failed' &&
      (this.reconnectAttempts >= this.maxReconnect ||
        (this.disableAutoStart && !this.managedDaemon))
    ) {
      return Promise.reject(linkError('reconnect_unavailable', 'MMS reconnect is unavailable'))
    }
    const timeoutMs = Math.max(this.requestTimeoutMs ?? 0, SERVICE_START_TIMEOUT_MS)
    return new Promise<void>((resolve, reject) => {
      const onState = (state: GuiMmsConnectionState): void => {
        if (state === 'ready' && this.connected) finish()
        else if (state === 'stopped') finish(linkError('stopped', 'GuiMmsController is stopped'))
        else if (
          state === 'failed' &&
          (this.reconnectAttempts >= this.maxReconnect ||
            (this.disableAutoStart && !this.managedDaemon))
        ) {
          finish(linkError('reconnect_failed', 'MMS reconnect failed'))
        }
      }
      const timer = setTimeout(() => {
        finish(linkError('reconnect_timeout', `MMS reconnect timed out after ${timeoutMs}ms`))
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

  /**
   * The flag is cleared when the snapshot starts, not when it returns: until then every event that
   * arrives would ask for another snapshot, and a gap seen while this one runs needs a later one.
   */
  async snapshotThread(threadId: string): Promise<ThreadSnapshotResult> {
    const client = this.client
    const needed = client?.requiresResnapshot === true
    client?.clearResnapshotFlag()
    try {
      return await this.request<ThreadSnapshotResult>('thread.snapshot', { threadId, newest: GUI_SNAPSHOT_NEWEST })
    } catch (error) {
      if (needed) client?.markResnapshotNeeded()
      throw error
    }
  }

  /** Snapshot through one window's profile-bound session after an event gap; clears the flag like `snapshotThread`. */
  async snapshotThreadForSender(senderId: number, threadId: string): Promise<ThreadSnapshotResult> {
    const session = this.windowSessions.get(senderId)
    if (!session || !session.client.connected) throw linkError('window_not_connected', 'Window MMS session is not connected')
    const needed = session.client.requiresResnapshot
    session.client.clearResnapshotFlag()
    try {
      return await session.client.request<ThreadSnapshotResult>('thread.snapshot', { threadId, newest: GUI_SNAPSHOT_NEWEST })
    } catch (error) {
      if (needed) session.client.markResnapshotNeeded()
      throw error
    }
  }

  /**
   * What every thread is doing, through one window's profile-bound session, with where the answer stands among the
   * window's updates (`ReadOrder`). With `clearsGap` this read is the window's whole resnapshot (no thread is open), so
   * it clears the gap flag like `snapshotThreadForSender`.
   */
  async activityForSender(senderId: number, clearsGap = false): Promise<WindowActivity> {
    const session = this.windowSessions.get(senderId)
    if (!session || !session.client.connected) throw linkError('window_not_connected', 'Window MMS session is not connected')
    const needed = clearsGap && session.client.requiresResnapshot
    if (clearsGap) session.client.clearResnapshotFlag()
    const instance = session.client.hello?.instanceId
    try {
      const result = await session.client.request<{ activity?: ThreadActivitySnapshot; revision?: number }>('activity.snapshot')
      const activity = result?.activity
      if (!activity || typeof activity !== 'object' || Array.isArray(activity)) throw new Error('activity.snapshot returned no activity')
      return { activity, ...readOrder(instance, undefined, result?.revision) }
    } catch (error) {
      if (needed) session.client.markResnapshotNeeded()
      throw error
    }
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
      throw linkError('service_not_ready',
        formatOwnerBusyMessage(owner.record, owner.heldUnreadable) +
          ' (owner live but runtime readiness not published)'
      )
    }

    if (owner.heldUnreadable) {
      throw linkError('owner_unreadable', formatOwnerBusyMessage(null, true))
    }

    // Dev script / tests own the daemon: poll until ready, never spawn a second process.
    if (this.disableAutoStart) {
      this.setState('connecting')
      const record = await pollUntilRuntimeReady(this.homeDir, {
        timeoutMs: SERVICE_START_TIMEOUT_MS,
        intervalMs: SERVICE_POLL_INTERVAL_MS
      })
      if (record) return record
      throw linkError(this.managedDaemon ? 'service_not_ready' : 'service_not_running',
        this.managedDaemon
          ? `MMS daemon is not ready (managed by npm run dev). Waited ${SERVICE_START_TIMEOUT_MS}ms.`
          : 'MMS daemon is not running and auto-start is disabled'
      )
    }

    this.assertMayConnect()
    this.setState('starting_daemon')
    const child = await this.spawnDaemon()
    const record = await this.waitForSpawnedDaemon(child)
    if (!record) {
      throw linkError('service_start_timeout',
        `MMS daemon failed to become ready within ${GUI_DAEMON_START_TIMEOUT_MS}ms. ` +
          `Startup details were written to ${join(this.homeDir, 'mms-startup.log')}`
      )
    }
    return record
  }

  private async spawnDaemon(): Promise<ChildProcess> {
    this.assertMayConnect()
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
    const { command, argsPrefix, env } = daemonCommand({
      execPath: process.execPath,
      platform: process.platform,
      electron: Boolean(process.versions.electron),
      env: process.env,
      host
    })
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
        throw linkError('service_exited',
          `MMS daemon exited before readiness (code ${child.exitCode ?? 'none'}, ` +
            `signal ${child.signalCode ?? 'none'}).${detail}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, SERVICE_POLL_INTERVAL_MS))
    }
    return null
  }

  private async connectOnce(): Promise<ProtocolHelloOk> {
    this.assertMayConnect()
    this.setState('connecting')

    const owner = readOwnerRecord(this.homeDir)
    if (!owner) {
      throw linkError('owner_record_missing', 'MMS owner record missing after readiness')
    }
    const token = this.ownerTokenOverride ?? owner.token
    const endpoint = this.resolveEndpoint(owner)

    const client = new LocalMmsClient({
      homeDir: this.homeDir,
      ownerToken: token,
      endpoint,
      clientType: 'gui',
      requestedCapabilities: [...GUI_PLATFORM_CAPABILITIES],
      requestTimeoutMs: this.requestTimeoutMs,
      // Views of a window ask the same reads at the same moment; one request answers them all (#420).
      shareIdenticalReads: true
    })

    try {
      const hello = await connectGuiClient(client, this.homeDir)
      this.assertMayConnect()

      this.detachEventHandlers()
      const previous = this.client
      if (previous && previous !== client) {
        this.client = null
        await previous.close().catch(() => undefined)
      }
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

      const subscribed = await client.subscribe(client.lastKnownSequence > 0 ? client.lastKnownSequence : 0)
      this.assertMayConnect()
      this.log('service.connected', {
        instance: hello.instanceId,
        serverVersion: hello.serverVersion,
        sequence: subscribed.sequence,
        gap: client.requiresResnapshot
      })
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
      if (this.client === client) {
        this.client = null
        this.detachEventHandlers()
      }
      // After stop, the failure is stop's doing: stay stopped.
      if (!this.quitting && !this.installing) this.enterFailed(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  private watchDisconnect(client: LocalMmsClient): void {
    // Single disconnect poll interval — cleared on stop/replace to avoid leaks.
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer)
      this.disconnectTimer = null
    }
    this.disconnectUnsub?.()
    // The close is acted on at once; the one-second check stays for a close that raised nothing.
    this.disconnectUnsub = client.onConnectionClosed(() => {
      if (this.client === client) this.mainConnectionLost('closed')
    })
    this.disconnectTimer = setInterval(() => {
      if (this.quitting || this.installing || this.client !== client) return
      this.mainConnectionLost('check')
    }, 1000)
  }

  private scheduleReconnect(reason: string): void {
    if (this.quitting || this.installing) return
    if (this.reconnectTimer || this.reconnecting) return
    if (this.reconnectAttempts >= this.maxReconnect) {
      this.enterFailed(linkError('reconnect_exhausted', `MMS reconnect exhausted after ${reason}`))
      return
    }
    this.setState('reconnecting')
    const attempt = this.reconnectAttempts++
    const delay = Math.min(30_000, this.reconnectBaseMs * Math.pow(2, attempt))
    this.log('service.reconnect-scheduled', { reason, attempt: attempt + 1, delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect(reason)
    }, delay)
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.quitting || this.installing || this.reconnecting) return
    // A request made before the first start schedules a reconnect, whose timer can fire while start() still waits for
    // the service it spawned. Run beside it, the reconnect would find no service yet and start a second one (which
    // fails: the first owns the home), or close the client the start just opened. It waits for the start instead, and
    // is not needed once the start connected.
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    if (this.connected || this.quitting || this.installing || this.reconnecting || this.startPromise) return
    const attempt = this.attemptReconnect(reason)
    this.reconnecting = attempt
    let retry = false
    try {
      retry = await attempt
    } finally {
      if (this.reconnecting === attempt) this.reconnecting = null
    }
    if (retry) this.scheduleReconnect('reconnect_failed')
    else if (this.gaveUp) this.parkWindowReopens()
  }

  /** One reconnect attempt. Resolves true when another attempt should be scheduled. */
  private async attemptReconnect(reason: string): Promise<boolean> {
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
      this.log('service.restored', { reason, instance: hello.instanceId, windows: this.windowSessions.size })
      // Everything a restart needs happens here, on every reconnect: the windows are told the service restarted and
      // their lists are read again (`resnapshot`), and every window whose connection was lost is opened again.
      this.emit('resnapshot', { reason: `reconnect:${reason}`, hello })
      this.reopenWindowsAfterService()
      return false
    } catch (err) {
      if (this.quitting || this.installing) return false
      this.log('service.reconnect-failed', { reason, error: describeLinkError(err) })
      // Tests with auto-start off fail fast; managed daemon keeps retrying while dev restarts MMS.
      if (this.disableAutoStart && !this.managedDaemon) {
        this.enterFailed(err instanceof Error ? err : new Error(String(err)))
        return false
      }
      this.reportError(err instanceof Error ? err : new Error(String(err)))
      return true
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
    this.disconnectUnsub?.()
    this.disconnectUnsub = null
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
