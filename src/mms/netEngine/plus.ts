import { NetError } from '../../shared/net'
import type {
  NetEnginePlus,
  NetEngineRelayClass,
  NetEngineRemoval,
  NetEngineRemovalAsk,
  NetEngineRemovalHost
} from '../../shared/netEngine/local'
import { helperCode } from './helper/appChannel'
import type { EngineHelper } from './helper/connections'

type Json = Record<string, unknown>

/** What the helper's Plus failures read as (design A.2; the helper's own words for the rest). */
const PLUS_TEXT: Record<string, string> = {
  plus_off: "This build isn't set up for Plus.",
  not_linked: 'Sign in to Plus first.',
  unreachable: "Plus can't be reached. Try again later.",
  not_plus: 'No active Plus plan.',
  rate_limited: 'Too many tries. Wait a moment.'
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined

function pool(value: unknown): NetEnginePlus['bulk'] {
  const p = obj(value)
  if (!p) return undefined
  return {
    ...(num(p.allowance) !== undefined ? { allowance: num(p.allowance) } : {}),
    ...(num(p.available) !== undefined ? { available: num(p.available) } : {}),
    ...(num(p.debt) ? { debt: num(p.debt) } : {})
  }
}

function relayClass(value: unknown): NetEngineRelayClass | undefined {
  const c = obj(value)
  const state = str(c?.state)
  if (!c || (state !== 'funded' && state !== 'paused' && state !== 'unfunded')) return undefined
  return {
    state,
    bytesLeft: num(c.bytes_left) ?? 0,
    ...(num(c.lasts_secs) !== undefined ? { lastsSecs: num(c.lasts_secs) } : {}),
    ...(str(c.refill_error) ? { refillError: str(c.refill_error) } : {})
  }
}

function removal(value: unknown): NetEngineRemoval | undefined {
  const r = obj(value)
  if (!r || !str(r.id) || !str(r.host) || !str(r.removed) || !str(r.state)) return undefined
  return {
    id: str(r.id)!,
    host: str(r.host)!,
    removed: str(r.removed)!,
    name: str(r.name) ?? '',
    grant: num(r.grant) ?? 0,
    state: str(r.state)!,
    ...(str(r.result) ? { result: str(r.result) } : {})
  }
}

function ask(value: unknown): NetEngineRemovalAsk | undefined {
  const a = obj(value)
  if (!a || !str(a.identity) || !str(a.host) || num(a.grant) === undefined) return undefined
  return {
    identity: str(a.identity)!,
    name: str(a.name) ?? '',
    host: str(a.host)!,
    grant: num(a.grant)!
  }
}

/** A helper failure as the window shows it. */
function plusError(error: unknown): NetError {
  const code = helperCode(error)
  const text = code ? PLUS_TEXT[code] : undefined
  if (text) return new NetError(code === 'unreachable' ? 'route_unreachable' : 'forbidden', text)
  return error instanceof NetError ? error : new NetError('internal')
}

/**
 * Mousse Plus and "Remove on all my hosts" for one profile (Phase 4, M16 and M17): what the helper says on
 * `plus.*` and `removal.*`, kept so `netEngine.status` answers at once, and the calls the window makes. The
 * helper is Plus's only client; the window opens the Plus website itself and the user types the code there.
 */
export class EnginePlus {
  private plus?: NetEnginePlus
  private removals = new Map<string, NetEngineRemoval>()
  private asks: NetEngineRemovalAsk[] = []
  private helper?: EngineHelper
  private off?: () => void

  constructor(private readonly changed: () => void) {}

  /** A helper said hello: read its state, and follow its events. */
  attach(helper: EngineHelper): void {
    this.off?.()
    this.helper = helper
    this.off = helper.onEvent((event) => this.event(event))
    void helper
      .request('plus.status')
      .then((reply) => this.status(reply))
      .catch(() => undefined)
    void helper
      .request('removal.list')
      .then((reply) => this.list(reply))
      .catch(() => undefined)
  }

  /** What `netEngine.status` carries; `nameOf` names a host this computer is paired with. */
  view(nameOf: (identity: string) => string | undefined = () => undefined): {
    plus?: NetEnginePlus
    removals?: NetEngineRemoval[]
    removalAsks?: NetEngineRemovalAsk[]
  } {
    const named = <T extends { host: string }>(item: T): T => {
      const hostName = nameOf(item.host)
      return hostName ? { ...item, hostName } : item
    }
    return {
      ...(this.plus ? { plus: this.plus } : {}),
      ...(this.removals.size ? { removals: [...this.removals.values()].map(named) } : {}),
      ...(this.asks.length ? { removalAsks: this.asks.map(named) } : {})
    }
  }

  private status(reply: Json): void {
    const account = obj(reply.account)
    const usage = obj(reply.usage)
    const link = obj(reply.link)
    const relay = this.plus?.relay
    this.plus = {
      configured: reply.configured !== false,
      linked: reply.linked === true,
      ...(link && str(link.user_code) && str(link.verify_url)
        ? {
            link: {
              userCode: str(link.user_code)!,
              verifyUrl: str(link.verify_url)!,
              expiresAt: num(link.expires_at) ?? 0
            }
          }
        : {}),
      ...(str(reply.link_result) ? { linkResult: str(reply.link_result) } : {}),
      ...(str(account?.plan) ? { plan: str(account?.plan) } : {}),
      ...(num(account?.period_ends_at) ? { periodEndsAt: num(account?.period_ends_at) } : {}),
      ...(pool(usage?.bulk) ? { bulk: pool(usage?.bulk) } : {}),
      ...(pool(usage?.interactive) ? { interactive: pool(usage?.interactive) } : {}),
      ...(num(reply.unreachable_since) ? { unreachableSince: num(reply.unreachable_since) } : {}),
      ...(relay ? { relay } : {})
    }
    this.changed()
  }

  private list(reply: Json): void {
    this.removals = new Map()
    for (const r of Array.isArray(reply.removals) ? reply.removals : []) {
      const item = removal(r)
      if (item) this.removals.set(item.id, item)
    }
    this.asks = (Array.isArray(reply.asks) ? reply.asks : []).flatMap((a) => ask(a) ?? [])
    this.changed()
  }

  private event(event: Json): void {
    switch (event.ev) {
      case 'plus.status':
        return this.status(event)
      case 'plus.link':
        // The sign-in ended (or the computer signed out): read the whole state again.
        void this.refreshStatus()
        return
      case 'plus.reach': {
        if (!this.plus) return
        const since = num(event.since)
        this.plus = { ...this.plus }
        if (event.reachable === false && since) this.plus.unreachableSince = since
        else delete this.plus.unreachableSince
        return this.changed()
      }
      case 'plus.relay': {
        const interactive = relayClass(event.interactive)
        const bulk = relayClass(event.bulk)
        this.plus = {
          ...(this.plus ?? { configured: true, linked: true }),
          relay: { ...(interactive ? { interactive } : {}), ...(bulk ? { bulk } : {}) }
        }
        return this.changed()
      }
      case 'plus.relay.paused': {
        // Copies over the paid relay pause and resume on their own; the window shows a line, never a prompt.
        const relay = { ...this.plus?.relay }
        const cls =
          event.class === 'bulk'
            ? 'bulk'
            : event.class === 'interactive'
              ? 'interactive'
              : undefined
        if (!cls) return
        const current = relay[cls] ?? { state: 'unfunded' as const, bytesLeft: 0 }
        relay[cls] = {
          ...current,
          state: event.paused === true ? 'paused' : current.bytesLeft > 0 ? 'funded' : 'unfunded'
        }
        this.plus = { ...(this.plus ?? { configured: true, linked: true }), relay }
        return this.changed()
      }
      case 'removal.state': {
        const item = removal(event)
        if (item) {
          this.removals.set(item.id, item)
          this.changed()
        }
        return
      }
      case 'removal.ask': {
        const item = ask(event)
        if (item && !this.asks.some((a) => a.host === item.host && a.grant === item.grant)) {
          this.asks = [...this.asks, item]
          this.changed()
        }
        return
      }
    }
  }

  private require(): EngineHelper {
    if (!this.helper) throw new NetError('peer_offline', 'The networking helper is not running.')
    return this.helper
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status(await this.require().request('plus.status'))
    } catch {
      // Read again on the next event.
    }
  }

  private async call(op: string, fields: Json = {}): Promise<Json> {
    try {
      return await this.require().request(op, fields)
    } catch (error) {
      throw plusError(error)
    }
  }

  /** Sign in: Plus gives a code; the window opens the website, where the user types it. */
  async signIn(): Promise<{ userCode: string; verifyUrl: string; expiresAt: number }> {
    const reply = await this.call('plus.link.start')
    await this.refreshStatus()
    return {
      userCode: str(reply.user_code) ?? '',
      verifyUrl: str(reply.verify_url) ?? '',
      expiresAt: num(reply.expires_at) ?? 0
    }
  }

  async cancelSignIn(): Promise<void> {
    await this.call('plus.link.cancel')
    await this.refreshStatus()
  }

  async refresh(): Promise<void> {
    this.status(await this.call('plus.refresh'))
  }

  async signOut(): Promise<void> {
    await this.call('plus.unlink')
    await this.refreshStatus()
  }

  /** For each host where this computer is an owner: the grant its last list named for `identity`. */
  async plan(identity: string): Promise<NetEngineRemovalHost[]> {
    const reply = await this.call('removal.plan', { identity })
    return (Array.isArray(reply.hosts) ? reply.hosts : []).flatMap((h) => {
      const host = obj(h)
      if (!host || !str(host.host)) return []
      return [{ host: str(host.host)!, name: str(host.name) ?? '', grant: num(host.grant) ?? null }]
    })
  }

  /** Remove `identity` on each confirmed host, naming the grant id the user saw there. */
  async removeEverywhere(
    identity: string,
    name: string,
    hosts: Array<{ host: string; grant: number }>
  ): Promise<void> {
    const reply = await this.call('removal.confirm', { identity, name, hosts })
    for (const r of Array.isArray(reply.removals) ? reply.removals : []) {
      const item = removal(r)
      if (item) this.removals.set(item.id, item)
    }
    this.changed()
  }

  /** The answer to "<X> is also on <host>. Remove it there?". */
  async answer(identity: string, host: string, grant: number, yes: boolean): Promise<void> {
    const reply = await this.call('removal.ask.answer', { identity, host, grant, yes })
    this.asks = this.asks.filter((a) => !(a.identity === identity && a.host === host))
    for (const r of Array.isArray(reply.removals) ? reply.removals : []) {
      const item = removal(r)
      if (item) this.removals.set(item.id, item)
    }
    this.changed()
  }
}
