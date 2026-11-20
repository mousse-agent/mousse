/**
 * Mousse Plus and "Remove on all my hosts" on the daemon side (Phase 4, M16 and M17): what the helper says on
 * `plus.*` and `removal.*` becomes `netEngine.status`, and the window's calls reach the helper through the
 * registered `netEngine.*` handlers. The helper is stubbed at its app channel (`request` and `onEvent`).
 */
import { describe, expect, it } from 'vitest'
import { NetError } from '../../src/shared/net'
import { EnginePlus, PLUS_FAILED, PLUS_WRONG_PAGE } from '../../src/mms/netEngine/plus'
import { registerNetEngineMethods } from '../../src/mms/netEngine/registerMethods'
import type { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import type { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'

type Json = Record<string, unknown>

/** The helper's side: canned replies per op, every request kept, and events the test sends. */
function helper(replies: Record<string, Json | Error> = {}) {
  const requests: Array<[string, Json]> = []
  const listeners = new Set<(event: Json) => void>()
  const stub = {
    request: async (op: string, fields: Json = {}) => {
      requests.push([op, fields])
      const reply = replies[op]
      if (reply instanceof Error) throw reply
      return reply ?? {}
    },
    onEvent: (listener: (event: Json) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    stub: stub as unknown as EngineHelper,
    requests,
    sent: (op: string) => requests.filter(([name]) => name === op).map(([, fields]) => fields),
    emit: (event: Json) => {
      for (const listener of listeners) listener(event)
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const LINKED = {
  configured: true,
  linked: true,
  url: 'https://plus.test',
  account: { plan: 'active', period_ends_at: 1_800_000_000 },
  usage: { bulk: { allowance: 100, available: 40 }, interactive: { allowance: 50, available: 50 } }
}

describe('EnginePlus', () => {
  it('reads the account and removals when the helper says hello', async () => {
    const h = helper({
      'plus.status': LINKED,
      'removal.list': {
        removals: [{ id: 'r1', host: 'h1', removed: 'x1', name: 'Phone', grant: 4, state: 'sent' }],
        asks: [{ identity: 'x1', name: 'Phone', host: 'h2', grant: 9 }]
      }
    })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    await settle()
    const view = plus.view((id) => (id === 'h1' ? 'Studio' : undefined))
    expect(view.plus).toMatchObject({ linked: true, plan: 'active', bulk: { allowance: 100, available: 40 } })
    expect(view.removals).toEqual([expect.objectContaining({ id: 'r1', state: 'sent', hostName: 'Studio' })])
    expect(view.removalAsks).toEqual([expect.objectContaining({ host: 'h2', grant: 9 })])
    expect(view.removalAsks![0]!.hostName).toBeUndefined()
  })

  it('pauses only the class the helper names, and resumes it, with no other state touched', async () => {
    const h = helper({ 'plus.status': LINKED })
    let changes = 0
    const plus = new EnginePlus(() => changes++)
    plus.attach(h.stub)
    await settle()
    h.emit({
      ev: 'plus.relay',
      interactive: { state: 'funded', bytes_left: 1000, lasts_secs: 7200 },
      bulk: { state: 'funded', bytes_left: 5000 }
    })
    h.emit({ ev: 'plus.relay.paused', class: 'bulk', paused: true })
    expect(plus.view().plus?.relay).toEqual({
      interactive: { state: 'funded', bytesLeft: 1000, lastsSecs: 7200 },
      bulk: { state: 'paused', bytesLeft: 5000 }
    })
    h.emit({ ev: 'plus.relay.paused', class: 'bulk', paused: false })
    expect(plus.view().plus?.relay?.bulk?.state).toBe('funded')
    expect(plus.view().plus?.plan).toBe('active')
    expect(changes).toBeGreaterThanOrEqual(3)
  })

  it('follows removal states and drops an ask once answered', async () => {
    const h = helper({
      'removal.ask.answer': {
        removals: [{ id: 'r2', host: 'h2', removed: 'x1', name: 'Phone', grant: 9, state: 'waiting' }]
      }
    })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    await settle()
    h.emit({ ev: 'removal.ask', identity: 'x1', name: 'Phone', host: 'h2', grant: 9 })
    h.emit({ ev: 'removal.ask', identity: 'x1', name: 'Phone', host: 'h2', grant: 9 })
    expect(plus.view().removalAsks).toHaveLength(1)
    await plus.answer('x1', 'h2', 9, true)
    expect(h.sent('removal.ask.answer')).toEqual([{ identity: 'x1', host: 'h2', grant: 9, yes: true }])
    expect(plus.view().removalAsks).toBeUndefined()
    h.emit({ ev: 'removal.state', id: 'r2', host: 'h2', removed: 'x1', name: 'Phone', grant: 9, state: 'done', result: 'stale' })
    expect(plus.view().removals).toEqual([expect.objectContaining({ id: 'r2', state: 'done', result: 'stale' })])
  })

  it("words the helper's Plus failures for the window", async () => {
    const notLinked = new NetError('internal', undefined, { details: { helper: 'not_linked' } })
    const h = helper({ 'plus.refresh': notLinked })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    await expect(plus.refresh()).rejects.toThrow('Sign in to Plus first.')
  })

  it('says one fixed line for a Plus failure it has no words for, never the helper’s reason', async () => {
    const h = helper({
      'plus.refresh': new NetError('internal', 'plus said: db shard 7 down', { details: { helper: 'plus_new_thing' } })
    })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    await expect(plus.refresh()).rejects.toMatchObject({
      message: PLUS_FAILED,
      details: { reason: 'plus_new_thing' }
    })
  })

  it('does not say signed in from a paid relay state that comes before the Plus state', async () => {
    const h = helper({ 'plus.status': { ...LINKED, linked: false } })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    h.emit({ ev: 'plus.relay', bulk: { state: 'funded', bytes_left: 5000 } })
    h.emit({ ev: 'plus.relay.paused', class: 'interactive', paused: true })
    expect(plus.view().plus).toBeUndefined()
    await settle()
    expect(plus.view().plus).toMatchObject({
      linked: false,
      relay: { bulk: { state: 'funded', bytesLeft: 5000 }, interactive: { state: 'paused' } }
    })
  })

  it('starts from nothing when a new helper says hello', async () => {
    const first = helper({
      'plus.status': LINKED,
      'removal.list': {
        removals: [{ id: 'r1', host: 'h1', removed: 'x1', name: 'Phone', grant: 4, state: 'sent' }],
        asks: [{ identity: 'x1', name: 'Phone', host: 'h2', grant: 9 }]
      }
    })
    const plus = new EnginePlus(() => undefined)
    plus.attach(first.stub)
    await settle()
    first.emit({ ev: 'plus.relay', bulk: { state: 'funded', bytes_left: 5000 } })
    expect(plus.view().removals).toHaveLength(1)
    // The new helper has not answered yet.
    const second = helper()
    ;(second.stub as unknown as { request: () => Promise<never> }).request = () => new Promise(() => undefined)
    plus.attach(second.stub)
    expect(plus.view()).toEqual({})
    // The old helper's events no longer count.
    first.emit({ ev: 'removal.ask', identity: 'x1', name: 'Phone', host: 'h3', grant: 2 })
    expect(plus.view()).toEqual({})
  })

  it('shows a sign-in code only with a page on the Plus address', async () => {
    const link = { user_code: 'WXYZ-1234', verify_url: 'https://elsewhere.test/link', expires_at: 99 }
    const h = helper({ 'plus.status': { configured: true, linked: false, url: 'https://plus.test', link } })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    await settle()
    expect(plus.view().plus?.link).toBeUndefined()
    h.emit({ ev: 'plus.status', configured: true, linked: false, link: { ...link, verify_url: 'https://plus.test/link' } })
    expect(plus.view().plus?.link).toEqual({ userCode: 'WXYZ-1234', verifyUrl: 'https://plus.test/link', expiresAt: 99 })
  })
})

describe('the netEngine.* handlers for Plus and removals', () => {
  /** The registered handlers over one profile's engine: a paired device and the Plus state above. */
  function handlers() {
    const methods = new Map<string, { validate: (p: unknown) => unknown; handle: (...args: unknown[]) => Promise<unknown> }>()
    const registry = { register: (m: { method: string }) => methods.set(m.method, m as never) }
    const h = helper({
      'plus.status': { configured: true, linked: false, url: 'https://plus.test' },
      'plus.link.start': { user_code: 'WXYZ-1234', verify_url: 'https://plus.test/link', expires_at: 99 },
      'removal.plan': { hosts: [{ host: 'h1', name: 'Studio', grant: 4 }, { host: 'h2', name: 'Laptop' }] },
      'removal.confirm': {
        removals: [{ id: 'r1', host: 'h1', removed: 'x1', name: 'Phone', grant: 4, state: 'waiting' }]
      }
    })
    const plus = new EnginePlus(() => undefined)
    plus.attach(h.stub)
    const engine = {
      plus,
      device: (node: string) => {
        if (node !== 'n1') throw new NetError('bad_request', 'No such device.')
        return { identity: 'x1', name: 'Phone' }
      },
      status: () => ({ ...plus.view() })
    }
    registerNetEngineMethods(registry as unknown as DomainHandlerRegistry, () => engine as never)
    const call = async (method: string, params: Json) => {
      const m = methods.get(method)!
      return m.handle({}, m.validate(params), { profileId: 'p1' })
    }
    return { h, call, methods }
  }

  it('refuses a sign-in page off the Plus address', async () => {
    const { h, call } = handlers()
    ;(h.stub as unknown as { request: (op: string) => Promise<Json> }).request = async (op: string) =>
      op === 'plus.link.start'
        ? { user_code: 'WXYZ-1234', verify_url: 'https://plus.test.evil.example/link', expires_at: 99 }
        : { configured: true, linked: false, url: 'https://plus.test' }
    await expect(call('netEngine.plus.signIn', {})).rejects.toThrow(PLUS_WRONG_PAGE)
  })

  it('starts sign-in and hands the window the code and the page to type it on', async () => {
    const { call } = handlers()
    expect(await call('netEngine.plus.signIn', {})).toEqual({
      userCode: 'WXYZ-1234',
      verifyUrl: 'https://plus.test/link',
      expiresAt: 99
    })
  })

  it('plans by the device row, and removes only on the hosts confirmed, with the grant id seen there', async () => {
    const { h, call } = handlers()
    expect(await call('netEngine.removeEverywhere.plan', { node: 'n1' })).toEqual({
      hosts: [
        { host: 'h1', name: 'Studio', grant: 4 },
        { host: 'h2', name: 'Laptop', grant: null }
      ]
    })
    expect(h.sent('removal.plan')).toEqual([{ identity: 'x1' }])
    const status = (await call('netEngine.removeEverywhere', { node: 'n1', hosts: [{ host: 'h1', grant: 4 }] })) as Json
    expect(h.sent('removal.confirm')).toEqual([{ identity: 'x1', name: 'Phone', hosts: [{ host: 'h1', grant: 4 }] }])
    expect(status.removals).toEqual([expect.objectContaining({ id: 'r1', host: 'h1' })])
  })

  it('refuses a removal without a grant id per host', () => {
    const { methods } = handlers()
    expect(() =>
      methods.get('netEngine.removeEverywhere')!.validate({ node: 'n1', hosts: [{ host: 'h1' }] })
    ).toThrow(/hosts/)
    expect(() => methods.get('netEngine.removeEverywhere')!.validate({ node: 'n1', hosts: [] })).toThrow(/hosts/)
    expect(() =>
      methods.get('netEngine.removeEverywhere.answer')!.validate({ identity: 'x1', host: 'h1', yes: true })
    ).toThrow(/grant/)
  })
})
