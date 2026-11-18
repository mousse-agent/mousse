import { connect, type LookupFunction, type Socket } from 'node:net'

/**
 * Whether a bot's provider can be reached (docs/bots.md, "No internet"): a cheap check the engine
 * makes before a dispatch starts, while one makes no progress, and while an activation waits. It
 * never calls a model API: a DNS lookup and a TCP connection to port 443, of the provider's API
 * host and of two well-known hosts. Any one that answers is enough.
 */
export interface BotConnectivity {
  /** Never throws: an error is "offline". `fresh` probes again instead of reusing a recent result. */
  online(input: { instanceId?: string; fresh?: boolean }): Promise<boolean>
  /** How each host of the last round for the instance's provider ended, for the log. */
  lastProbes?(input: { instanceId?: string }): readonly BotProbe[]
}

/** How one host's probe ended: `ok`, `timeout`, or the connection's error code (`ENOTFOUND`, `ECONNREFUSED`, `error`). */
export type BotProbeOutcome = string

/** One host's probe in a round. */
export interface BotProbe {
  host: string
  outcome: BotProbeOutcome
}

/** Hosts that are up whenever the internet is. */
export const GENERIC_PROBE_HOSTS: readonly string[] = ['www.google.com', 'cloudflare.com']

/** How long one host's lookup and connection may take. */
const PROBE_TIMEOUT_MS = 4_000
/** A result is reused this long, so a burst of checks makes one probe. */
const PROBE_CACHE_MS = 5_000

/** A provider's API host, `'local'` for one that runs on this computer (never probed), or undefined when not known. */
export type BotApiHost = string | 'local' | undefined

/** The API host of a provider entry from its driver and, for Pi, its provider id. */
export function botApiHost(driver: string | undefined, provider?: string): BotApiHost {
  if (driver === 'claude') return 'api.anthropic.com'
  if (driver === 'codex') return 'chatgpt.com'
  if (driver !== 'pi' || !provider) return undefined
  const id = provider.toLowerCase()
  if (/^(?:ollama|lmstudio|lm-studio|llamacpp|llama-cpp|local|vllm)/.test(id)) return 'local'
  const known: Record<string, string> = {
    anthropic: 'api.anthropic.com',
    openai: 'api.openai.com',
    'openai-codex': 'chatgpt.com',
    openrouter: 'openrouter.ai',
    google: 'generativelanguage.googleapis.com',
    gemini: 'generativelanguage.googleapis.com',
    xai: 'api.x.ai',
    mistral: 'api.mistral.ai',
    groq: 'api.groq.com',
    deepseek: 'api.deepseek.com',
    cerebras: 'api.cerebras.ai'
  }
  return known[id]
}

/**
 * One host: its name resolves and a TCP connection to port 443 opens, within the timeout. Every
 * address the name resolves to is tried, IPv6 and IPv4 interleaved (Happy Eyeballs), so a
 * computer whose IPv6 has no route still counts as online over IPv4.
 */
export async function probeHost(host: string, timeoutMs = PROBE_TIMEOUT_MS, options: { port?: number; lookup?: LookupFunction } = {}): Promise<boolean> {
  return (await probeHostOutcome(host, timeoutMs, options)) === 'ok'
}

/** `probeHost`, saying how it ended (`BotProbeOutcome`). */
export function probeHostOutcome(host: string, timeoutMs = PROBE_TIMEOUT_MS, options: { port?: number; lookup?: LookupFunction } = {}): Promise<BotProbeOutcome> {
  return new Promise<BotProbeOutcome>((resolve) => {
    let socket: Socket | undefined
    let settled = false
    const done = (outcome: BotProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.removeAllListeners()
      socket?.on('error', () => {})
      socket?.destroy()
      resolve(outcome)
    }
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    try {
      socket = connect({ host, port: options.port ?? 443, autoSelectFamily: true, ...(options.lookup ? { lookup: options.lookup } : {}) })
      socket.once('connect', () => done('ok'))
      socket.once('error', (error: NodeJS.ErrnoException) => done(errorCode(error)))
    } catch (error) {
      done(errorCode(error))
    }
  })
}

/** A short code for a failed connection: its errno code (`ENOTFOUND`), else `error`. */
function errorCode(error: unknown): BotProbeOutcome {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error'
}

/** True as soon as one probe answers true; false when every probe answered false. */
function anyOnline(checks: ReadonlyArray<Promise<boolean>>): Promise<boolean> {
  return new Promise((resolve) => {
    let left = checks.length
    if (!left) return resolve(false)
    for (const check of checks) {
      void check.then((ok) => ok, () => false).then((ok) => {
        if (ok) resolve(true)
        else if (--left === 0) resolve(false)
      })
    }
  })
}

/**
 * The daemon's connectivity check. `apiHost` names an instance's provider host; `probe` is the
 * per-host check (injectable for tests); results are reused for a few seconds unless a check
 * asks for a fresh round, which then replaces the kept one.
 */
export function createBotConnectivity(options: {
  apiHost(instanceId: string): BotApiHost
  probe?: (host: string) => Promise<BotProbeOutcome>
  now?: () => number
  cacheMs?: number
}): BotConnectivity {
  const probe = options.probe ?? ((host: string) => probeHostOutcome(host))
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? PROBE_CACHE_MS
  const cache = new Map<string, { at: number; result: Promise<boolean>; probes: BotProbe[] }>()
  const hostOf = (instanceId: string | undefined): BotApiHost => {
    try {
      return instanceId ? options.apiHost(instanceId) : undefined
    } catch {
      return undefined
    }
  }
  return {
    online: async ({ instanceId, fresh }) => {
      const host = hostOf(instanceId)
      if (host === 'local') return true
      const key = host ?? ''
      const cached = cache.get(key)
      if (!fresh && cached && now() - cached.at < cacheMs) return cached.result
      const hosts = [...new Set([...(host ? [host] : []), ...GENERIC_PROBE_HOSTS])]
      // Each host's outcome is kept as it comes in; a round that went offline has them all.
      const probes: BotProbe[] = []
      const result = anyOnline(hosts.map((name) => probe(name).catch(() => 'error').then((outcome) => {
        probes.push({ host: name, outcome })
        return outcome === 'ok'
      })))
      cache.set(key, { at: now(), result, probes })
      return result
    },
    lastProbes: ({ instanceId }) => {
      const host = hostOf(instanceId)
      return host === 'local' ? [] : [...(cache.get(host ?? '')?.probes ?? [])]
    }
  }
}

/**
 * Whether a run's error is a connection failure (the provider could not be reached), as the
 * orchestrator records it (`[provider_unavailable] …`) or as a runtime reports it.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== 'string' || !error) return false
  return /^\[provider_(?:unavailable|timeout)\]|\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ENETDOWN)\b|connection error|fetch failed|network error|socket hang up|unable to connect|getaddrinfo/i.test(error)
}
