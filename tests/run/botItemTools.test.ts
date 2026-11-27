import { afterEach, describe, expect, it } from 'vitest'
import { botItemTools } from '../../src/mms/run/mcp/appTools/botItems'
import type { BotMemoryToolHost } from '../../src/mms/run/mcp/appTools/botMemory'
import { ToolRegistry } from '../../src/mms/run/mcp/appTools/registry'
import type { AppToolTurn, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { BOT_ITEM_TOOLS } from '../../src/shared/bots/personal/items'
import { disposeFixtures, memoryFixture, type MemoryFixture } from '../bots/memory/memoryFixture'
import { appTurn, refusalOf } from './appToolsFixture'

/**
 * The open items' tools as a bot calls them: the bot and the kind of turn come from the host, never from arguments;
 * an ask is listed against the owner's message that started the turn; what the owner did not start is marked so.
 */

afterEach(disposeFixtures)

const activations: Record<string, { botId: string; activationId: string; lane: 'chat' | 'run'; memoryLane?: 'chat' | 'run'; role?: 'home' | 'activation' | 'context' }> = {
  'ada-home': { botId: 'ada', activationId: 'act-chat', lane: 'chat', memoryLane: 'chat' },
  'ada-run': { botId: 'ada', activationId: 'act-run', lane: 'run' },
  'bob-home': { botId: 'bob', activationId: 'act-bob', lane: 'chat', memoryLane: 'chat' }
}

const turn = (threadId: string, activationId?: string): AppToolTurn => ({
  turnToken: 't',
  ...appTurn({ threadId, runId: 'r', ...(activationId ? { bot: { activationId } as BotAuthority } : {}) })
})

function context(threadId: string, activationId?: string): ToolCallContext {
  return {
    caller: { threadId, runId: 'r', provider: 'pi', accessLevel: 'lineage' },
    turn: turn(threadId, activationId),
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    transport: 'mcp'
  }
}

function setup(fx: MemoryFixture) {
  const host: BotMemoryToolHost = { activationOf: (threadId) => activations[threadId], memory: fx.store }
  const tools = new Map(botItemTools(host).map((tool) => [tool.name, tool]))
  const call = async (name: string, threadId: string, args: Record<string, unknown>) => {
    const outcome = await tools.get(name)!.handler(args, context(threadId, activations[threadId]?.activationId ?? 'none'))
    return { ...outcome, value: JSON.parse(outcome.text.startsWith('{') ? outcome.text : '{}') as { id?: string; item?: string; items?: string[]; open?: number; closed?: number; note?: string }, refusal: refusalOf(outcome) }
  }
  return { call, tools }
}

describe('the open items tools', () => {
  it('are the two BOT_ITEM_TOOLS, register cleanly, and list only on bot threads', () => {
    const { tools } = setup(memoryFixture())
    expect([...tools.keys()]).toEqual([...BOT_ITEM_TOOLS])
    const registry = new ToolRegistry({ activeRunId: () => null })
    for (const tool of tools.values()) {
      registry.register(tool)
      expect(tool.listed?.({ readOnly: false })).toBe(false)
      expect(tool.listed?.({ readOnly: false, botRole: 'activation' })).toBe(true)
      expect(tool.available?.(turn('x'))).toBe('Only a bot has a memory.')
      expect(tool.available?.(turn('x', 'act'))).toBe(true)
    }
  })

  it('lists an ask against the message that started the turn, and reads it back as it moves', async () => {
    const fx = memoryFixture()
    const { call } = setup(fx)
    const asked = fx.message({ botId: 'ada', id: 'o1', author: 'owner', text: 'Please redesign the usage page.', activationId: 'act-chat' })
    const added = await call('item_save', 'ada-home', { text: 'Redesign the usage page' })
    expect(added.isError).toBeFalsy()
    expect(added.value).toMatchObject({ id: 'i1', open: 1 })
    expect(added.value.item).toContain(`- i1 · todo · Redesign the usage page · j${asked}`)

    // The same ask again adds nothing.
    expect((await call('item_save', 'ada-home', { text: 'redesign the usage page' })).value).toMatchObject({ id: 'i1', open: 1, note: 'That item is already on your list.' })

    const moved = await call('item_save', 'ada-home', { id: 'i1', state: 'building', note: 'built, in the dev app, not shipped', links: ['mousse://thread/t9'] })
    expect(moved.value.item).toContain('- i1 · building · Redesign the usage page (built, in the dev app, not shipped)')
    expect(moved.value.item).toContain('mousse://thread/t9')

    await call('item_save', 'ada-home', { id: 'i1', state: 'done' })
    expect((await call('item_list', 'ada-home', {})).value).toMatchObject({ items: [], open: 0, closed: 1 })
    const closed = await call('item_list', 'ada-home', { state: 'closed', query: 'usage' })
    expect(closed.value.items).toHaveLength(1)
    expect(closed.value.items![0]).toContain('- i1 · done · Redesign the usage page')
  })

  it('counts the open items at each stage, so a status answer comes from the list', async () => {
    const fx = memoryFixture()
    const { call } = setup(fx)
    const stages = ['investigating', 'building', 'in_dev', 'in_dev', 'approved', 'waiting', 'done', 'dropped']
    for (const [index, state] of stages.entries()) expect((await call('item_save', 'ada-home', { text: `Ask ${index}`, state })).isError).toBeFalsy()
    const listing = (await call('item_list', 'ada-home', {})).value as { open?: number; closed?: number; stages?: Record<string, number>; items?: string[] }
    expect(listing).toMatchObject({ open: 6, closed: 2, stages: { investigating: 1, building: 1, in_dev: 2, approved: 1, waiting: 1 } })
    // Closed stages are not counted as open work.
    expect(listing.stages).not.toHaveProperty('done')
    expect((await call('item_list', 'ada-home', { state: 'in_dev' })).value.items).toHaveLength(2)
  })

  it('marks what unattended work adds, and never shows one bot another bot\'s items', async () => {
    const fx = memoryFixture()
    const { call } = setup(fx)
    const added = await call('item_save', 'ada-run', { text: 'Tell the owner when the nightly is out' })
    expect(added.value.item).toContain('added in your unattended work')
    expect((await call('item_list', 'bob-home', { state: 'all' })).value).toMatchObject({ items: [], open: 0, closed: 0 })
    // And another bot's id names nothing of its own.
    expect((await call('item_save', 'bob-home', { id: 'i1', state: 'done' })).isError).toBe(true)
    expect((await call('item_list', 'ada-run', {})).value.items).toHaveLength(1)
  })

  it.each([
    ['a new item without words', { state: 'building' }],
    ['an unknown state', { text: 'Ship it', state: 'shipped' }],
    ['an item that does not exist', { id: 'i404', state: 'done' }],
    ['a source that is no row of the chat', { text: 'Ship it', source: 'j999' }],
    ['links that are no list', { text: 'Ship it', links: 'mousse://thread/t1' }]
  ])('refuses %s, in words, and keeps the list as it was', async (_name, args) => {
    const fx = memoryFixture()
    const { call } = setup(fx)
    const outcome = await call('item_save', 'ada-home', args)
    expect(outcome.isError).toBe(true)
    expect(outcome.text.length).toBeGreaterThan(10)
    expect((await call('item_list', 'ada-home', { state: 'all' })).value).toMatchObject({ items: [], open: 0, closed: 0 })
  })

  it('refuses a thread that is no bot turn, or a turn of another activation', async () => {
    const fx = memoryFixture()
    const { call, tools } = setup(fx)
    expect(await call('item_save', 'stranger', { text: 'Ship it' })).toMatchObject({ text: 'Only a bot has a memory.', isError: true })
    expect(await tools.get('item_list')!.handler({}, context('ada-home', 'act-bob'))).toMatchObject({ isError: true, text: 'This turn does not belong to that bot.' })
  })
})
