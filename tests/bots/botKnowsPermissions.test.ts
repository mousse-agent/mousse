/**
 * A bot is told what its owner allows now, on every turn of every lane, and the tools it gets match what it is told:
 * the chat (front desk) hears what its work holds, a run what it holds itself, and a change in About or an Allow shows
 * at the next turn. A bot's thread lists only Mousse tools a bot can hold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botAllowedOf, botAllowedText, botInstructions, type BotAllowed } from '../../src/mms/bots/instructions'
import { compileBotThread, botManifestDigest } from '../../src/mms/bots/grants/compile'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { ToolRegistry } from '../../src/mms/run/mcp/appTools/registry'
import type { MousseTool } from '../../src/mms/run/mcp/appTools/types'
import { BOT_APP_TOOLS, BOT_AUTOMATION_APP_TOOLS, BOT_BROWSER_TOOLS, BOT_WORK_TOOLS, botMayBeOffered, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { withPermission } from '../../src/shared/bots/personal/escalation'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

const ALLOWED = 'What your owner allows now'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  // The real system text, as the profile builds it.
  f.host.instructions = (bot) => botInstructions(bot)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

/** The line of the permissions section about `what`. */
const line = (instructions: string | undefined, what: string) => instructions!.slice(instructions!.indexOf(ALLOWED)).split('\n').find((row) => row.startsWith(`- ${what}`))

/** The owner allows `permission` from a chat ask card, as the Allow button does. */
async function allow(permission: { tool: string } | { path: string; access: 'write' }, id: string) {
  const { prepared, payload } = await chat('Please do it.', id)
  prepared.authority.escalate!({ permission, reason: 'The owner asked.' })
  await finish(f, payload, 'completed', { text: "I've asked." })
  await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
  // The walled turn's continuation, if it started, is settled so the chat is free again.
  for (const row of f.store.laneActivations(botId, 'chat', ['running'])) {
    const n = f.store.lastMainDispatch(row.id)!.n
    const next = await start(f, row.id, n)
    await finish(f, next.payload, 'completed', { text: 'Done.' })
  }
}

describe('every phase states what the owner allows now', () => {
  it('the chat turn and its work both state the current permissions, and a starter bot is told what it lacks', async () => {
    const first = await chat('Find me a good vacuum', 'm1')
    const text = first.prepared.instructions!
    expect(text).toContain(ALLOWED)
    expect(line(text, 'Search the web')).toMatch(/: yes$/)
    expect(line(text, 'Use files on this computer')).toMatch(/: no, only your files folder$/)
    expect(line(text, 'Run commands')).toMatch(/: no$/)
    expect(line(text, 'Use the browser')).toMatch(/: no$/)
    // The front desk is told its work has the web, though the chat is not offered it.
    expect(text).toContain('hand jobs that need them to work_start')
    expect(first.prepared.policy.tools!.allow).not.toContain('web_fetch')

    const started = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Vacuums', brief: 'Compare vacuums.', key: 'k1' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, started.workId)
    expect(work.prepared.lane).toBe('run')
    expect(line(work.prepared.instructions, 'Search the web')).toMatch(/: yes$/)
    expect(work.prepared.instructions).toContain('Use what is allowed without asking')
    expect(work.prepared.policy.tools!.allow).toContain('web_fetch')
  })

  it('an Allow shows at the next turn, in the chat and in the work, with the matching tools', async () => {
    await allow({ tool: 'browser' }, 'a1')
    await allow({ tool: 'shell' }, 'a2')
    await allow({ path: '/Users', access: 'write' }, 'a3')
    expect(f.bots.service.get(botId).permissions.map((permission) => permission.title).sort()).toEqual(['run commands', 'use files on this computer', 'use the browser'])

    const turn = await chat('Open example.com and tell me its title', 'm2')
    for (const what of ['Run commands', 'Use the browser']) expect(line(turn.prepared.instructions, what)).toMatch(/: yes$/)
    expect(line(turn.prepared.instructions, 'Use files on this computer')).toMatch(/: yes, any folder except Mousse's own data$/)
    // The chat hands those jobs off: it is not offered them, and an ask for one is answered "your work has it".
    expect(turn.prepared.policy.tools!.allow).not.toContain('browser_open')

    const started = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Page title', brief: 'Open example.com.', key: 'k2' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    const work = await start(f, started.workId)
    for (const what of ['Run commands', 'Use the browser']) expect(line(work.prepared.instructions, what)).toMatch(/: yes/)
    const allowed = work.prepared.policy.tools!.allow!
    expect(allowed).toContain('browser_open')
    expect(allowed).toContain('bash')
    expect(work.prepared.authority.workspace?.computer).toBeDefined()
  })

  it('a permission removed in About shows at the next turn, and its tools go with it', async () => {
    await allow({ tool: 'browser' }, 'a1')
    const before = await chat('Hi', 'm2')
    expect(line(before.prepared.instructions, 'Use the browser')).toMatch(/: yes$/)
    await finish(f, before.payload, 'completed', { text: 'Hi.' })
    f.bots.service.revokePermission(botId, askFingerprintOf({ tool: 'browser' }))
    expect(line((await chat('Open it again', 'm3')).prepared.instructions, 'Use the browser')).toMatch(/: no$/)
    const run = await f.bots.activate({ botId, input: 'Check the page', clientRequestId: 'r1' })
    const { prepared } = await start(f, run.id)
    expect(line(prepared.instructions, 'Use the browser')).toMatch(/: no$/)
    expect(prepared.policy.tools!.allow).not.toContain('browser_open')
  })

  it('a scheduled run states what it holds', async () => {
    await allow({ tool: 'shell' }, 'a1')
    const run = await f.bots.activate({ botId, input: 'Tidy my downloads', clientRequestId: 'r1' })
    const { prepared } = await start(f, run.id)
    expect(prepared.lane).toBe('run')
    expect(line(prepared.instructions, 'Run commands')).toMatch(/: yes$/)
    expect(prepared.policy.tools!.allow).toContain('bash')
  })
})

describe('the stated permissions match the tools a run is given', () => {
  const grants: Array<[string, BotManifest]> = [
    ['starter', botStarterManifest()],
    ['browser', withPermission(botStarterManifest(), { tool: 'browser' })],
    ['shell', withPermission(botStarterManifest(), { tool: 'shell' })],
    ['files', withPermission(botStarterManifest(), { path: '/Users', access: 'write' })],
    ['skill', withPermission(botStarterManifest(), { skill: 'pdf' })],
    ['automation', withPermission(botStarterManifest(), { tool: 'automation_draft_save' })],
    ['no web', { ...botStarterManifest(), appTools: botStarterManifest().appTools.filter((tool) => !tool.startsWith('web_')) }]
  ]
  for (const [name, grant] of grants)
    it(`${name}: each yes is a tool the run holds, each no is one it lacks`, () => {
      const compiled = compileBotThread({
        grant, digest: botManifestDigest(grant), thread: {}, scratch: '/tmp/bp-scratch', profileHome: '/tmp/bp-profile',
        nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }, computer: ['/'],
        botTools: { escalate: true, consult: false, memory: true }
      })
      if (!compiled.ok) throw new Error(compiled.error.message)
      const allow = new Set(compiled.policy.tools!.allow)
      const said: BotAllowed = botAllowedOf(grant)
      expect(said.shell).toBe(allow.has('shell'))
      expect(said.browser).toBe(BOT_BROWSER_TOOLS.every((tool) => allow.has(tool)))
      expect(said.web).toBe(allow.has('web_fetch') || allow.has('web_search'))
      expect(said.files).toBe(compiled.permissions.workspace?.computer !== undefined)
      expect(said.skills).toEqual(compiled.permissions.skills)
      expect(said.automation).toEqual(BOT_AUTOMATION_APP_TOOLS.filter((tool) => allow.has(tool)))
      // Every Mousse tool the run is offered is one a bot's thread lists.
      for (const tool of compiled.permissions.appTools) expect(botMayBeOffered(tool), tool).toBe(true)
    })

  it('the text says yes or no for each permission, in plain words', () => {
    const text = botAllowedText({ files: false, shell: true, browser: true, web: true, skills: [], automation: [] }, 'run', true)
    expect(text.split('\n')).toEqual([
      'What your owner allows now (current; it replaces anything said earlier in this chat)',
      '- Search the web and read pages: yes',
      '- Use files on this computer: no, only your files folder',
      '- Run commands: yes',
      "- Use the browser (your own): yes, but it can't open on this run",
      '- Skills: none',
      '- Automation tools: none',
      'Use what is allowed without asking. Ask with escalate only for something marked no.'
    ])
  })
})

describe("a bot's thread lists only tools a bot can hold", () => {
  const tool = (name: string): MousseTool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, access: 'reads', class: 'read', handler: async () => ({ text: '' }) }) as unknown as MousseTool
  const names = ['delegate_task', 'thread_read', 'queue_enqueue', 'browser_open', 'browser_request_human', 'web_fetch', 'work_start', 'escalate']

  it('lists no delegation or thread tools on a bot thread, and every tool on any other', () => {
    const registry = new ToolRegistry({ activeRunId: () => null, botRole: (threadId) => (threadId === 'bot-home' ? 'activation' : undefined) })
    for (const name of names) registry.register(tool(name))
    expect(registry.listForThread('bot-home').map((entry) => entry.name).sort()).toEqual(['browser_open', 'escalate', 'web_fetch', 'work_start'])
    expect(registry.listForThread('other').map((entry) => entry.name).sort()).toEqual([...names].sort())
    expect(registry.isBotThread('bot-home')).toBe(true)
    expect(registry.isBotThread('other')).toBe(false)
  })

  it('a bot can hold every grantable tool, the browser tools and the work tools', () => {
    for (const name of [...BOT_APP_TOOLS].filter((name) => name !== 'browser')) expect(botMayBeOffered(name), name).toBe(true)
    for (const name of [...BOT_BROWSER_TOOLS, ...BOT_WORK_TOOLS, 'consult', 'list_skills', 'load_skill']) expect(botMayBeOffered(name), name).toBe(true)
    for (const name of ['delegate_task', 'thread_read', 'browser_request_human', 'browser']) expect(botMayBeOffered(name), name).toBe(false)
  })
})
