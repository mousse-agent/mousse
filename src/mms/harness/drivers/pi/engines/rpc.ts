import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessCaps } from '../../../../../shared/harness/types'
import type { DriverContext, DriverRuntime, LiveProcessHost } from '../../../driver'
import { PiRpcEngine, type PiEngineCatalog, type PiMousseTool, type PiRpcEngineOptions } from '../../../pi/engine'
import type { PiRuntimePaths } from '../../../pi/launch'
import type { PiOAuthSource } from '../../../pi/oauthBroker'
import { piShellPath } from '../../../pi/settings'
import { piInstanceRuntime, type PiCredentials } from './legacy'

/**
 * Pi's agent as its own process (PR 2 §4): a `pi:*` instance the user switched to it (Advanced →
 * Engine: New engine), except the legacy-only providers (`../engines.ts`).
 *
 * - Containment and tool control stay `weak`/`approval_only` until the evidence suite passes on the
 *   whole execution profile: Mousse sees and can refuse every call, but does not run the tools.
 * - `budgets: 'hard'`: every model request is charged through the guarded request wrapper
 *   (`/pi/request`) and every tool call at the gate, and the next one is refused before it starts
 *   once a turn or tool-call limit is reached.
 * - `spendLimits: 'reserved'`: under a token or USD limit every request is reserved first at its
 *   final wire cap, sized to fit what is left, and its final payload is checked before it is sent
 *   (PR 4 §5b). A model whose API does not always send the cap, or an unpriced model under a USD
 *   limit, or an effort whose smallest request cannot fit the limit, is refused at admission
 *   (`spendModel`).
 * - `fork: 'native'`: the engine branches the Pi session and binds the branch to the fork's thread,
 *   whose first turn resumes it; when it cannot (a turn before 2c, a stopped one), the fork hands
 *   the history over.
 */
export const PI_RPC_CAPS: HarnessCaps = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'native',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  childPolicy: 'enforced',
  planMode: true,
  contextUsage: 'reported',
  toolControl: 'approval_only',
  budgets: 'hard',
  spendLimits: 'reserved'
})

/** What the RPC engine needs from the profile. */
export interface PiRpcDriverOptions {
  /** The packaged runtime (`piRuntimePaths(applicationRoot)`). */
  runtime(): PiRuntimePaths
  /** The instance provider's full Mousse catalogue and its revision. */
  catalog(providerId: string): PiEngineCatalog
  /** The stored key of a provider, if it has one. */
  apiKey?(providerId: string): string | undefined
  /** Mousse's tools for a thread, with their class. */
  mousseTools?(threadId: string): PiMousseTool[]
  /**
   * Ids the provider's stored credential carries beside its key (Cloudflare's account and gateway
   * ids): they reach the child's environment, never a credential.
   */
  credentialEnv?(providerId: string): Readonly<Record<string, string>> | undefined
  /**
   * The stable subject of the credential the instance runs with (`apikey:`, `oauth:`, `ambient:`;
   * already one-way), for the gateway's account fence; undefined when it cannot be established.
   */
  identity?(providerId: string): string | undefined | Promise<string | undefined>
  /** Mousse's OAuth credentials for pi-ai's OAuth providers (`piOAuthBroker(providerAuth)`); Mousse is the only refresher. */
  oauth?: PiOAuthSource
  /** Test seams passed through to the engine. */
  engine?: Partial<Pick<PiRpcEngineOptions, 'warmMs' | 'readyDeadlineMs' | 'commandDeadlineMs' | 'settings' | 'host' | 'adjustLaunch' | 'onCommand' | 'testEnv'>>
}

export function createRpcRuntime(context: DriverContext, providerId: string, label: string, credentials: () => PiCredentials | undefined, options: PiRpcDriverOptions): DriverRuntime {
  const capabilities = PI_RPC_CAPS
  const notice = engineNotice(context, label)
  const engine = new PiRpcEngine({
    instanceId: context.instanceId,
    provider: providerId,
    label,
    capabilities: {
      steer: capabilities.steer,
      interrupt: capabilities.interrupt,
      rollback: capabilities.rollback,
      fork: capabilities.fork,
      events: capabilities.events,
      containment: capabilities.containment,
      historyInjection: capabilities.historyInjection,
      mcp: capabilities.mcp,
      childPolicy: capabilities.childPolicy
    },
    env: () => context.env,
    stateDir: context.stateDir,
    runtime: () => options.runtime(),
    catalog: () => options.catalog(providerId),
    ...(options.apiKey ? { apiKey: () => options.apiKey!(providerId) } : {}),
    ...(options.oauth ? { oauth: options.oauth } : {}),
    extraEnv: () => ({ ...(options.credentialEnv?.(providerId) ?? {}), ...(context.config.env ?? {}) }),
    shellPath: () => piShellPath({ env: context.env.env }),
    ...(options.mousseTools ? { mousseTools: (threadId: string) => options.mousseTools!(threadId) } : {}),
    // A new session seeded with the chat's history tells the thread (`history_injected`).
    notice: (threadId, { message }) => notice.send(threadId, message),
    ...options.engine
  })
  // The first turn of the instance on this engine says so, once (PR 2 §5, "Engine notice").
  const startTurn: PiRpcEngine['startTurn'] = (input, ...rest) => {
    notice.show(input.threadId)
    return engine.startTurn(input, ...rest)
  }
  // Every other member is the engine's own, bound to it.
  const adapter = new Proxy(engine, {
    get: (target, property) => {
      if (property === 'startTurn') return startTurn
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
  })
  const base = piInstanceRuntime(context.instanceId, providerId, credentials, adapter)
  const credential = credentialChanges(engine, () => options.identity?.(providerId), Boolean(options.identity))
  return {
    ...base,
    spendModel: (model) => engine.spendModel(model),
    setLiveHost: (host) => notice.setHost(host),
    ...(options.identity ? { identity: () => credential.read() } : {}),
    // A sign-in that succeeded, a sign-out or another surface's change, compared by the credential's
    // subject: an OAuth sign-in, sign-out or account change retires every process with what it held
    // (handle, auth.json); a key or ambient change lets running turns finish.
    ...(base.signIn
      ? {
          signIn: async (...args: Parameters<NonNullable<DriverRuntime['signIn']>>) => {
            await credential.prime()
            const result = await base.signIn!(...args)
            if (result.success) await credential.changed()
            return result
          }
        }
      : {}),
    signOut: async () => {
      await credential.prime()
      try {
        await base.signOut?.()
      } finally {
        await credential.changed()
      }
    },
    credentialsChanged: () => credential.changed(),
    forgetConversation: (threadId) => engine.forgetConversation(threadId),
    terminate: (ref) => engine.terminate(ref),
    stop: () => engine.stop()
  }
}

/**
 * What a credential change does to the engine, from the credential's subject before and after
 * (`identity`). Without an identity source every change retires (nothing can be compared).
 */
function credentialChanges(engine: PiRpcEngine, subject: () => string | undefined | Promise<string | undefined>, comparable: boolean) {
  /**
   * The subject the engine's processes were started under. Only a transition moves it on, and every
   * transition is applied as it is seen, by whichever read sees it first (a turn's identity read
   * during another surface's change included), so a later notification never compares new with new.
   */
  let baseline: { subject: string | undefined } | undefined
  const current = async (): Promise<string | undefined> => {
    try {
      return await subject()
    } catch {
      return undefined
    }
  }
  const apply = (before: string | undefined, after: string | undefined): Promise<void> => {
    if (before?.startsWith('oauth:') || after?.startsWith('oauth:')) return engine.retireCredentials()
    engine.releaseIdle()
    return Promise.resolve()
  }
  /** Records `value`; a different one than the baseline is a change, applied now. */
  const observe = (value: string | undefined): Promise<void> => {
    if (!baseline) {
      baseline = { subject: value }
      return Promise.resolve()
    }
    if (baseline.subject === value) return Promise.resolve()
    const before = baseline.subject
    baseline = { subject: value }
    return apply(before, value)
  }
  return {
    /** A turn's identity read: a change it sees is applied (a turn of the new credential waits for the retirement). */
    read: async (): Promise<string | undefined> => {
      const value = await current()
      void observe(value).catch(() => {})
      return value
    },
    /** Sets the baseline before a sign-in or sign-out, when nothing was read yet. */
    prime: async (): Promise<void> => {
      if (!baseline) baseline = { subject: await current() }
    },
    /** After a sign-in, sign-out or another surface's change: applies it if the subject moved. */
    changed: async (): Promise<void> => {
      if (!comparable) return engine.retireCredentials()
      await observe(await current())
    }
  }
}

/** File in the instance's state dir that records the engine notice was shown. */
export const ENGINE_NOTICE_FILE = 'engine-notice.json'

/**
 * The one-time notice that an instance now runs on Pi's agent: shown on its first RPC turn and
 * recorded in the instance's state dir, so it never shows again (a removed instance starts over).
 */
function engineNotice(context: DriverContext, label: string): { show(threadId: string): void; send(threadId: string, text: string): void; setHost(host: LiveProcessHost | null): void } {
  let host: LiveProcessHost | null = null
  const path = join(context.stateDir, ENGINE_NOTICE_FILE)
  let shown = existsSync(path)
  return {
    send: (threadId, text) => {
      try {
        host?.notice?.(threadId, text)
      } catch (error) {
        console.warn('[harness] notice failed', error instanceof Error ? error.message : String(error))
      }
    },
    setHost: (next) => {
      host = next
    },
    show: (threadId) => {
      if (shown || !host?.notice) return
      shown = true
      try {
        mkdirSync(context.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(path, `${JSON.stringify({ engine: 'rpc', shownAt: new Date().toISOString() })}
`, { mode: 0o600 })
      } catch (error) {
        console.warn('[harness] could not record the engine notice', error instanceof Error ? error.message : String(error))
      }
      try {
        host.notice(threadId, `${label} now runs on Pi's agent, so its tools and replies may differ slightly. To switch back: Providers → ${label} → Advanced → Engine: Legacy.`)
      } catch (error) {
        console.warn('[harness] notice failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
}
