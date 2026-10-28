import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption } from '../../../shared/settings'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { LoginSession } from '../../providers/LoginSession'
import { CURSOR_CAPABILITIES, CursorAdapter, type CursorTurnClient } from '../../run/adapters/cursor/CursorAdapter'
import { CursorHostCallError, CursorHostClient, defaultCursorHostScript, spawnCursorHost, type CursorHostTransport } from '../cursor/hostClient'
import { CURSOR_DEFAULT_MODEL, CursorSessions, type SavedCursorAgent } from '../cursor/session'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type LiveProcessHost } from '../driver'
import type { CursorModel } from '../hosts/cursorProtocol'
import { InstanceVault } from '../vault'

/**
 * Cursor through `@cursor/sdk`, hosted out of process (`hosts/cursorHost.ts`): one host per
 * instance, started on first use. Every instance is its own account: its key lives in Mousse's
 * vault (an account sign-in mints one; an API key the user pastes wins over it), and its agents in
 * `<stateDir>/cursor-store`, so nothing reads `~/.cursor/sdk` or an ambient `CURSOR_API_KEY`.
 *
 * Cursor approves its tools itself (Auto-review), so the instance is `uncontrolled`: interactive
 * turns only, with a one-time notice per thread.
 */

export const CURSOR_LABEL = 'Cursor'

export const CURSOR_CAPS: HarnessCaps = Object.freeze({
  ...CURSOR_CAPABILITIES,
  // `mode: 'plan'` on the SDK.
  planMode: true,
  // Usage per turn, but no context window.
  contextUsage: 'none',
  toolControl: 'uncontrolled',
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/**
 * Every settings layer the Cursor CLI loads (project and user rules, skills, hooks and MCP servers,
 * team and admin policy, plugins): the SDK loads none of them unless asked, and Cursor should run
 * as the user set it up.
 */
export const CURSOR_SETTING_SOURCES = ['project', 'user', 'team', 'mdm', 'plugins'] as const

/** "Sign in again" is offered this long before an account key expires. */
export const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000
const ME_TIMEOUT_MS = 15_000

/** Sign-in methods, in the order they are offered. */
export const CURSOR_SIGN_IN_METHODS = [
  { id: 'account', label: 'Sign in with your Cursor account', description: 'Opens cursor.com in your browser. Mousse keeps the key it gets for this entry only.' },
  { id: 'api_key', label: 'API key', description: 'A key from cursor.com/dashboard. It wins over an account sign-in.' }
] as const

/** What `<stateDir>/cursor.json` keeps (no secrets: those are in `secrets.json`). */
interface CursorState {
  sessions?: Record<string, SavedCursorAgent>
  models?: LlmModelOption[]
  /** ISO time `models` was last listed by Cursor. */
  modelsRefreshedAt?: string
  /** Cursor refused the saved credential during a turn. */
  refused?: boolean
  /** The user signed out here: the minted key is not revoked on Cursor's side. */
  signedOutHere?: boolean
}

/** Vault entries. */
const SECRET = {
  apiKey: 'apiKey',
  apiKeySubject: 'apiKeySubject',
  accountKey: 'accountKey',
  accountExpiresAt: 'accountExpiresAtMs',
  accountSubject: 'accountSubject'
} as const

export interface CursorDriverOptions {
  /** Test seam: the host transport (a replay or a fake) instead of the built host entry. */
  connect?: (context: DriverContext) => CursorHostTransport
  /** The built host entry (default: `cursorHost.js` beside this bundle). */
  hostScript?: string
  /** Extra variables for the host process (tests point it at a fake SDK module). */
  hostEnv?: NodeJS.ProcessEnv
  now?: () => number
  /** Test seam: how long a cancel may take before the host is ended. */
  cancelDeadlineMs?: number
  /** Test seam: how long reopening a saved agent may take. */
  loadDeadlineMs?: number
}

/** The account a key belongs to, without the key itself: an HMAC when Cursor cannot say. */
export function cursorKeySubject(apiKey: string, user?: { userId?: number }): string {
  if (typeof user?.userId === 'number') return `cursor-user:${user.userId}`
  return `cursor-key:${createHmac('sha256', 'mousse-cursor-key').update(apiKey).digest('hex')}`
}

function modelOptions(models: readonly CursorModel[]): LlmModelOption[] {
  const seen = new Set<string>()
  const options: LlmModelOption[] = []
  for (const model of models) {
    if (!model?.id || model.id === CURSOR_DEFAULT_MODEL || seen.has(model.id)) continue
    seen.add(model.id)
    options.push({ id: model.id, label: model.displayName || model.id })
  }
  return options
}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cursor did not answer in time.')), ms)
    timer.unref?.()
    const abort = () => reject(new Error('Cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    })
  })
}

export function cursorDriver(options: CursorDriverOptions = {}): HarnessDriver {
  return {
    kind: 'cursor',
    label: CURSOR_LABEL,
    // Hosted by Mousse with the bundled SDK: nothing to find on PATH or install.
    binaryNames: [],
    multiInstance: true,
    // Every instance is private already: its key and its agents are its own.
    privateHome: false,
    canInstall: false,
    customModels: false,
    methodLabel: 'Cursor account or API key',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => CURSOR_CAPS,
    versionArgs: () => null,
    updateCommand: () => undefined,
    create: (context) => createCursorRuntime(context, options)
  }
}

function createCursorRuntime(context: DriverContext, options: CursorDriverOptions): DriverRuntime {
  const now = options.now ?? Date.now
  const label = context.config.displayName ?? CURSOR_LABEL
  const statePath = join(context.stateDir, 'cursor.json')
  const vault = new InstanceVault(join(context.stateDir, 'secrets.json'))
  let state: CursorState = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as CursorState
  } catch {
    // No state yet.
  }
  const save = () => {
    mkdirSync(context.stateDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(statePath, state, { mode: 0o600 })
  }
  let liveHost: LiveProcessHost | null = null
  /** Bumped by every sign-in start and cancel: a login that finishes under an older one is dropped. */
  let loginGeneration = 0

  const hostScript = options.hostScript ?? (options.connect ? undefined : defaultCursorHostScript())
  const host = new CursorHostClient(() => {
    if (options.connect) return options.connect(context)
    if (!hostScript) throw new Error(`${label} cannot start: this build of Mousse has no Cursor host.`)
    return spawnCursorHost(context.env, hostScript, options.hostEnv)
  })

  const secret = (name: string): string | undefined => {
    try {
      return vault.get(name)
    } catch (error) {
      console.warn('[harness] cursor secrets unreadable', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }
  const accountExpiresAt = (): number | undefined => {
    const raw = secret(SECRET.accountExpiresAt)
    const value = raw ? Number(raw) : NaN
    return Number.isFinite(value) ? value : undefined
  }
  const accountUsable = (): boolean => {
    if (!secret(SECRET.accountKey)) return false
    const expires = accountExpiresAt()
    return expires === undefined || expires > now()
  }
  /** The credential turns, models and identity use: a pasted API key wins over the account's key. */
  const effective = (): { kind: 'api_key' | 'account'; key: string; subject?: string } | undefined => {
    const apiKey = secret(SECRET.apiKey)
    if (apiKey) return { kind: 'api_key', key: apiKey, ...(secret(SECRET.apiKeySubject) ? { subject: secret(SECRET.apiKeySubject)! } : {}) }
    const accountKey = secret(SECRET.accountKey)
    if (accountKey && accountUsable()) return { kind: 'account', key: accountKey, ...(secret(SECRET.accountSubject) ? { subject: secret(SECRET.accountSubject)! } : {}) }
    return undefined
  }

  const sessions = new CursorSessions({
    label,
    host,
    storeDir: join(context.stateDir, 'cursor-store'),
    apiKey: () => (state.refused ? undefined : effective()?.key),
    settingSources: CURSOR_SETTING_SOURCES,
    store: {
      saved: (threadId) => state.sessions?.[threadId],
      threads: () => Object.keys(state.sessions ?? {}),
      setSaved: (threadId, saved) => {
        if (saved) state.sessions = { ...state.sessions, [threadId]: saved }
        else if (state.sessions) {
          const { [threadId]: _dropped, ...rest } = state.sessions
          state.sessions = rest
        }
        save()
      }
    },
    markSignedOut: () => {
      if (state.refused) return
      state.refused = true
      save()
      context.changed()
    },
    signInRequiredMessage: `Sign in to ${label} in Settings → Providers before chatting`,
    notice: (threadId, text) => liveHost?.notice?.(threadId, text),
    ...(options.cancelDeadlineMs !== undefined ? { cancelDeadlineMs: options.cancelDeadlineMs } : {}),
    ...(options.loadDeadlineMs !== undefined ? { loadDeadlineMs: options.loadDeadlineMs } : {})
  })

  /** Who a key belongs to: `me`, or the key's HMAC when Cursor cannot be asked. Throws when Cursor refuses the key. */
  const subjectOf = async (apiKey: string, signal?: AbortSignal): Promise<string> => {
    try {
      return cursorKeySubject(apiKey, await withTimeout(host.request('me', { apiKey }), ME_TIMEOUT_MS, signal))
    } catch (error) {
      if (error instanceof CursorHostCallError && error.auth) throw new Error('Cursor refused this key.')
      signal?.throwIfAborted()
      return cursorKeySubject(apiKey)
    }
  }

  const refreshModels = async (): Promise<void> => {
    const credential = effective()
    if (!credential) throw new Error(`Sign in to ${label} first.`)
    const { models } = await host.request('models', { apiKey: credential.key })
    state.models = modelOptions(models)
    state.modelsRefreshedAt = new Date().toISOString()
    save()
  }

  /** A key saved for this instance: the account generation moves on, and the old agents go. */
  const credentialChanged = () => {
    // Agents made under another key are not resumed: they leave the store.
    sessions.forgetAll()
    state.sessions = {}
    delete state.refused
    delete state.signedOutHere
    save()
    void refreshModels().catch(() => undefined)
  }

  const saveApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
    const key = apiKey.trim()
    if (!key) throw new Error('Paste a Cursor API key.')
    const subject = await subjectOf(key, signal)
    signal?.throwIfAborted()
    vault.set(SECRET.apiKey, key)
    vault.set(SECRET.apiKeySubject, subject)
    credentialChanged()
  }

  const reading = (): AuthReading => {
    const credential = effective()
    const canSignIn = { canSignIn: true, ownedByMousse: true }
    if (state.refused && credential)
      return { state: 'signed_out', methodLabel: credential.kind === 'api_key' ? 'API key' : 'Cursor account', message: `Cursor refused the saved ${credential.kind === 'api_key' ? 'API key' : 'sign-in'}. Sign in again.`, ...canSignIn }
    if (!credential) {
      if (secret(SECRET.accountKey)) return { state: 'expired', methodLabel: 'Cursor account', message: 'Your Cursor sign-in expired.', ...canSignIn }
      return {
        state: 'signed_out',
        methodLabel: 'Cursor account or API key',
        ...(state.signedOutHere ? { message: 'Signed out. The key Mousse got from Cursor stays valid until it expires; revoke it at cursor.com/dashboard if you need to.' } : {}),
        ...canSignIn
      }
    }
    const expires = credential.kind === 'account' ? accountExpiresAt() : undefined
    const renew = expires !== undefined && expires - now() < RENEW_BEFORE_MS
    return {
      state: 'signed_in',
      methodLabel: credential.kind === 'api_key' ? 'API key' : 'Cursor account',
      ...(credential.subject ? { subject: credential.subject } : {}),
      ...(renew ? { message: `Your Cursor sign-in ends on ${new Date(expires!).toISOString().slice(0, 10)}. Sign in again to renew it.` } : {}),
      ...canSignIn
    }
  }

  const signInAccount = async (session: LoginSession): Promise<ProviderLoginResult> => {
    const generation = ++loginGeneration
    const loginId = randomUUID()
    host.watchLogin(loginId, (url) => session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url, usesCallbackServer: false }))
    const cancel = () => {
      loginGeneration += 1
      void host.request('loginCancel', { loginId }).catch(() => undefined)
    }
    session.abort.signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await host.request('login', { loginId })
      // A success that arrives after a cancel (or after a newer sign-in started) changes nothing.
      if (session.abort.signal.aborted || generation !== loginGeneration) throw new Error('Login cancelled')
      const subject = await subjectOf(result.apiKey, session.abort.signal)
      if (session.abort.signal.aborted || generation !== loginGeneration) throw new Error('Login cancelled')
      vault.set(SECRET.accountKey, result.apiKey)
      vault.set(SECRET.accountSubject, subject)
      vault.set(SECRET.accountExpiresAt, result.apiKeyExpiresAtMs !== undefined ? String(result.apiKeyExpiresAtMs) : undefined)
      credentialChanged()
      return { success: true, sessionId: session.sessionId }
    } finally {
      session.abort.signal.removeEventListener('abort', cancel)
      host.watchLogin(loginId, undefined)
    }
  }

  const signIn = async (session: LoginSession, _cwd: string, method?: string): Promise<ProviderLoginResult> => {
    try {
      let chosen = CURSOR_SIGN_IN_METHODS.find((entry) => entry.id === method)?.id
      if (!chosen) {
        const picked = await session.createAuthCallbacks().prompt({
          type: 'select',
          message: `How do you sign in to ${label}?`,
          options: CURSOR_SIGN_IN_METHODS.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))
        })
        chosen = CURSOR_SIGN_IN_METHODS.find((entry) => entry.id === picked)?.id
        if (!chosen) throw new Error('Choose a sign-in method.')
      }
      if (chosen === 'account') return await signInAccount(session)
      const key = await session.createAuthCallbacks().prompt({ type: 'secret', message: 'Paste a Cursor API key (cursor.com/dashboard → API keys).', placeholder: 'key_…' })
      await saveApiKey(key, session.abort.signal)
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return {
        success: false,
        sessionId: session.sessionId,
        error: session.abort.signal.aborted ? 'Login cancelled' : error instanceof Error ? error.message : String(error)
      }
    }
  }

  const client: CursorTurnClient = {
    chat: (input) => sessions.chat(input),
    commitConversation: (threadId, history) => sessions.commitConversation(threadId, history),
    configured: () => runtime.configured(),
    interrupt: (agentId) => sessions.interrupt(agentId)
  }
  const adapter = new CursorAdapter(() => client, label)

  const runtime: DriverRuntime = {
    adapter,
    configured: () => Boolean(effective()) && !state.refused && Boolean(options.connect || hostScript),
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    models: () => [{ id: CURSOR_DEFAULT_MODEL, label: 'Auto' }, ...(state.models ?? [])],
    auth: async ({ force, signal }) => {
      // Recheck asks Cursor who the key belongs to; periodic checks read the stored answer.
      const credential = effective()
      if (force && credential && !state.refused) {
        try {
          const subject = cursorKeySubject(credential.key, await withTimeout(host.request('me', { apiKey: credential.key }), ME_TIMEOUT_MS, signal))
          vault.set(credential.kind === 'api_key' ? SECRET.apiKeySubject : SECRET.accountSubject, subject)
        } catch (error) {
          if (error instanceof CursorHostCallError && error.auth) {
            state.refused = true
            save()
          }
        }
      }
      return reading()
    },
    // Read at every admission, without a network call: the subject saved with the key.
    identity: async () => (state.refused ? undefined : effective()?.subject),
    refreshModels: async () => refreshModels(),
    modelsRefreshedAt: () => (state.models?.length ? state.modelsRefreshedAt : undefined),
    signIn,
    signOut: async () => {
      loginGeneration += 1
      sessions.forgetAll()
      vault.clear()
      state = {
        signedOutHere: true,
        ...(state.models ? { models: state.models } : {}),
        ...(state.modelsRefreshedAt ? { modelsRefreshedAt: state.modelsRefreshedAt } : {})
      }
      save()
    },
    adoptApiKey: (apiKey) => saveApiKey(apiKey),
    forgetConversation: (threadId) => sessions.forgetConversation(threadId),
    terminate: (ref) => sessions.terminate(ref.sessionId),
    setLiveHost: (next) => {
      liveHost = next
    },
    stop: () => sessions.stop()
  }
  return runtime
}
