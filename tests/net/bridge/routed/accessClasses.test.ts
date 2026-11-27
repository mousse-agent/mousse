/**
 * Every remote method and stream kind has an access class (`shared/net/accessClasses.ts`), and "Work on threads from
 * this device" off (`net_node_policy.work`) leaves a device to view threads; its bot level is separate. Over two real daemons
 * linked by Bridge: the keeper (`owner`) and a member (`caller`), each the receiver in turn, so the switch holds on a
 * computer that is not the keeper too. What is checked is the receiver's dispatcher, the one place every call and every
 * lookup of a saved result passes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { STREAM_KINDS, newId, type NodeId, type RpcId } from '../../../../src/shared/net'
import { ROUTED_STREAM_KINDS, type RoutedAgentMark } from '../../../../src/shared/bridge/routed'
import {
  ACCESS_CLASSES,
  METHOD_ACCESS,
  ROUTED_STREAM_ACCESS,
  STREAM_ACCESS
} from '../../../../src/shared/net/accessClasses'
import { ACCESS_PRESETS, accessPreset, accessPresetOf } from '../../../../src/shared/net/accessPresets'
import type { MousseMainService } from '../../../../src/mms/MousseMainService'
import type { BridgeNodePolicy } from '../../../../src/shared/net/local'
import { cleanupAll, cleanups, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
  // The member lets its other computers work on its threads too, so the keeper can be the caller.
  await t.caller.net.request('bridge.workOnThreads', { enabled: true })
}, 120_000)
afterAll(cleanupAll)

describe('the access table', () => {
  it('classes every method another device can call here, in every family, and names none that is not there', () => {
    const registered = t.owner.net.runtime().rpc.methods()
    // Each family is there: Net's own, routed rows and transport, the phone API, lists, the hub, bots and speech.
    for (const name of ['net.info', 'authority.transfer.import', 'routed.orchestrator.send', 'routed.stream.open', 'routed.stage', 'thread.snapshot', 'bridge.lists.open', 'bridge.dispatch', 'bots.create', 'speech.transcribe'])
      expect(registered, name).toContain(name)
    expect(registered.filter((name) => !Object.hasOwn(METHOD_ACCESS, name))).toEqual([])
    expect(Object.keys(METHOD_ACCESS).filter((name) => !registered.includes(name))).toEqual([])
    for (const value of Object.values(METHOD_ACCESS)) expect(ACCESS_CLASSES).toContain(value)
  })

  it('classes every stream kind, and a terminal is never a view', () => {
    for (const kind of STREAM_KINDS) expect(ACCESS_CLASSES, kind).toContain(STREAM_ACCESS[kind])
    for (const kind of ROUTED_STREAM_KINDS) expect(ACCESS_CLASSES, kind).toContain(ROUTED_STREAM_ACCESS[kind])
    expect(ROUTED_STREAM_ACCESS.terminal).toBe('terminal')
  })
})

describe('speech (dictation and read-aloud)', () => {
  it('is admitted for every access preset, with the Bots switch on or off, and refused only to a blocked device', async () => {
    const speech = Object.keys(METHOD_ACCESS).filter((name) => name.startsWith('speech.'))
    expect(speech).toContain('speech.transcribe')
    // Its own class, which no device switch reads: not the bots class it shared before.
    for (const method of speech) expect(METHOD_ACCESS[method as keyof typeof METHOD_ACCESS], method).toBe('speech')
    const peer = t.owner.net.session(t.callerNode).peer
    const admitted = (method: string): boolean => {
      try {
        t.owner.net.runtime().rpc.authorizedMethod(method, peer)
        return true
      } catch {
        return false
      }
    }
    try {
      for (const preset of ACCESS_PRESETS)
        for (const bots of ['off', 'use', 'full']) {
          await t.owner.net.request('bridge.policy', { node: t.callerNode, ...preset.fields, bots })
          for (const method of speech) expect(admitted(method), `${preset.id}, bots ${bots}: ${method}`).toBe(true)
        }
      // The one device-level rule speech had, and keeps: a blocked device gets nothing.
      await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
      for (const method of speech) expect(admitted(method), method).toBe(false)
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, ...accessPreset('work').fields, blocked: false })
    }
  }, 60_000)
})

const forbidden = (reason: string) => ({ code: 'forbidden', details: { reason } })
const mark = (): RoutedAgentMark => ({ thread: 'sender-thread', run: 'sender-run', title: 'Planner', hops: 1, mode: 'accept_edits' })
const BOT = 'bot-0123456789ab'

/** The receiver's bots as Bridge reads them: one bot, and a record of what reached it. No turn runs. */
function standInBots(receiver: MousseMainService) {
  const reached: string[] = []
  const bot = { id: BOT, name: 'Notes' }
  const service = {
    list: () => ({ bots: [bot] }),
    get: (botId: string) => {
      if (botId !== BOT) throw Object.assign(new Error('No such bot.'), { code: 'bot_not_found' })
      return { summary: bot, permissions: [], runs: [] }
    },
    chatSend: async (input: { text: string }) => {
      reached.push(`chatSend:${input.text}`)
      return { message: { seq: 1, role: 'owner', text: input.text, at: new Date().toISOString() } }
    },
    create: async () => {
      reached.push('create')
      return { bot }
    },
    withdrawQueued: async () => 0
  }
  const real = Object.getOwnPropertyDescriptor(receiver, 'personalBots')
  Object.defineProperty(receiver, 'personalBots', { value: { service, liveActivity: () => undefined, events: new EventEmitter() }, configurable: true })
  // The daemon's own bots are put back before it stops.
  cleanups.push(() => {
    if (real) Object.defineProperty(receiver, 'personalBots', real)
  })
  return reached
}

describe('a device that may view threads and chat with bots only', () => {
  // The keeper receives from its member, then a member that is not the keeper receives from the keeper.
  const directions = () => [
    { receiver: t.owner, caller: t.caller, receiverNode: t.node, callerNode: t.callerNode },
    { receiver: t.caller, caller: t.owner, receiverNode: t.callerNode, callerNode: t.node }
  ]

  for (const index of [0, 1])
    it(`reads the transcript and chats with bots; starting, sending, steering, stopping and making a bot are refused (${index ? 'member' : 'keeper'} receives)`, async () => {
      const { receiver, caller, receiverNode, callerNode } = directions()[index]!
      const reached = standInBots(receiver)
      // A bot reaches only its own computer until the owner adds a device to its Devices: the calling device is added.
      receiver.botDeviceAccess.set(BOT, { mode: 'chosen', nodes: [callerNode] })
      const session = caller.net.session(receiverNode)
      const rpc = (method: string, params: unknown, extra: { id?: RpcId; idem?: string } = {}) =>
        session.rpc(method, params, { id: extra.id ?? newId('rpc'), deadlineMs: 15_000, ...(extra.idem ? { idem: extra.idem } : {}) })
      const policyOf = async () =>
        ((await receiver.net.request('bridge.nodes', {})) as { nodes: Array<{ node: NodeId; policy: BridgeNodePolicy }> }).nodes.find((row) => row.node === callerNode)!.policy

      // A device starts out working on threads: the Work on threads preset.
      expect(accessPresetOf(await policyOf())).toBe('work')
      const thread = receiver.threads.createThread('Plan', undefined, undefined, { started: true })
      // A change made while the device could still work, whose result is kept for a retry.
      const renamed = newId('rpc')
      expect(await rpc('routed.threads.rename', { threadId: thread.id, name: 'Plan B' }, { id: renamed, idem: `rename-${index}` })).toMatchObject({ ok: true })

      await receiver.net.request('bridge.policy', { node: callerNode, work: false })
      expect(await policyOf()).toMatchObject({ work: false })

      // Reads pass: the transcript, the list, and a bot's chat.
      expect(await rpc('routed.thread.snapshot', { threadId: thread.id })).toMatchObject({ ok: true })
      expect(await rpc('routed.threads.list', {})).toMatchObject({ ok: true })
      expect(await rpc('bots.get', { botId: BOT })).toMatchObject({ summary: { id: BOT } })
      expect(await rpc('bots.chat.send', { botId: BOT, text: 'What is on today?', clientRequestId: `chat-${index}` }, { idem: `chat-${index}` })).toMatchObject({ message: { text: 'What is on today?' } })
      expect(reached).toEqual(['chatSend:What is on today?'])

      // Work is refused, a person's call and an agent's alike, in every family, before anything runs.
      const refused: Array<[string, Record<string, unknown>]> = [
        ['routed.threads.create', { name: 'New' }],
        ['routed.threads.create', { name: 'New', agent: mark() }],
        ['routed.orchestrator.send', { threadId: thread.id, content: 'Go on' }],
        ['routed.orchestrator.send', { threadId: thread.id, content: 'Go on', agent: mark() }],
        ['routed.orchestrator.steer', { threadId: thread.id, text: 'Stop there' }],
        ['routed.orchestrator.steer', { threadId: thread.id, text: 'Stop there', agent: mark() }],
        ['routed.orchestrator.abort', { threadId: thread.id }],
        ['routed.orchestrator.abort', { threadId: thread.id, agent: mark() }],
        ['routed.files.read', { threadId: thread.id, path: 'a.txt' }],
        ['threads.create', { name: 'From a phone' }],
        ['orchestrator.send', { threadId: thread.id, content: 'From a phone' }]
      ]
      for (const [method, params] of refused)
        await expect(rpc(method, params, { idem: `${method}-${index}-${JSON.stringify(params).length}` }), method).rejects.toMatchObject(forbidden('work_off'))
      // Making a bot follows the bot level, not Work on threads: at Use (the default) it is refused for that.
      const make = { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy notes', clientRequestId: `make-${index}` }
      await expect(rpc('bots.create', make, { idem: `make-${index}` })).rejects.toMatchObject(forbidden('bots_full_needed'))
      expect(reached).toEqual(['chatSend:What is on today?'])
      expect(receiver.threads.getThread(thread.id)?.name).toBe('Plan B')
      // The result it asked for earlier cannot be read back either.
      await expect(session.rpcResult(renamed, { deadlineMs: 15_000 })).rejects.toMatchObject(forbidden('work_off'))

      // On again, the same device works again, and gets its saved result.
      await receiver.net.request('bridge.policy', { node: callerNode, work: true })
      expect(await session.rpcResult(renamed, { deadlineMs: 15_000 })).toMatchObject({ ok: true })
      expect(await rpc('routed.threads.pin', { threadId: thread.id, pinned: true }, { idem: `pin-${index}` })).toMatchObject({ ok: true })
    }, 120_000)

  it('a person and an agent on the calling computer are told why, in words', async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, work: false })
    try {
      const thread = t.thread('Shared')
      const client = t.client()
      const person = await t.refused(client.call(t.node, 'orchestrator.send', { threadId: thread.id, content: 'Go on' }, { idem: 'person-send' }))
      expect(person).toMatchObject({ code: 'computer_forbidden', details: { reason: 'work_off' } })
      expect(person.message).toContain('view threads only')
      const agent = await t.refused(client.call(t.node, 'threads.create', { name: 'Launched', agent: mark() }, { idem: 'agent-create' }))
      expect(agent).toMatchObject({ code: 'computer_forbidden', details: { reason: 'work_off' } })
      // Reading goes on.
      expect(await client.call(t.node, 'threads.get', { threadId: thread.id })).toBeTruthy()
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, work: true })
    }
  }, 60_000)
})
