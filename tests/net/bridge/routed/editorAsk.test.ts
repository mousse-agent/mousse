/**
 * `editor.ask`: a computer that cannot open its editor on another one asks for it. The ask changes nothing by
 * itself. A person on the owner answers it: Allow turns "Editor connections from this device" on there, Not now
 * is recorded and the same computer is told so for a while. Every ask that reaches a person, and its answer, is
 * a row of the owner's audit, and a blocked device never gets as far as asking.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_ASKS_PER_HOUR,
  EDITOR_ASK_COOLDOWN_MS,
  EDITOR_ASK_TTL_MS,
  EDITOR_ASK_WINDOW_MS,
  type EditorAskReply,
  type EditorAskView
} from '../../../../src/shared/bridge/editorAsk'
import { EditorAsks } from '../../../../src/mms/bridge/routed/editorAsks'
import { cleanDeviceName, editorAskQuestion } from '../../../../src/shared/bridge/editorAsk'
import { NetService } from '../../../../src/mms/net/NetService'
import { SqliteBridgeAudit } from '../../../../src/mms/net/store/audit'
import { ROUTED_METHODS, routedVersions } from '../../../../src/shared/bridge/routed'
import { describeActivityEntry } from '../../../../src/shared/bridge/deviceActivity'
import { forbiddenReason, newId, type NodeId } from '../../../../src/shared/net'
import { cleanup } from '../hub/fixture'
import { routedOwner, testClock } from './routedFixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo()
  await cleanup()
})

/** The owner's asks, with a clock the test moves, a notice log and the owner's real policy and audit. */
async function owner(options: { name?: string; stillAsking?: (node: NodeId) => Promise<boolean>; allow?: (node: NodeId) => Promise<void> } = {}) {
  const clock = testClock()
  const o = await routedOwner({ clock })
  const audit = new SqliteBridgeAudit(o.f.targetDb, clock)
  const asked: EditorAskView[] = []
  const changed = vi.fn()
  const asks = new EditorAsks({
    policy: o.policy,
    audit,
    clock,
    name: () => options.name ?? 'Laptop',
    onAsked: (view) => asked.push(view),
    onChanged: changed,
    ...(options.stillAsking ? { stillAsking: options.stillAsking } : {}),
    ...(options.allow ? { allow: options.allow } : {})
  })
  asks.start()
  cleanups.push(() => asks.close())
  o.f.mms.editorAsks = asks
  const node = o.f.callerNode
  const rows = () => audit.recent(100, node).filter((row) => row.method.startsWith('editor.ask'))
  const ask = async () => (await o.ok('editor.ask', {})) as unknown as EditorAskReply
  return { o, clock, audit, asks, asked, changed, node, rows, ask }
}

describe('the row', () => {
  it('is a read of the computer that takes nothing, at version 1, and is not a ledger row', () => {
    expect(ROUTED_METHODS['editor.ask']).toMatchObject({
      capability: 'read',
      durable: false,
      target: 'computer',
      via: 'protocol',
      keys: [],
      version: 1
    })
    expect(routedVersions()['editor.ask']).toBe(1)
  })

  it('is registered as a routed method that needs "Works on threads", like every other row', async () => {
    const { o } = await owner()
    expect(o.routes.methodFor('editor.ask', ROUTED_METHODS['editor.ask'])).toMatchObject({
      method: 'routed.editor.ask',
      family: 'routed',
      capability: 'read',
      requires: ['settings'],
      mutating: false,
      ephemeral: true
    })
  })
})

describe('asking', () => {
  it('reaches the owner as a routed call, asks a person once, and changes no setting', async () => {
    const { o, asked, changed, node, rows, ask, clock } = await owner({ name: 'Studio laptop' })
    expect(o.policy.get(node).editor).toBe(false)

    const first = await ask()
    expect(first).toEqual({ state: 'asked', expiresAt: clock.now() + EDITOR_ASK_TTL_MS })
    // A person is told, by the name the owner knows the device by.
    expect(asked).toEqual([
      { node, name: 'Studio laptop', at: clock.now(), expiresAt: clock.now() + EDITOR_ASK_TTL_MS }
    ])
    expect(changed).toHaveBeenCalledTimes(1)
    // The ask is not the grant.
    expect(o.policy.get(node).editor).toBe(false)
    expect(rows().map((row) => [row.method, row.outcome, row.kind])).toEqual([
      ['editor.ask', 'asked', 'change']
    ])

    // Asking again while the first waits is answered, and bothers nobody.
    expect(await ask()).toEqual({ state: 'pending', expiresAt: first.state === 'asked' ? first.expiresAt : -1 })
    expect(asked).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })

  it('takes nothing from the caller, not even a folder or a command', async () => {
    const { o } = await owner()
    for (const extra of [{ cwd: '/' }, { command: 'x' }, { threadId: 't' }, { path: 'a' }, { editor: true }])
      await expect(o.call('editor.ask', extra), JSON.stringify(extra)).rejects.toMatchObject({
        code: 'bad_request'
      })
  })

  it('is told there is nothing to ask when the switch is already on', async () => {
    const { o, asked, node, ask, rows } = await owner()
    o.policy.set(node, { editor: true })
    expect(await ask()).toEqual({ state: 'already_on' })
    expect(asked).toHaveLength(0)
    expect(rows()).toHaveLength(0)
  })

  it('is refused for a blocked device before anyone is asked', async () => {
    const { o, asked, node, rows } = await owner()
    o.policy.set(node, { blocked: true })
    await expect(o.call('editor.ask', {})).rejects.toMatchObject({ code: 'forbidden' })
    expect(asked).toHaveLength(0)
    expect(rows()).toHaveLength(0)
    expect(o.policy.get(node).editor).toBe(false)
  })

  it('refuses a computer that is no longer on this one’s list as soon as it is blocked while its ask waits', async () => {
    const { o, asks, node, ask, changed } = await owner()
    await ask()
    changed.mockClear()
    o.policy.set(node, { blocked: true })
    expect(asks.pending()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
    // A late Allow does nothing: the ask is gone.
    expect(await asks.answer(node, true)).toEqual({ ok: false, reason: 'expired' })
    expect(o.policy.get(node).editor).toBe(false)
  })
})

describe('answering', () => {
  it('Allow turns the switch on, ends the ask and writes the answer to the audit', async () => {
    const { o, asks, node, ask, rows, changed } = await owner()
    await ask()
    changed.mockClear()
    expect(asks.pending().map((view) => view.node)).toEqual([node])

    expect(await asks.answer(node, true)).toEqual({ ok: true, allowed: true })
    expect(o.policy.get(node).editor).toBe(true)
    expect(asks.pending()).toEqual([])
    expect(changed).toHaveBeenCalled()
    expect(rows().map((row) => [row.method, row.outcome, row.kind]).sort()).toEqual([
      ['editor.ask', 'asked', 'change'],
      ['editor.ask.allowed', 'ok', 'change']
    ])
    // Nothing else changed: terminals and the permission ceiling stay as they were.
    expect(o.policy.get(node)).toMatchObject({ terminal: false, blocked: false })
    // The switch is on now, so the next ask has nothing to ask.
    expect(await ask()).toEqual({ state: 'already_on' })
    // An answer is given once.
    expect(await asks.answer(node, true)).toEqual({ ok: false, reason: 'expired' })
  })

  it('Not now records a refusal, leaves the switch off, and tells the same computer so without asking again', async () => {
    const { o, asks, asked, node, ask, rows, clock } = await owner()
    await ask()
    expect(await asks.answer(node, false)).toEqual({ ok: true, allowed: false })
    expect(o.policy.get(node).editor).toBe(false)
    expect(rows().map((row) => [row.method, row.outcome, row.kind]).sort()).toEqual([
      ['editor.ask', 'asked', 'change'],
      ['editor.ask.declined', 'not_now', 'refused']
    ])

    const declinedAt = clock.now()
    clock.advance(5 * 60_000)
    expect(await ask()).toEqual({ state: 'declined_recently', retryAt: declinedAt + EDITOR_ASK_COOLDOWN_MS })
    expect(asked).toHaveLength(1)
    // The refusal of the repeat is a row of its own, once a minute at most.
    await ask()
    expect(rows().filter((row) => row.outcome === 'declined_recently')).toHaveLength(1)

    // After the cooldown a person is asked again.
    clock.advance(EDITOR_ASK_COOLDOWN_MS)
    expect((await ask()).state).toBe('asked')
    expect(asked).toHaveLength(2)
  })

  it('remembers a Not now across a restart of the daemon, from the audit', async () => {
    const { o, asks, audit, node, ask, clock } = await owner()
    await ask()
    await asks.answer(node, false)
    const restarted = new EditorAsks({
      policy: o.policy,
      audit,
      clock,
      name: () => 'Laptop',
      onAsked: () => expect.unreachable('nobody is asked again'),
      onChanged: () => undefined
    })
    expect(restarted.ask(node)).toMatchObject({ state: 'declined_recently' })
  })

  it('lets an ask run out, and asks again after it did', async () => {
    const { asks, asked, ask, clock, changed } = await owner()
    await ask()
    clock.advance(EDITOR_ASK_TTL_MS + 1)
    expect(asks.pending()).toEqual([])
    changed.mockClear()
    expect((await ask()).state).toBe('asked')
    expect(asked).toHaveLength(2)
  })

  it('refuses an answer for a computer that did not ask', async () => {
    const { asks } = await owner()
    expect(await asks.answer(newId('node'), true)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('answering when things changed', () => {
  it('Allow is refused for a device that is no longer on the roster with Works on threads, and turns nothing on', async () => {
    let still = true
    const { o, asks, node, ask, rows } = await owner({ stillAsking: async () => still })
    await ask()
    // Revoked, or its grant taken away, while the question was on screen.
    still = false
    expect(await asks.answer(node, true)).toEqual({ ok: false, reason: 'expired' })
    expect(o.policy.get(node).editor).toBe(false)
    expect(asks.pending()).toEqual([])
    expect(rows().map((row) => row.method)).not.toContain('editor.ask.allowed')
  })

  it('drops the waiting ask of a device that lost its place, without being asked to answer', async () => {
    let still = true
    const { asks, ask, changed } = await owner({ stillAsking: async () => still })
    await ask()
    changed.mockClear()
    await asks.reconcile()
    expect(asks.pending()).toHaveLength(1)
    still = false
    await asks.reconcile()
    expect(asks.pending()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('turns the switch on through the same code as the switch in Devices, and not twice when two windows answer', async () => {
    const turnedOn: NodeId[] = []
    const { o, asks, node, ask } = await owner({
      allow: async (device) => {
        turnedOn.push(device)
        o.policy.set(device, { editor: true })
      }
    })
    await ask()
    const [first, second] = await Promise.all([asks.answer(node, true), asks.answer(node, true)])
    expect([first, second].filter((result) => result.ok)).toHaveLength(1)
    expect(turnedOn).toEqual([node])
    expect(o.policy.get(node).editor).toBe(true)
  })

  it('keeps the ask when turning the switch on fails, as an expired one', async () => {
    const { o, asks, node, ask } = await owner({
      allow: async () => {
        throw new Error('Unknown device.')
      }
    })
    await ask()
    expect(await asks.answer(node, true)).toEqual({ ok: false, reason: 'expired' })
    expect(o.policy.get(node).editor).toBe(false)
  })
})

describe('the limits do not depend on the last rows of the audit', () => {
  it('still holds three asks an hour after a device made hundreds of other changes', async () => {
    const { o, audit, node, ask, clock, asked } = await owner()
    for (let index = 0; index < EDITOR_ASKS_PER_HOUR; index++) {
      expect((await ask()).state).toBe('asked')
      clock.advance(EDITOR_ASK_TTL_MS + 1)
    }
    // Far more rows than any window of "the last rows" could hold.
    for (let index = 0; index < 450; index++) audit.record({ node, method: 'orchestrator.send', outcome: 'ok', kind: 'change' })
    // A restart: the counters come from the audit, asked by method and time.
    const restarted = new EditorAsks({
      policy: o.policy,
      audit,
      clock,
      name: () => 'Laptop',
      onAsked: () => expect.unreachable('nobody is asked again'),
      onChanged: () => undefined
    })
    expect(restarted.ask(node)).toMatchObject({ state: 'rate_limited' })
    // And the one that is running did not forget them either.
    expect((await ask()).state).toBe('rate_limited')
    expect(asked).toHaveLength(EDITOR_ASKS_PER_HOUR)
  })

  it('remembers a Not now across a restart however many other changes came after it', async () => {
    const { o, asks, audit, node, ask, clock } = await owner()
    await ask()
    await asks.answer(node, false)
    for (let index = 0; index < 450; index++) audit.record({ node, method: 'orchestrator.send', outcome: 'ok', kind: 'change' })
    const restarted = new EditorAsks({
      policy: o.policy,
      audit,
      clock,
      name: () => 'Laptop',
      onAsked: () => expect.unreachable('nobody is asked again'),
      onChanged: () => undefined
    })
    expect(restarted.ask(node)).toMatchObject({ state: 'declined_recently' })
  })
})

describe('a name is safe to show', () => {
  it('drops control and direction characters, cuts a long name, and keeps an ordinary one', () => {
    expect(cleanDeviceName('Studio laptop')).toBe('Studio laptop')
    expect(cleanDeviceName('Studio\nlaptop\u202eevil\u200b')).toBe('Studio laptop evil')
    expect(cleanDeviceName('  \u0000\u202e  ')).toBe('Another computer')
    expect(cleanDeviceName('')).toBe('Another computer')
    const long = cleanDeviceName('x'.repeat(300))
    expect([...long]).toHaveLength(64)
    expect(long.endsWith('…')).toBe(true)
  })

  it('asks in the name of the computer that asks, never the owner’s own', () => {
    expect(editorAskQuestion('Computer B')).toBe('Let Computer B’s editor connect to this computer?')
  })
})

describe('asking too often', () => {
  it('raises at most three notices an hour for a device, and says when it may ask again', async () => {
    const { asks, asked, ask, clock, rows } = await owner()
    const started = clock.now()
    for (let index = 0; index < EDITOR_ASKS_PER_HOUR; index++) {
      expect((await ask()).state).toBe('asked')
      // Nobody answered; the ask runs out and the device may ask again.
      clock.advance(EDITOR_ASK_TTL_MS + 1)
    }
    expect(asked).toHaveLength(EDITOR_ASKS_PER_HOUR)

    const limited = await ask()
    expect(limited).toEqual({ state: 'rate_limited', retryAt: started + EDITOR_ASK_WINDOW_MS })
    expect(asked).toHaveLength(EDITOR_ASKS_PER_HOUR)
    expect(asks.pending()).toEqual([])
    // The refusal is one row, however often it is repeated within the minute.
    await ask()
    await ask()
    expect(rows().filter((row) => row.outcome === 'rate_limited')).toHaveLength(1)
    expect(rows().filter((row) => row.outcome === 'asked' && row.kind === 'change')).toHaveLength(EDITOR_ASKS_PER_HOUR)

    clock.advance(EDITOR_ASK_WINDOW_MS)
    expect((await ask()).state).toBe('asked')
  })
})

describe('what the owner sees in Devices', () => {
  it('words each row of an ask in plain words, and a refused ask says it was not passed on', () => {
    expect(describeActivityEntry({ method: 'editor.ask', kind: 'change', outcome: 'asked' })).toBe(
      'Asked to open its editor here'
    )
    expect(describeActivityEntry({ method: 'editor.ask.allowed', kind: 'change', outcome: 'ok' })).toBe(
      'Asked to open its editor here, and you allowed it'
    )
    expect(describeActivityEntry({ method: 'editor.ask.declined', kind: 'refused', outcome: 'not_now' })).toBe(
      'Asked to open its editor here, and you said Not now'
    )
    expect(describeActivityEntry({ method: 'editor.ask', kind: 'refused', outcome: 'rate_limited' })).toBe(
      'Asked to open its editor here (not passed on: too many at once)'
    )
    // A refused editor connection is not worded like one that opened.
    expect(describeActivityEntry({ method: 'editor.open', kind: 'change', outcome: 'ok' })).toBe('Opened its editor here')
    expect(describeActivityEntry({ method: 'editor.open', kind: 'refused', outcome: 'editor_off' })).toBe(
      'Tried to open its editor here (refused: editor connections are off for the device)'
    )
  })
})

// ------------------------------------------------------------------------------------------------
// The checks every routed call goes through before a handler runs, with the real row's registration.
// ------------------------------------------------------------------------------------------------

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(): NetService {
  const net = new NetService({ profileDir: directory('net-editor-ask-') })
  cleanups.push(() => net.shutdown())
  return net
}

describe('who may ask', () => {
  it('needs the grant every routed call needs: refused to a blocked device, to a phone, and while other computers are switched off', async () => {
    const { o } = await owner()
    const a = service()
    await a.request('net.init', { name: 'owner', listen: true, port: 0 })
    await a.request('net.protect', { passphrase: 'test-authority-protection' })
    const self = a.runtime().identity.self()!
    const join = async (invite: string, name: string) => {
      const device = service()
      const joined = (await device.request('bridge.join', { invite, name })) as { node: NodeId }
      await vi.waitFor(() => expect(a.status().peers).toContainEqual({ node: joined.node, state: 'open' }), {
        timeout: 10_000
      })
      await vi.waitFor(() => expect(device.status().peers).toContainEqual({ node: self.node, state: 'open' }), {
        timeout: 10_000
      })
      return { net: device, node: joined.node }
    }
    // The real row's own registration (family, capability, grant), answering with the owner's real asks.
    const asked: NodeId[] = []
    const policy = a.runtime().policy
    const asks = new EditorAsks({
      policy,
      audit: a.runtime().audit,
      clock: { now: () => Date.now() },
      name: () => 'Laptop',
      onAsked: (view) => asked.push(view.node),
      onChanged: () => undefined
    })
    a.runtime().rpc.register({
      ...o.routes.methodFor('editor.ask', ROUTED_METHODS['editor.ask']),
      handle: async (_params, context) => asks.ask(context.caller.node)
    })
    const call = (from: NetService) =>
      from.session(self.node).rpc('routed.editor.ask', {}, { id: newId('rpc'), deadlineMs: 5000 })
    const refusedWith = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown as { code?: string; details?: unknown }
      )
      expect(error?.code).toBe('forbidden')
      return forbiddenReason(error?.details)
    }

    const invite = async (params: Record<string, unknown> = {}) =>
      ((await a.request('bridge.invite', params)) as { invite: string }).invite
    const laptop = await join(await invite(), 'laptop')
    const phone = await join(await invite({ caps: ['read', 'chat', 'write'] }), 'pocket')

    expect(await call(laptop.net)).toMatchObject({ state: 'asked' })
    expect(asked).toEqual([laptop.node])
    expect(await refusedWith(call(phone.net))).toBe('capability')

    await a.request('bridge.policy', { node: laptop.node, blocked: true })
    expect(await refusedWith(call(laptop.net))).toBe('blocked')
    await a.request('bridge.policy', { node: laptop.node, blocked: false })

    await a.request('bridge.workOnThreads', { enabled: false })
    expect(await refusedWith(call(laptop.net))).toBe('setting_off')
    await a.request('bridge.workOnThreads', { enabled: true })
    expect(await call(laptop.net)).toMatchObject({ state: expect.stringMatching(/^(asked|pending)$/) })
    // Nothing the refused calls did turned a switch on.
    expect(policy.get(laptop.node).editor).toBe(false)
    expect(asked).toHaveLength(1)
    asks.close()
  }, 90_000)
})
