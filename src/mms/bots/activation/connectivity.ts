import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'

/**
 * Whether a bot's provider can be reached (docs/bots.md, "No internet"): a cheap check the engine
 * makes before a dispatch starts, while one makes no progress, and while an activation waits. It
 * never calls a model API: a DNS lookup and a TCP connection to port 443, of the provider's API
 * host and of two well-known hosts. Any one that answers is enough.
 */
export interface BotConnectivity {
  /** Never throws: an error is "offline". */
  online(input: { instanceId?: string }): Promise<boolean>
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

/** One host: its name resolves and a TCP connection to port 443 opens, within the timeout. */
export async function probeHost(host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
  try {
    const address = await Promise.race([lookup(host).then((found) => found.address, () => undefined), timeout])
    if (!address) return false
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: address, port: 443, timeout: Math.max(1, deadline - Date.now()) })
      const done = (ok: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
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
 * per-host check (injectable for tests); results are reused for a few seconds.
 */
export function createBotConnectivity(options: {
  apiHost(instanceId: string): BotApiHost
  probe?: (host: string) => Promise<boolean>
  now?: () => number
  cacheMs?: number
}): BotConnectivity {
  const probe = options.probe ?? ((host: string) => probeHost(host))
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? PROBE_CACHE_MS
  const cache = new Map<string, { at: number; result: Promise<boolean> }>()
  return {
    online: async ({ instanceId }) => {
      let host: BotApiHost
      try {
        host = instanceId ? options.apiHost(instanceId) : undefined
      } catch {
        host = undefined
      }
      if (host === 'local') return true
      const key = host ?? ''
      const cached = cache.get(key)
      if (cached && now() - cached.at < cacheMs) return cached.result
      const hosts = [...new Set([...(host ? [host] : []), ...GENERIC_PROBE_HOSTS])]
      const result = anyOnline(hosts.map((name) => probe(name)))
      cache.set(key, { at: now(), result })
      return result
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
