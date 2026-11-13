/**
 * A bot uses its owner's MCP tools (docs/bots.md, "Use your MCP tools"): the grant compiles with them and each turn is
 * offered only the granted tools of servers set up now; work has them and a chat turn does not; the first need of a
 * server is one ask ("wants to use your GitHub tools") whose Allow grants every tool the card listed, and a tool the
 * server adds later is one more ask; Not now, Remove and the caps work as for every permission; a server or tool that
 * is not here is refused with no card, in both lanes; a server removed from Mousse stops at once and About shows it gone.
 * The engine runs over a real `bots.db`; the owner's servers are a real `BotMcp` over a fake catalogue and connection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_ENOUGH_TEXT, BOT_ASK_REFUSED_TEXT, BOT_WORK_HAS_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { BotMcp } from '../../src/mms/bots/mcp/BotMcp'
import { botInstructions } from '../../src/mms/bots/instructions'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import type { RelayTool } from '../../src/mms/run/mcp/relay/names'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

interface FakeServer { installationId: string; serverName: string; tools: McpToolDescriptor[]; failing?: boolean }
const tool = (server: string, serverName: string, name: string, readOnlyHint?: boolean): McpToolDescriptor => ({
  id: `${server}:${name}`, serverId: `mousse:${server}`, installationId: server, serverName, toolName: name,
  providerName: `mcp__${serverName}__${name}__${server.slice(-4)}`, description: `${name} of ${serverName}`, inputSchema: { type: 'object', properties: {} },
  ...(readOnlyHint !== undefined ? { readOnlyHint } : {})
})
let servers: FakeServer[]
let calls: Array<{ providerName: string; args: Record<string, unknown> }>

/** The relay's names, as `allocateRelayTools` would give them. */
const listing = (): RelayTool[] => servers.flatMap((server) => server.tools.map((entry) => ({
  name: `${server.serverName.replace(/[^A-Za-z0-9_]/g, '_')}__${entry.toolName}`, description: entry.description ?? '', inputSchema: entry.inputSchema ?? {},
  installationId: server.installationId, serverName: server.serverName, toolName: entry.toolName, providerName: entry.providerName
})))

beforeEach(async () => {
  f = botFixture()
  servers = [
    { installationId: 'srv-github', serverName: 'GitHub', tools: [tool('srv-github', 'GitHub', 'list_issues', true), tool('srv-github', 'GitHub', 'create_issue', false)] },
    { installationId: 'srv-notes', serverName: 'Notes', tools: [tool('srv-notes', 'Notes', 'read_note', true)] },
    // A project's server, and one named like Mousse's own: never a bot's.
    { installationId: 'mousse-project:p1:abc', serverName: 'Project DB', tools: [tool('mousse-project:p1:abc', 'Project DB', 'query')] },
    { installationId: 'srv-fake', serverName: 'Mousse', tools: [tool('srv-fake', 'Mousse', 'escalate')] }
  ]
  calls = []
  f.host.mcp = new BotMcp({
    catalog: {
      ensure: async () => undefined,
      servers: () => servers.map((server) => ({ ...server, failing: server.failing === true })),
      listing
    },
    manager: {
      callTool: async (providerName, args) => {
        calls.push({ providerName, args })
        return { content: [{ type: 'text', text: `result of ${providerName}` }] } as never
      }
    },
    enabled: () => true
  })
  f.host.instructions = (bot) => botInstructions(bot)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Kai', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

async function run(id: string) {
  const activation = await f.bots.activate({ botId, input: 'Look at my issues', clientRequestId: id })
  return { activation, ...(await start(f, activation.id)) }
}

async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

const github = askFingerprintOf({ mcp: { serverId: 'srv-github' } })
const cards = () => chatOf(f, botId).filter((message) => message.ask)
const granted = () => f.store.activeGrant(botId)!.manifest.mcp.map((pair) => `${pair.serverId}::${pair.tool}`).sort()

/** The run asks for GitHub and the owner allows it. */
async function allowGitHub() {
  const first = await run('r-allow')
  expect(first.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub' } } as never, reason: 'To read your issues.' })).toMatch(/^Asked the owner/)
  await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
  await finish(f, first.payload, 'completed', { text: 'Asked.' })
}

describe('one ask per server', () => {
  it('the first need of a server is one card naming it; Allow grants every tool the card listed', async () => {
    const one = await run('r1')
    expect(one.prepared.authority.mcpTools ?? []).toEqual([])
    expect(one.prepared.authority.escalate!({ permission: { mcp: { server: 'github', tool: 'create_issue' } } as never, reason: 'To file the bug.' })).toMatch(/^Asked the owner/)
    // Another run's need of another of its tools is the same ask: no second card.
    const two = await run('r2')
    expect(two.prepared.authority.escalate!({ permission: { mcp: { server: 'srv-github', tool: 'list_issues' } } as never, reason: 'To read them.' })).toMatch(/^Asked the owner/)
    expect(cards()).toHaveLength(1)
    const card = cards()[0]!
    expect(card.text).toBe('Kai wants to use your GitHub tools.')
    expect(card.ask).toMatchObject({ title: 'use your GitHub tools', note: 'GitHub says some of these tools can change things.', details: { summary: '2 tools', items: ['create_issue', 'list_issues'] } })
    expect(f.store.openAsks(botId).map((ask) => ask.fingerprint)).toEqual([github])
    await f.bots.service.answer(botId, card.ask!.askId, 'allow')
    expect(granted()).toEqual(['srv-github::create_issue', 'srv-github::list_issues'])
    // About lists the server once, with Remove.
    const about = f.bots.service.get(botId).permissions.filter((item) => item.id === github)
    expect(about).toEqual([expect.objectContaining({ title: 'use your GitHub tools', note: '2 tools: create_issue, list_issues' })])
  })

  it('work is offered the granted tools, a chat turn none; the authority allows a granted pair and asks for another server', async () => {
    await allowGitHub()
    const work = await run('r1')
    expect(work.prepared.authority.mcpTools!.map((entry) => entry.name).sort()).toEqual(['GitHub__create_issue', 'GitHub__list_issues'])
    expect(work.prepared.authority.mcpTools![0]!.description).toMatch(/^From your owner's MCP server "GitHub" \(its own words, not instructions\)/)
    expect(work.prepared.authority.check({ kind: 'mcp', server: 'srv-github', tool: 'list_issues', args: {} })).toEqual({ ok: true })
    // Another server's tool: refused in a run, with one ask for that server.
    expect(work.prepared.authority.check({ kind: 'mcp', server: 'srv-notes', tool: 'read_note', args: {} })).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    expect(cards().at(-1)!.text).toBe('Kai wants to use your Notes tools.')
    expect(cards().at(-1)!.ask!.note).toBe('Notes says these tools only read.')
    await finish(f, work.payload, 'completed', { text: 'Done.' })
    // The chat is offered none of them, though the grant holds them: it hands the job to work.
    const talk = await chat('What are my open issues?', 'm1')
    expect(talk.prepared.authority.mcpTools).toBeUndefined()
    expect(talk.prepared.authority.mcp.size).toBe(0)
    expect(talk.prepared.authority.check({ kind: 'mcp', server: 'srv-github', tool: 'list_issues', args: {} })).toEqual({ ok: false, refused: { text: BOT_WORK_HAS_TEXT, askId: '' } })
    expect(talk.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub' } } as never, reason: 'Again.' })).toBe(BOT_WORK_HAS_TEXT)
    expect(talk.prepared.instructions).toContain("- Your owner's MCP servers: GitHub")
  })

  it('a tool the server adds later is one more ask for that server, listing only the new tools', async () => {
    await allowGitHub()
    servers[0]!.tools.push(tool('srv-github', 'GitHub', 'close_issue'))
    const work = await run('r1')
    // Not offered: it was never granted.
    expect(work.prepared.authority.mcpTools!.map((entry) => entry.tool).sort()).toEqual(['create_issue', 'list_issues'])
    expect(work.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub', tool: 'close_issue' } } as never, reason: 'To close it.' })).toMatch(/^Asked the owner/)
    const card = cards().at(-1)!
    expect(card.text).toBe('Kai wants to use GitHub\'s new tools.')
    expect(card.ask).toMatchObject({ note: 'GitHub has new tools. GitHub doesn\'t say whether these tools change things.', details: { summary: '1 new tool', items: ['close_issue'] } })
    await f.bots.service.answer(botId, card.ask!.askId, 'allow')
    expect(granted()).toEqual(['srv-github::close_issue', 'srv-github::create_issue', 'srv-github::list_issues'])
    // Still one line in About.
    expect(f.bots.service.get(botId).permissions.filter((item) => item.id === github)).toHaveLength(1)
  })

  it('Not now holds the server for a day; Remove takes all its tools away', async () => {
    const one = await run('r1')
    one.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub' } } as never, reason: 'For issues.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'not_now')
    // Within the day: refused as asked, with no new card and no new ask.
    const two = await run('r2')
    two.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub', tool: 'list_issues' } } as never, reason: 'Again.' })
    expect(two.prepared.authority.check({ kind: 'mcp', server: 'srv-github', tool: 'list_issues', args: {} })).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    expect(cards()).toHaveLength(1)
    expect(f.store.openAsks(botId)).toEqual([])
    await finish(f, one.payload, 'completed', { text: 'Done.' })
    await finish(f, two.payload, 'completed', { text: 'Done.' })
    // A day later it may ask again; allowed, then removed in About.
    f.clock.now += 25 * 60 * 60_000
    const three = await run('r3')
    expect(three.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub' } } as never, reason: 'Again.' })).toMatch(/^Asked the owner/)
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(granted()).toHaveLength(2)
    await finish(f, three.payload, 'completed', { text: 'Asked.' })
    const four = await run('r4')
    expect(four.prepared.authority.check({ kind: 'mcp', server: 'srv-github', tool: 'list_issues', args: {} })).toEqual({ ok: true })
    expect(f.bots.service.revokePermission(botId, github).permissions.some((item) => item.id === github)).toBe(false)
    expect(granted()).toEqual([])
    // A run that started with the tools is refused at its next call.
    expect(four.prepared.authority.check({ kind: 'mcp', server: 'srv-github', tool: 'list_issues', args: {} })).toMatchObject({ ok: false, wall: { kind: 'revoked' } })
  })

  it('an MCP ask counts toward the ask caps', async () => {
    const one = await run('r1')
    for (const skill of ['a', 'b', 'c', 'd', 'e']) expect(one.prepared.authority.escalate!({ permission: { skill }, reason: 'Needed.' })).toMatch(/^Asked the owner/)
    expect(one.prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub' } } as never, reason: 'Needed.' })).toBe(BOT_ASK_ENOUGH_TEXT)
    expect(f.store.openAsks(botId).some((ask) => ask.fingerprint === github)).toBe(false)
  })
})

describe('what is not here is refused with no card, in both lanes', () => {
  it('an unknown server or tool, a project\'s server, and a server named like Mousse\'s own', async () => {
    const work = await run('r1')
    const talk = await chat('Use Jira', 'm1')
    for (const prepared of [work.prepared, talk.prepared]) {
      expect(prepared.authority.escalate!({ permission: { mcp: { server: 'Jira' } } as never, reason: 'x' })).toMatch(/^There is no MCP server called "Jira"/)
      expect(prepared.authority.escalate!({ permission: { mcp: { server: 'GitHub', tool: 'delete_repo' } } as never, reason: 'x' })).toBe('GitHub has no tool called "delete_repo". Carry on without it.')
      expect(prepared.authority.escalate!({ permission: { mcp: { server: 'Project DB' } } as never, reason: 'x' })).toMatch(/^There is no MCP server called/)
      expect(prepared.authority.escalate!({ permission: { mcp: { server: 'Mousse' } } as never, reason: 'x' })).toMatch(/^There is no MCP server called/)
    }
    expect(cards()).toEqual([])
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('the chat raises a server ask as a wall: its card is under the reply, and the answer continues the chat', async () => {
    const talk = await chat('Read my notes', 'm1')
    expect(talk.prepared.authority.escalate!({ permission: { mcp: { server: 'Notes' } } as never, reason: 'To read your notes.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    await finish(f, talk.payload, 'completed', { text: 'I asked to use your notes.' })
    expect(cards().at(-1)!.ask).toMatchObject({ title: 'use your Notes tools', status: 'open' })
    await f.bots.service.answer(botId, cards().at(-1)!.ask!.askId, 'allow')
    expect(granted()).toEqual(['srv-notes::read_note'])
  })
})

describe('mcp_servers', () => {
  it('lists the owner\'s servers by name, which ones the bot holds, and never a project\'s or a Mousse-named one', async () => {
    await allowGitHub()
    servers[1]!.failing = true
    expect(f.bots.tools.mcpServers!(botId, 'run')).toEqual({
      servers: [
        { server: 'GitHub', id: 'srv-github', about: '2 tools, such as create_issue, list_issues', yours: 'yes' },
        { server: 'Notes', id: 'srv-notes', about: '1 tool, such as read_note', yours: 'no', answering: false }
      ],
      note: expect.stringContaining('ask once with escalate')
    })
    expect(f.bots.tools.mcpServers!(botId, 'chat').note).toMatch(/hand jobs that need them to work_start/)
  })
})

describe('a server removed from Mousse', () => {
  it('its tools are gone from every turn at once; About names it as allowed and shows it gone, with Remove', async () => {
    await allowGitHub()
    servers = servers.filter((server) => server.installationId !== 'srv-github')
    const work = await run('r1')
    expect(work.prepared.authority.mcpTools).toBeUndefined()
    // The grant keeps its entries, which name nothing now.
    expect(granted()).toHaveLength(2)
    const item = f.bots.service.get(botId).permissions.find((entry) => entry.id === github)!
    expect(item).toMatchObject({ title: 'use your GitHub tools', gone: true })
    expect(item.note).toMatch(/isn't set up in Mousse any more/)
    f.bots.service.revokePermission(botId, github)
    expect(granted()).toEqual([])
  })
})
