/**
 * A bot's chat makes quick calls itself (#1361; docs/bots.md, "Quick calls in the chat"): the web through Mousse's own
 * tools (never Claude Code's or Codex's), a bound service's read, and its owner's MCP tools through its catalogue, each
 * within the chat's budgets (`ChatQuickCalls`). A call known to only read stops at its deadline or when the owner writes,
 * and says to hand the job to work; any other call is never stopped by the owner's message, and one its deadline cuts
 * after it was sent is `uncertain`. Commands, the browser and the computer stay work's.
 *
 * The engine runs over a real `bots.db`; each call goes through the registered tool dispatch (`createAppToolRegistry`),
 * the owner's servers are a real `BotMcp` over a fake catalogue and connection, and the web a fake provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotMcp } from '../../src/mms/bots/mcp/BotMcp'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { claudeLockedTools } from '../../src/mms/harness/claude/locked'
import { codexBotWebOff } from '../../src/mms/harness/vendors/codex/childPolicy'
import { RelayHandler } from '../../src/mms/run/mcp/relay/handler'
import type { RelayTool } from '../../src/mms/run/mcp/relay/names'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import { defaultIntegrationActor } from '../../src/shared/integrations/actor'
import { BOT_MCP_SERVER_SWITCH } from '../../src/shared/bots/personal/manifest'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from '../run/appToolsFixture'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

const tool = (server: string, serverName: string, name: string, readOnlyHint: boolean): McpToolDescriptor => ({
  id: `${server}:${name}`, serverId: `mousse:${server}`, installationId: server, serverName, toolName: name,
  providerName: `mcp__${serverName}__${name}`, description: `${name} of ${serverName}`, inputSchema: { type: 'object', properties: {} }, readOnlyHint,
  configRevision: 'revision-1'
})
const SERVERS = [
  { installationId: 'srv-github', serverName: 'GitHub', tools: [tool('srv-github', 'GitHub', 'list_issues', true), tool('srv-github', 'GitHub', 'create_issue', false)] },
  { installationId: 'srv-notes', serverName: 'Notes', tools: [tool('srv-notes', 'Notes', 'read_note', true)] }
]
const READ = 'mcp__Notes__read_note'
const WRITE = 'mcp__GitHub__create_issue'

/** Calls that reached the owner's server or the web, and the ones that wait until a test answers them or they are stopped. */
let sent: string[]
let waiting: Map<string, { signal: AbortSignal; answer(text: string): void }>
/** What does not answer by itself. */
let hangs: Set<string>
let mcp: BotMcp
/** Resolves when the owner's connection is ready; a test holds it to change things while a call connects. */
let connected: () => Promise<void>

function reply<T>(name: string, signal: AbortSignal | undefined, value: (text: string) => T, text: string): Promise<T> {
  sent.push(name)
  if (!hangs.has(name)) return Promise.resolve(value(text))
  return new Promise<T>((resolve, reject) => {
    const own = signal ?? new AbortController().signal
    waiting.set(name, { signal: own, answer: (answer) => resolve(value(answer)) })
    own.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), { once: true })
  })
}

const web = {
  execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    reply(name, signal, (text) => ({ text }), name === 'web_fetch' && args.url === 'https://long.example' ? 'x'.repeat(40_000) : `results for ${String(args.query ?? args.url)}`)
}

beforeEach(async () => {
  f = botFixture()
  sent = []
  waiting = new Map()
  hangs = new Set()
  connected = async () => undefined
  mcp = new BotMcp({
    catalog: {
      ensure: async () => undefined,
      servers: () => SERVERS.map((server) => ({ ...server, failing: false, starting: false })),
      listing: (): RelayTool[] => SERVERS.flatMap((server) => server.tools.map((entry) => ({
        name: `${server.serverName}__${entry.toolName}`, description: entry.description ?? '', inputSchema: entry.inputSchema ?? {},
        installationId: server.installationId, serverName: server.serverName, toolName: entry.toolName, providerName: entry.providerName
      })))
    },
    manager: {
      callTool: async (providerName, _args, _project, signal, _actor, expected) => {
        // As the manager does once connected: the pin's last check, right before the server sees the call.
        await connected()
        expected?.assertDispatchActive?.()
        return reply(providerName, signal, (text) => ({ content: [{ type: 'text', text }] }) as never, `result of ${providerName}`)
      }
    },
    enabled: () => true
  })
  f.host.mcp = mcp
  // Codex and Pi: the chat lists only its core set and calls the rest through use_tool.
  f.host.toolCatalogue = () => 'use_tool'
  f.host.chatCallLimits = { callMs: 150, turnMs: 10_000 }
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Kai', reply: 'Hello.' })).botId
})
afterEach(() => f.close())

async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

/** The registry a turn's calls go through, as a runtime's call takes it, with the owner's MCP tools proxied (`use_tool`). */
function registryFor(turn: Awaited<ReturnType<typeof chat>>) {
  const host = fakeAppToolHost({ web: web as never, botRole: (id) => (id === turn.payload.threadId ? 'activation' : undefined) })
  const { registry, turns, request } = appToolRegistry(f.runs, host.host, { bots: () => ({ host: f.bots.tools }), options: { userMcp: {} as never, botMcp: mcp } })
  turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
  let n = 0
  return (name: string, args: Record<string, unknown>) => registry.call(name, args, request({ threadId: turn.payload.threadId, runId: turn.payload.runId, toolCallId: `call-${++n}` }))
}
const use = (call: ReturnType<typeof registryFor>, name: string) => call('use_tool', { tool: name, arguments: {} })

describe("the chat's own quick calls", () => {
  it("has Mousse's web tools, never the runtime's, and hosted web search stays off on Codex", async () => {
    // A grant that holds the web as built-ins too ("Allow for this bot" on a runtime's web call).
    const current = f.host.definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const permissions = { ...current.permissions, tools: [...current.permissions.tools, 'web_search', 'web_fetch'] as typeof current.permissions.tools }
    f.store.setPublished(botId, f.host.definitions.publishRevision({ ...current, permissions }).revision!)
    f.store.approve(botId, botManifestDigest(permissions), permissions)
    const talk = await chat('What is the weather in Pune?', 'm1')
    const authority = talk.prepared.authority
    expect(['web_search', 'web_fetch', 'secret_fetch'].filter((name) => authority.appTools.has(name))).toEqual(['web_search', 'web_fetch', 'secret_fetch'])
    expect(authority.tools.has('web_search') || authority.tools.has('web_fetch')).toBe(false)
    // Claude Code's WebSearch and WebFetch are not offered to the chat's turn, and Codex's own web search is off.
    expect(claudeLockedTools({ authority }, true).tools.filter((name) => name.startsWith('Web'))).toEqual([])
    expect(codexBotWebOff(authority)).toBe(true)
    const { workId } = await f.bots.tools.work.start(botId, talk.activation.id, { title: 'Weather', brief: 'Look up the weather.', key: 'k1' })
    await finish(f, talk.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    expect(codexBotWebOff(work.prepared.authority)).toBe(false)
    expect(claudeLockedTools({ authority: work.prepared.authority }, true).tools.filter((name) => name.startsWith('Web'))).toEqual(['WebFetch', 'WebSearch'])
    // Commands, the browser and the computer stay work's.
    for (const name of ['shell', 'browser', 'computer']) expect(authority.appTools.has(name) || authority.tools.has(name as never)).toBe(false)
  })

  it('searches, fetches and calls an MCP tool through use_tool, its output bounded and its grant held on every call', async () => {
    const talk = await chat('Any notes on the trip?', 'm1')
    const call = registryFor(talk)
    expect((await call('web_search', { query: 'trains to Goa' })).text).toContain('results for trains to Goa')
    const long = await call('web_fetch', { url: 'https://long.example' })
    expect(long.text.length).toBeLessThan(33_000)
    expect(long.text).toMatch(/more characters were cut\]$/)
    // The MCP tools are not listed to the chat's runtime: its catalogue names them, and use_tool runs them.
    const relay = new RelayHandler({ botOf: () => talk.prepared.authority } as never)
    expect(relay.list({ relay: { approvals: 'grants' }, threadId: talk.payload.threadId } as never)).toEqual([])
    const entry = await call('tool_catalogue', { group: 'mcp' })
    expect(entry.text).toContain(`## ${READ}`)
    expect(entry.text).toContain(`## ${WRITE}`)
    expect((await use(call, READ)).text).toContain(`result of ${READ}`)
    // Switched off while the turn runs: the next call through use_tool is refused before the server sees it.
    f.bots.service.setPermission(botId, `${BOT_MCP_SERVER_SWITCH}srv-notes`, false)
    const off = await use(call, READ)
    expect(off.isError).toBe(true)
    expect(sent.filter((name) => name === READ)).toHaveLength(1)
  })
})

describe('budgets, deadlines and the owner writing', () => {
  it('a new owner message stops a call that only reads at once, and never one that may write', async () => {
    f.host.chatCallLimits = { callMs: 5_000, turnMs: 10_000 }
    const talk = await chat('Read my trip note and file the visa issue.', 'm1')
    const call = registryFor(talk)
    hangs = new Set([READ, WRITE, 'web_search'])
    const reading = use(call, READ)
    const searching = call('web_search', { query: 'visa rules' })
    const writing = use(call, WRITE)
    await flush()
    expect([...waiting.keys()].sort()).toEqual(['web_search', WRITE, READ].sort())

    await f.bots.service.chatSend({ botId, text: 'Actually, wait.', clientRequestId: 'm2' })
    const [read, search] = await Promise.all([reading, searching])
    for (const outcome of [read, search]) expect(refusalOf(outcome)?.refused).toMatchObject({ code: 'cancelled', message: expect.stringContaining('your owner wrote') })
    expect(waiting.get(READ)!.signal.aborted).toBe(true)
    // The write goes on: the steer reaches the turn at its next step, and the call's own answer comes back.
    expect(waiting.get(WRITE)!.signal.aborted).toBe(false)
    waiting.get(WRITE)!.answer('Issue #12 filed.')
    expect((await writing).text).toContain('Issue #12 filed.')
  })

  it('at its deadline a call that only reads says work_required; one that may write is uncertain, with work_start the fix', async () => {
    const talk = await chat('Read my note and file an issue.', 'm1')
    const call = registryFor(talk)
    hangs = new Set([READ, WRITE])
    expect(refusalOf(await use(call, READ))?.refused).toMatchObject({ code: 'work_required', fix: 'work_start' })
    expect(waiting.get(READ)!.signal.aborted).toBe(true)
    const write = refusalOf(await use(call, WRITE))?.refused
    expect(write).toMatchObject({ code: 'uncertain', fix: 'work_start', retry: 'never' })
    // The deadline stopped the call; what the server says after it is dropped.
    expect(waiting.get(WRITE)!.signal.aborted).toBe(true)
  })

  it('calls that overlap share the total on the clock: one started while another runs gets only what is left of it', async () => {
    f.host.chatCallLimits = { callMs: 1_000, turnMs: 1_200 }
    const talk = await chat('Look two things up.', 'm1')
    const call = registryFor(talk)
    hangs = new Set([READ, 'web_search'])
    const reading = use(call, READ)
    await new Promise((resolve) => setTimeout(resolve, 500))
    // Started while the first still runs: about 700 ms of the 1,200 are left, so it is cut by the total, before its
    // own 1,000 ms, and the two never keep the turn busy past 1,200 ms together.
    const search = refusalOf(await call('web_search', { query: 'two' }))?.refused
    expect(search).toMatchObject({ code: 'work_required', message: expect.stringContaining("this turn's") })
    expect(refusalOf(await reading)?.refused.code).toBe('work_required')
    const before = sent.length
    expect(refusalOf(await call('web_fetch', { url: 'https://example.com' }))?.refused.message).toContain("didn't run")
    expect(sent).toHaveLength(before)
  })

  it.each([
    ['from another device', async () => { await f.bots.service.chatSend({ botId, text: 'From my phone: stop.', clientRequestId: 'p1', from: { limit: 'ask' } }) }],
    ['while a turn the owner did not start runs', async () => { await f.bots.service.chatSend({ botId, text: 'Actually, wait.', clientRequestId: 'm2' }) }]
  ] as const)('a message %s that waits for its own turn still stops the running call that only reads', async (_case, write) => {
    f.host.chatCallLimits = { callMs: 5_000, turnMs: 10_000 }
    const notOwner = _case.startsWith('while')
    let talk
    if (notOwner) {
      const row = f.store.activation((await f.bots.enqueueChat(botId, 'botmsg:b1:m1', 'Another bot asks you to read the note.')).id)!
      await flush()
      talk = { activation: row, ...(await start(f, row.id)) }
    } else talk = await chat('Read my trip note.', 'm1')
    const call = registryFor(talk)
    hangs = new Set([READ, WRITE])
    const reading = use(call, READ)
    const writing = use(call, WRITE)
    await flush()
    await write()
    // The message did not join this turn: it was queued as a turn of its own.
    expect(f.store.laneActivations(botId, 'chat', ['queued'])).toHaveLength(1)
    expect(refusalOf(await reading)?.refused).toMatchObject({ code: 'cancelled', message: expect.stringContaining('comes to you after this turn') })
    expect(waiting.get(WRITE)!.signal.aborted).toBe(false)
    waiting.get(WRITE)!.answer('Issue #12 filed.')
    expect((await writing).text).toContain('Issue #12 filed.')
  })

  it("the owner's answer to a work's question, written on its bubble, still stops the chat's running call that only reads", async () => {
    f.host.chatCallLimits = { callMs: 5_000, turnMs: 10_000 }
    // Work that asked its owner a question and waits for the answer.
    const asking = await chat('Find me a flat.', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, asking.activation.id, { title: 'Flat hunt', brief: 'Find two flats.', key: 'w1' })
    await finish(f, asking.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    const askOwner = botTools(() => ({ host: f.bots.tools })).find((entry) => entry.name === 'ask_owner') as MousseTool
    await askOwner.handler({ question: 'Which flat?', choices: ['Flat A', 'Flat B'] }, {
      caller: { threadId: work.payload.threadId, runId: 'r', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
      turn: { threadId: work.payload.threadId, bot: work.prepared.authority }, toolCallId: 'ask-1', signal: new AbortController().signal, transport: 'mcp'
    } as unknown as ToolCallContext)
    await finish(f, work.payload, 'completed', { text: 'I asked which flat.' })
    const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === workId)!
    // The chat reads a note while the owner answers the work in their own words, on the question's bubble.
    const talk = await chat('Read my trip note.', 'm2')
    const call = registryFor(talk)
    hangs = new Set([READ])
    const reading = use(call, READ)
    await flush()
    await f.bots.service.chatSend({ botId, text: 'Flat A, please.', clientRequestId: 'm3', replyTo: bubble.id })
    expect(f.store.question(bubble.question!.questionId)?.status).toBe('answered')
    expect(refusalOf(await reading)?.refused).toMatchObject({ code: 'cancelled' })
    expect(waiting.get(READ)!.signal.aborted).toBe(true)
  })

  it('a tool whose server drops its read-only hint while it runs is never stopped by the owner, and its deadline is uncertain', async () => {
    f.host.chatCallLimits = { callMs: 400, turnMs: 10_000 }
    const talk = await chat('Read my trip note.', 'm1')
    const call = registryFor(talk)
    hangs = new Set([READ])
    const note = SERVERS[1]!.tools[0]!
    try {
      const reading = use(call, READ)
      await flush()
      // The listing as it is now says nothing of only reading: the call may write.
      note.readOnlyHint = false
      await f.bots.service.chatSend({ botId, text: 'Actually, wait.', clientRequestId: 'm2' })
      await flush()
      expect(waiting.get(READ)!.signal.aborted).toBe(false)
      expect(refusalOf(await reading)?.refused).toMatchObject({ code: 'uncertain' })
    } finally {
      note.readOnlyHint = true
    }
  })

  it("holds a turn's calls to their total: once it is spent, nothing more is sent", async () => {
    f.host.chatCallLimits = { callMs: 150, turnMs: 250 }
    const talk = await chat('Look a few things up.', 'm1')
    const call = registryFor(talk)
    hangs = new Set(['web_search', READ])
    expect(refusalOf(await call('web_search', { query: 'one' }))?.refused.code).toBe('work_required')
    // The rest of the total: cut sooner than one call's own deadline.
    expect(refusalOf(await use(call, READ))?.refused).toMatchObject({ code: 'work_required', message: expect.stringContaining("this turn's") })
    const before = sent.length
    const spent = refusalOf(await call('web_fetch', { url: 'https://example.com' }))?.refused
    expect(spent).toMatchObject({ code: 'work_required', fix: 'work_start', message: expect.stringContaining("didn't run") })
    expect(sent).toHaveLength(before)
  })
})
