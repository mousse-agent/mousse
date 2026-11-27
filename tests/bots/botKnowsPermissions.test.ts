import { botCatalogueGroup } from '../../src/shared/bots/personal/catalogue'
/**
 * A bot is told what its owner allows now, on every turn of every lane, and the tools it gets match what it is told:
 * the chat (front desk) hears what its work holds, a run what it holds itself, and a change in About or an Allow shows
 * at the next turn. A bot's thread lists only Mousse tools a bot can hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_SHELL_WITHHELD_LINE, botAllowedOf, botAllowedText, botInstructions, botShellWithheld, type BotAllowed } from '../../src/mms/bots/instructions'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import { claudeLockedTools, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { botAppToolRefusal } from '../../src/shared/bots/personal/walls'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { refused } from '../../src/mms/run/mcp/appTools/refusal'
import { delegationFixture } from '../run/delegationFixture'
import { compileBotThread, botManifestDigest } from '../../src/mms/bots/grants/compile'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { ToolRegistry } from '../../src/mms/run/mcp/appTools/registry'
import type { MousseTool } from '../../src/mms/run/mcp/appTools/types'
import { BOT_APP_TOOLS, BOT_AUTOMATION_APP_TOOLS, BOT_BROWSER_TOOLS, BOT_GROUP_PERMISSIONS, BOT_PROFILER_TOOLS, BOT_QUICK_ACTION_TOOLS, BOT_SCHEDULE_ACT_TOOLS, BOT_SCHEDULE_READ_TOOLS, BOT_SECRET_TOOLS, BOT_TASK_TOOLS, BOT_THEME_TOOLS, BOT_THREAD_TOOLS, BOT_WORK_TOOLS, botGrantTool, botMayBeOffered, botStarterManifest } from '../../src/shared/bots/personal/manifest'
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
async function allow(permission: { tool: string }, id: string) {
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
    expect(line(text, 'Run commands')).toMatch(/: no$/)
    expect(line(text, 'Use the browser')).toMatch(/: no$/)
    // The chat is told what its work has, and makes a quick web call itself with Mousse's web tools, never the runtime's.
    expect(text).toContain('hand jobs that need them to work_start')
    expect(first.prepared.authority.appTools.has('web_fetch')).toBe(true)
    expect(first.prepared.authority.tools.has('web_fetch')).toBe(false)

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
    expect(f.bots.service.get(botId).permissions.filter((permission) => !permission.builtIn).map((permission) => permission.title).sort()).toEqual(['run commands', 'use the browser'])

    const turn = await chat('Open example.com and tell me its title', 'm2')
    for (const what of ['Run commands', 'Use the browser']) expect(line(turn.prepared.instructions, what)).toMatch(/: yes$/)
    // The chat hands those jobs off: it is not offered them, and an ask for one is answered "your work has it".
    expect(turn.prepared.policy.tools!.allow).not.toContain('browser_open')

    const started = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Page title', brief: 'Open example.com.', key: 'k2' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    const work = await start(f, started.workId)
    for (const what of ['Run commands', 'Use the browser']) expect(line(work.prepared.instructions, what)).toMatch(/: yes/)
    const allowed = work.prepared.policy.tools!.allow!
    expect(allowed).toContain('browser_open')
    expect(allowed).toContain('bash')
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
    ['skill', withPermission(botStarterManifest(), { skill: 'pdf' })],
    ['automation', withPermission(botStarterManifest(), { tool: 'automation_draft_save' })],
    ['no web', { ...botStarterManifest(), appTools: botStarterManifest().appTools.filter((tool) => !tool.startsWith('web_')) }]
  ]
  for (const [name, grant] of grants)
    it(`${name}: each yes is a tool the run holds, each no is one it lacks`, () => {
      const compiled = compileBotThread({
        grant, digest: botManifestDigest(grant), thread: {}, scratch: '/tmp/bp-scratch', profileHome: '/tmp/bp-profile',
        nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }, allSkills: true,
        botTools: { escalate: true, consult: false, memory: true }
      })
      if (!compiled.ok) throw new Error(compiled.error.message)
      const allow = new Set(compiled.policy.tools!.allow)
      const said: BotAllowed = botAllowedOf(grant)
      expect(said.shell).toBe(allow.has('shell'))
      expect(said.browser).toBe(BOT_BROWSER_TOOLS.every((tool) => allow.has(tool)))
      expect(said.web).toBe(allow.has('web_fetch') || allow.has('web_search'))
      // Every skill, as the text says.
      expect(allow.has('skill_load')).toBe(true)
      expect(said.automation).toEqual(BOT_AUTOMATION_APP_TOOLS.filter((tool) => allow.has(tool)))
      // Every Mousse tool the run is offered is one a bot's thread lists.
      for (const tool of compiled.permissions.appTools) expect(botMayBeOffered(tool), tool).toBe(true)
    })

  it('the text says yes or no for each permission, in plain words', () => {
    const text = botAllowedText({ shell: true, browser: true, threads: false, web: true, automation: [] }, 'run', true)
    expect(text.split('\n')).toEqual([
      'What your owner allows now (current; it replaces anything said earlier in this chat)',
      '- Search the web and read pages: yes',
      '- Run commands: yes',
      "- Use the browser (your own): yes, but it can't open on this run",
      "- Use your owner's threads: no",
      '- Use apps on this computer: no',
      '- Skills: yes, every skill your owner has (skill_list)',
      '- Automation tools: none',
      "- Your owner's MCP servers: none set up",
      'Use what is allowed without asking. Ask with permission_ask only for something marked no.'
    ])
    // What the owner switched off of what every bot has is said so.
    const off = botAllowedText({ shell: false, browser: false, threads: false, web: true, automation: [], off: { mcp: true, skills: true, automation: true } }, 'run')
    for (const what of ['Skills', 'Automation tools', "Your owner's MCP servers"]) expect(off).toContain(`- ${what}: switched off by your owner for now, so asking won't help`)
    // The servers it holds tools of, by name; the chat is told they are its work's.
    const chat = botAllowedText({ shell: false, browser: false, threads: false, web: true, automation: [], mcp: ['GitHub', 'Notes'] }, 'chat')
    expect(chat).toContain("- Your owner's MCP servers: GitHub, Notes")
    expect(chat).toContain('In the chat, the browser, commands and apps on this computer are for your work: hand jobs that need them to work_start. The web and MCP tools you may use here for a quick call.')
  })

  it('a locked Claude Code turn with no sandbox is told commands are allowed but not available, and is offered no Bash', async () => {
    const shell = withPermission(botStarterManifest(), { tool: 'shell' })
    const system = botInstructions({ name: 'Pip', description: 'Look things up for me.', lane: 'run', allowed: botAllowedOf(shell) })
    expect(line(system, 'Run commands')).toBe('- Run commands: yes')
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation', permissions: { tools: ['shell'], appTools: [], mcp: [], skills: [], workspace: null },
      waiting: () => false, counters: new RunCounters(), time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    const lockedTurn = async (shellContained: boolean) => {
      const service = { standaloneWorkspace: () => '/mousse/standalone/bot-home', chat: vi.fn(async () => 'done'), commitConversation: vi.fn(), configured: () => true }
      // The admission says whether the sandbox is proven here; the turn itself is not refused for lacking one.
      const adapter = new ClaudeSubscriptionAdapter(() => service as never, () => null, { admit: async () => ({ ok: true as const, shellContained }) })
      const input = { runId: 'run-1', threadId: 'bot-home', instanceId: 'claude-bot', llmProvider: 'claude-subscription', model: 'sonnet', prompt: 'go', cwd: '/mousse/standalone/bot-home', signal: new AbortController().signal, permissionMode: 'ask' } as never
      const host = { tools: {}, bot: authority, bridge: { mcp: null, turnToken: 't', sessionInstructions: system, turnPreamble: '', userMcp: 'native' }, context: { prepareNativeContext: () => undefined, recoverOverflow: () => null, nativeHistoryAfterTurn: () => '' } } as never
      await adapter.startTurn(input, new Proxy({}, { get: () => () => undefined }) as never, { heartbeat: () => undefined, drainSteer: () => undefined } as never, host).catch(() => undefined)
      const locked = (service.chat.mock.calls[0] as unknown as [{ locked: ClaudeLockedTurn }])[0].locked
      return { prompt: locked.systemPrompt, tools: claudeLockedTools(locked, false).tools }
    }
    const withheld = await lockedTurn(false)
    expect(withheld.tools).not.toContain('Bash')
    expect(line(withheld.prompt, 'Run commands')).toBe(BOT_SHELL_WITHHELD_LINE)
    expect(withheld.prompt.replace(BOT_SHELL_WITHHELD_LINE, '- Run commands: yes')).toBe(system)
    const sandboxed = await lockedTurn(true)
    expect(sandboxed.tools).toContain('Bash')
    expect(sandboxed.prompt).toBe(system)
    // A bot not allowed commands keeps its "no".
    const none = botInstructions({ name: 'Pip', description: 'x', lane: 'run', allowed: botAllowedOf(botStarterManifest()) })
    expect(botShellWithheld(none)).toBe(none)
  })
})

describe("a bot's thread lists only tools a bot can hold", () => {
  const tool = (name: string): MousseTool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, access: 'reads', class: 'read', handler: async () => ({ text: '' }) }) as unknown as MousseTool
  const names = ['delegate_task', 'thread_read', 'queue_enqueue', 'browser_open', 'browser_request_human', 'web_fetch', 'work_start', 'permission_ask']

  it('lists no delegation or queue tools on a bot thread, only the thread tools "use your threads" gives, and every tool on any other', () => {
    const registry = new ToolRegistry({ activeRunId: () => null, botRole: (threadId) => (threadId === 'bot-home' ? 'activation' : undefined) })
    for (const name of names) registry.register(tool(name))
    // The thread tools only for a turn that holds them (tests/run/botThreadTools.test.ts): with no turn here, none.
    expect(registry.listForThread('bot-home').map((entry) => entry.name).sort()).toEqual(['browser_open', 'permission_ask', 'web_fetch', 'work_start'])
    expect(registry.listForThread('other').map((entry) => entry.name).sort()).toEqual([...names].sort())
    expect(registry.isBotThread('bot-home')).toBe(true)
    expect(registry.isBotThread('other')).toBe(false)
  })

  it('a browser tool the owner has not allowed says so and how to ask, on every path a call takes', async () => {
    const authority = (appTools: string[]) => ({
      ...createBotAuthority({
        activationId: 'act-1', role: 'activation', permissions: { tools: [], appTools, mcp: [], skills: [], workspace: null },
        waiting: () => false, counters: new RunCounters(), time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
      }),
      escalate: () => 'asked'
    })
    const NOT_ALLOWED = 'Not allowed: you may not use the browser on this turn. If you need it, ask your owner with permission_ask (tool "browser").'
    // The runtime's own gate (locked Claude Code, Pi) and the Mousse server both answer it.
    expect(botAppToolRefusal(authority(['permission_ask']), 'browser_open', { url: 'https://example.com' })).toBe(NOT_ALLOWED)
    expect(botAppToolRefusal(authority(['permission_ask', ...BOT_BROWSER_TOOLS]), 'browser_open', { url: 'https://example.com' })).toBeUndefined()
    const fx = delegationFixture()
    try {
      const run = await fx.runningRun('bot-home')
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      turns.register(appTurn({ threadId: 'bot-home', runId: run.runId, bot: authority(['permission_ask']) }))
      // Not "Browser tools are not bound for this turn": the bot is told it is not allowed, and to escalate.
      expect(await registry.call('browser_open', { url: 'https://example.com' }, request({ threadId: 'bot-home', runId: run.runId }))).toEqual(refused('not_granted', NOT_ALLOWED))
      // Any other tool outside the grant keeps its wall.
      expect(await registry.call('delegate_task', { prompt: 'x', title: 'x', workspace: 'shared' }, request({ threadId: 'bot-home', runId: run.runId }))).toEqual(refused('not_granted', 'This bot is not allowed to use delegate_task.'))
    } finally {
      fx.dispose()
    }
  })

  it('a bot can hold every grantable tool, every tool of each permission, the task list and the work tools', () => {
    for (const name of [...BOT_APP_TOOLS].filter((name) => !BOT_GROUP_PERMISSIONS.has(name))) expect(botMayBeOffered(name), name).toBe(true)
    for (const name of [...BOT_BROWSER_TOOLS, ...BOT_THREAD_TOOLS, ...BOT_PROFILER_TOOLS, ...BOT_THEME_TOOLS, ...BOT_SCHEDULE_READ_TOOLS, ...BOT_SCHEDULE_ACT_TOOLS, ...BOT_SECRET_TOOLS, ...BOT_QUICK_ACTION_TOOLS, ...BOT_TASK_TOOLS, ...BOT_WORK_TOOLS, 'consult', 'skill_list', 'skill_load']) expect(botMayBeOffered(name), name).toBe(true)
    // What a thread's agent steers, queues, forks and answers with is a bot's too, under "use your threads".
    // An old name that became a variant (thread_steer, thread_hide, queue_edit) asks for its new tool's permission too.
    for (const name of ['thread_stop', 'thread_steer', 'thread_hide', 'queue_edit', 'approval_respond', 'queue_enqueue', 'thread_fork', 'thread_return', 'thread_merge_back', 'git_status', 'computer_list']) expect(botGrantTool(name), name).toBe('threads')
    // A variant only a thread's own turn runs is no bot's: it keeps its name, and no permission holds it.
    expect(botGrantTool('task_cancel')).toBe('task_cancel')
    // A permission's name is no tool; delegation is the work's own subagents; the heap summary pauses the service; a bot has no goal.
    for (const name of ['delegate_task', 'continue_subagent', 'browser_request_human', ...BOT_GROUP_PERMISSIONS, 'profiler_heap_summary', 'goal_update']) expect(botMayBeOffered(name), name).toBe(false)
  })
})

it('tells work and scheduled runs how to use a bound key without seeing it', () => {
  const allowed = botAllowedOf(botStarterManifest())
  const text = botInstructions({ name: 'Reader', description: 'Read models', lane: 'run', allowed, secretFetchOffered: true })
  expect(text).toContain(
    "To read from a service your owner gave you a key for, use secret_fetch with the key's name. You never see the key."
  )
  expect(
    botInstructions({ name: 'Reader', description: 'Read models', lane: 'chat', allowed, secretFetchOffered: true })
  ).not.toContain("use secret_fetch with the key's name")
})

it('keeps service-read guidance out of subagents and consults where the tool is absent', () => {
  const allowed = botAllowedOf(botStarterManifest())
  for (const scope of [
    { subagent: true as const },
    { allowed: { ...allowed, mcpNotHere: true } }
  ]) {
    const text = botInstructions({
      name: 'Reader',
      description: 'Read models',
      lane: 'run',
      secretFetchOffered: true,
      allowed,
      ...scope
    })
    expect(text).not.toContain("use secret_fetch with the key's name")
  }
})

it('says in the catalogue where a bound key is read: in the chat for a quick read, or in work', () => {
  expect(botCatalogueGroup('secrets')!.guidance).toContain(
    "use secret_fetch with the key's name, in the chat for a quick read or in your work"
  )
})
