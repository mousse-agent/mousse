/**
 * A bot's "hello": what every one of its turns sends before the conversation, its instructions plus the Mousse tools its
 * runtime is shown (docs/plans/bot-context.md §15). Measured in characters for a bot holding every permission, on each
 * lane, as each runtime is shown it: Codex and Pi get every listed tool's name, description and schema, which in
 * `use_tool` mode is the core set; Claude Code gets the tools it always loads in full and the rest by name, loaded on
 * demand by its tool search. Also: every tool a bot can be listed is core or in exactly one catalogue group, so a bot
 * on Codex or Pi reaches everything a bot on Claude Code does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileBotThread } from '../../src/mms/bots/grants/compile'
import { botAllowedOf, botInstructions } from '../../src/mms/bots/instructions'
import { listedTool } from '../../src/mms/run/mcp/MousseMcpServer'
import { BOT_CATALOGUE, BOT_CORE_TOOLS } from '../../src/shared/bots/personal/catalogue'
import { botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { appToolRegistry, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'
import { disposeFixtures, memoryFixture } from './memory/memoryFixture'

// Before the catalogue, a bot with the owner's usual permissions (commands, browser, threads, profiler) said hello in
// about 87,300 characters on Codex and Pi (57 tools in full) and 27,900 on Claude Code; with it, about 50,700 and 21,300
// (show_card is core: listed only in a group, Codex asked the owner instead of showing a card). The retry key every tool
// that changes something declares (clientRequestId) adds about 70 characters to each, about 170 to the tools Claude
// Code always loads.
// thread_send then grew by about 2,000 (its note intent, attention, runId and interrupt, with the delivery states a note
// reports) and thread_archive by about 360 (it unarchives, and archives another thread), so the chat lane on Codex and
// Pi now says hello in about 55,100 characters and the run lane in about 53,900.
// "Use the computer" (its catalogue group and its line in what the owner allows) adds about 100 to each.
// The open items (their three lines of instructions with the stages, and item_save and item_list in full on every
// provider), with report_bug and the thread-link line that came beside them, bring the chat lane to about 59,200 on
// Codex and Pi and 25,550 on Claude Code.
// The line that browser screenshots show to the owner by themselves, and Other… on question_ask, add about 150 to each.
// The chat's own quick calls (its line on the web, secret_fetch and MCP tools with their budgets, and what stays work's)
// add about 350 to the chat lane, escalate's card name about 75, and thread_create's hidden (a thread an agent starts
// stays out of the sidebar) about 560 on Codex and Pi: the chat lane there says hello in about 60,050 characters.
// thread_archive on another computer's threads (its qualified id, its busy retry and replay) adds about 610 on Codex and
// Pi, to about 60,660.
const CEILING = { codexPi: 60_900, claude: 25_700 } as const

let fx: DelegationFixture | undefined
afterEach(() => {
  fx?.dispose()
  fx = undefined
  disposeFixtures()
})

const starter = botStarterManifest()
const EVERYTHING = { ...starter, tools: [...starter.tools, 'shell'], appTools: [...starter.appTools, 'browser', 'threads', 'profiler', 'themes', 'schedules', 'secrets', 'quick_actions'] }
type Listed = ReturnType<typeof listedTool>
const size = (tools: readonly Listed[]) => tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema ?? {}).length, 0)

function hello(lane: 'chat' | 'run', catalogue: 'search' | 'use_tool') {
  fx ??= delegationFixture()
  const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => undefined, botMemory: { activationOf: () => undefined, memory: memoryFixture().store } })
  const compiled = compileBotThread({
    grant: EVERYTHING, digest: 'd', thread: {}, scratch: '/tmp/bot-scratch', profileHome: '/tmp/bot-home',
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 },
    botTools: {
      workWaiting: lane === 'run', escalate: true, consult: false, memory: true, scheduled: false, frontDesk: lane === 'chat', watcherStart: lane === 'chat',
      threads: 'all', profiler: true, themes: true, owner: true, tasks: true, images: true, applets: true, subagents: lane === 'run', questions: true, cards: true, bots: true, catalogue
    }
  })
  if (!compiled.ok) throw new Error(compiled.error.message)
  const listed = registry.listFor({ readOnly: false, botRole: 'activation', botTurnTools: new Set(compiled.permissions.appTools), botCatalogue: catalogue }).map(listedTool)
  const system = botInstructions({ name: 'Pip', description: 'Help me with my day, my threads and my projects.', filesFolder: 'C:/Users/me/.mousse/profiles/p/bots/files/bot-1', homeFolder: 'C:/Users/me', lane, allowed: botAllowedOf(EVERYTHING) })
  return { listed, system }
}

describe('a bot\'s hello', () => {
  it.each(['chat', 'run'] as const)('on Codex and Pi, the %s lane stays under the ceiling, its tools only the core set', (lane) => {
    const { listed, system } = hello(lane, 'use_tool')
    expect(listed.map((tool) => tool.name).filter((name) => !BOT_CORE_TOOLS.includes(name))).toEqual([])
    expect(system.length + size(listed)).toBeLessThanOrEqual(CEILING.codexPi)
  })

  it.each(['chat', 'run'] as const)('on Claude Code, the %s lane stays under the ceiling: tool_catalogue and memory loaded, the rest by name', (lane) => {
    const { listed, system } = hello(lane, 'search')
    const loaded = listed.filter((tool) => tool._meta?.['anthropic/alwaysLoad'])
    expect(loaded.map((tool) => tool.name)).toContain('tool_catalogue')
    // A deferred tool is shown by its full name only (mcp__mousse__<name>).
    const names = listed.filter((tool) => !loaded.includes(tool)).reduce((sum, tool) => sum + `mcp__mousse__${tool.name}`.length, 0)
    expect(system.length + size(loaded) + names).toBeLessThanOrEqual(CEILING.claude)
  })

  it('every tool a bot can be listed is in the core set or in exactly one group', () => {
    const listed = new Set([...hello('chat', 'search').listed, ...hello('run', 'search').listed].map((tool) => tool.name))
    const homes = (name: string) => (BOT_CORE_TOOLS.includes(name) ? 1 : 0) + BOT_CATALOGUE.filter((group) => group.tools.includes(name)).length
    // request_answer has two homes, as the two tools it replaced had: answering an approval in a thread (threads) and
    // passing the owner's answer on to work (work). A bot reading either group finds it there.
    expect([...listed].filter((name) => homes(name) !== (name === 'request_answer' ? 2 : 1))).toEqual([])
  })
})
