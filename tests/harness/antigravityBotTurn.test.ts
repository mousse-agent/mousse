/**
 * A bot runs on Antigravity: the gateway admits a bot policy on its entry, and in the bot's turn every permission and
 * file request the agent sends is answered by the bot's authority, through the ACP adapter and the real session core.
 * Nobody is asked. The agent is a hand-authored in-process ACP stand-in; it proves Mousse's side only.
 *
 * Requests the agent may send in a bot's turn:
 * - a permission of a kind the bot's permissions name (`read`, `edit`, `execute`, `fetch`), allowed or not;
 * - one naming several paths (`locations`), one of them not allowed;
 * - one of a kind no permission names (`other` or omitted): refused;
 * - a client file write, allowed or not.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { keepOption } from '../../src/mms/harness/acp/permissions'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import { AcpAdapter } from '../../src/mms/harness/drivers/acp/adapter'
import { ANTIGRAVITY_CAPS, antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { checkPolicy } from '../../src/mms/harness/policy'
import type { BotAuthority, NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { RunPolicy } from '../../src/shared/harness/types'
import { NEUTRAL_TOOLS } from '../../src/shared/harness/tools'
import { holdControl } from '../support/steerHoldControl'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Ask = { kind?: string; path?: string; paths?: string[]; name?: string; title?: string }

/** The real agy 1.5.13 after a denied request: it ends the prompt with no reply. A later prompt gets an answer. */
function agentStoppingAtDenial(ask: Ask) {
  const prompts: string[] = []
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }) as never)
      .onRequest(methods.agent.session.prompt, async (c) => {
        const text = c.params.prompt.map((block) => (block as { text?: string }).text ?? '').join('\n')
        prompts.push(text)
        if (prompts.length > 1) {
          await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wrote what I could; the other file was refused.' } } })
          return { stopReason: 'end_turn' }
        }
        await c.client.request(methods.client.session.requestPermission, {
          sessionId: c.params.sessionId,
          toolCall: { toolCallId: 'call-0', title: 'File secret.txt', kind: (ask.kind ?? 'edit') as 'edit', locations: (ask.path ? [ask.path] : []).map((path) => ({ path })) },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
        })
        return { stopReason: 'end_turn' }
      })
  })
  return { ...agent, prompts }
}

/** An agent whose one prompt sends `asks` as permission requests and `writes` as client file writes, in order. */
function agentSending(asks: Ask[], writes: string[] = []) {
  const outcomes: unknown[] = []
  const writeErrors: string[] = []
  let promptCount = 0
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }) as never)
      .onRequest(methods.agent.session.prompt, async (c) => {
        // Only the first prompt works; a follow-up (after a refusal) just ends.
        if (++promptCount > 1) return { stopReason: 'end_turn' }
        for (const [index, ask] of asks.entries()) {
          const paths = ask.paths ?? (ask.path ? [ask.path] : [])
          if (ask.name) {
            await c.client.notify(methods.client.session.update, {
              sessionId: c.params.sessionId,
              update: { sessionUpdate: 'tool_call', toolCallId: `call-${index}`, name: ask.name, title: `call ${index}` }
            })
          }
          const answer = await c.client.request(methods.client.session.requestPermission, {
            sessionId: c.params.sessionId,
            toolCall: { toolCallId: `call-${index}`, title: ask.title ?? `call ${index}`, ...(ask.kind ? { kind: ask.kind as 'read' } : {}), locations: paths.map((path) => ({ path })) },
            options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
          })
          outcomes.push((answer as { outcome: { outcome: string; optionId?: string } }).outcome.optionId ?? 'cancelled')
        }
        for (const path of writes) {
          try {
            await c.client.request(methods.client.fs.writeTextFile, { sessionId: c.params.sessionId, path, content: 'bot wrote this' })
          } catch (error) {
            writeErrors.push(error instanceof Error ? error.message : String(error))
          }
        }
        return { stopReason: 'end_turn' }
      })
  })
  return { ...agent, outcomes, writeErrors, prompts: () => promptCount }
}

/** A bot authority that allows calls whose every path is inside `allowed` (a stand-in for its roots and grant). */
function botAllowing(allowed: string) {
  const checked: NormalisedCall[] = []
  const bot: Pick<BotAuthority, 'check'> = {
    check: (call) => {
      checked.push(call)
      const path = call.kind === 'builtin' ? call.args.path : undefined
      return typeof path === 'string' && !path.startsWith(allowed)
        ? { ok: false, refused: { text: 'Outside the bot folder.', askId: 'ask-1' } }
        : { ok: true }
    }
  }
  return { bot, checked }
}

/** One bot turn on Antigravity's caps through the ACP adapter and the real session core. */
async function botTurn(agent: Pick<ReturnType<typeof agentSending>, 'connect'>, bot: Pick<BotAuthority, 'check'>, cwd: string, withMcp = false) {
  const saved = new Map<string, SavedAcpSession>()
  const questions = new UserQuestionService()
  const asked = vi.spyOn(questions, 'requestAnswers')
  const sessions = new AcpSessions({
    label: 'Antigravity',
    defaultInstanceId: 'antigravity',
    questions,
    connect: agent.connect,
    quirks: { ...NO_QUIRKS, clientFs: true },
    classifyOption: keepOption,
    store: { saved: (id) => saved.get(id), setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)), models: () => [], setModels: () => {} },
    launchGeneration: () => 0,
    signInGeneration: () => 0,
    markSignedOut: vi.fn(),
    signInRequiredMessage: 'Sign in first'
  })
  cleanups.push(() => sessions.stop())
  const hold = holdControl(ANTIGRAVITY_CAPS)
  const sink = hold.wrap({ text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, usage: () => {} } as unknown as TurnSink)
  const adapter = new AcpAdapter(() => ({ chat: (input) => sessions.chat(input), commitConversation: () => {}, configured: () => true }), { driver: 'antigravity', label: 'Antigravity', capabilities: ANTIGRAVITY_CAPS })
  const input = { threadId: 'bot-thread', instanceId: 'antigravity', llmProvider: '', model: 'default', mode: 'agent', prompt: 'work', cwd, permissionMode: 'ask', signal: new AbortController().signal } as unknown as TurnInput
  const result = await adapter.startTurn(input, sink, hold.ctl, { bot, ...(withMcp ? { bridge: { mcp: { url: 'http://127.0.0.1:1/mcp', token: 'test' } } } : {}), context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as AdapterHost)
  return { result, asked }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-bot-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('a bot on Antigravity', () => {
  it('is admitted: the entry holds a bot through its approvals, in Ask mode, with a name for every file, command and web tool', () => {
    const driver = antigravityDriver({ builtIn: () => ({ supportsBotTurns: () => true }) as ReturnType<Parameters<typeof antigravityDriver>[0]['builtIn']> })
    expect(driver.botAuthority?.({})).toBe(true)
    expect(driver.botApprovals?.({})).toBe(true)
    for (const tool of NEUTRAL_TOOLS) expect(driver.nativeToolNames?.(tool, {}).length, tool).toBeGreaterThan(0)
    const policy = { authority: { kind: 'bot' }, approve: 'host', permissionMode: 'ask', origin: 'bot' } as unknown as RunPolicy
    const options = { hostApprovals: driver.botAuthority?.({}), botApprovals: driver.botApprovals?.({}), botRuntimeGaps: [] }
    expect(checkPolicy(driver.caps({}), policy, 'antigravity', undefined, options)).toEqual({ ok: true })
  })

  it("answers each permission request with the bot's authority and never asks a person", async () => {
    const cwd = tempDir()
    const inside = join(cwd, 'notes.md')
    const outside = join(tmpdir(), 'elsewhere', 'secret.txt')
    const existing = join(cwd, 'existing.md')
    writeFileSync(existing, 'already here')
    const agent = agentSending([
      { kind: 'edit', path: existing },
      { kind: 'read', path: inside },
      { kind: 'edit', path: outside },
      { kind: 'execute' },
      { kind: 'edit', paths: [inside, outside] },
      { kind: 'other' },
      {}
    ])
    const { bot, checked } = botAllowing(cwd)
    const { asked } = await botTurn(agent, bot, cwd)
    expect(agent.outcomes).toEqual(['yes', 'yes', 'no', 'yes', 'no', 'no', 'no'])
    expect(asked).not.toHaveBeenCalled()
    // The read and the command were checked as the bot's tools; both paths of the two-path edit were checked.
    // A path that does not exist yet is a new file: a `write`.
    expect(checked.map((call) => call.kind === 'builtin' ? `${call.tool}:${String(call.args.path ?? '')}` : call.kind)).toEqual([
      `edit:${existing}`, `read:${inside}`, `write:${outside}`, 'shell:', `write:${inside}`, `write:${outside}`
    ])
  })

  it('recognizes the attached Mousse server from the tool name, never from its display title', async () => {
    const cwd = tempDir()
    const agent = agentSending([
      { kind: 'other', name: 'mcp_mousse_get_memory' },
      { kind: 'other', title: 'Run mcp_mousse_get_memory' },
      { kind: 'other', name: 'mcp_mousse-relay_github__send' }
    ])
    const { bot } = botAllowing(cwd)
    await botTurn(agent, bot, cwd, true)
    expect(agent.outcomes).toEqual(['yes', 'no', 'no'])
  })

  it("writes a file the bot may change without asking, and refuses one it may not", async () => {
    const cwd = tempDir()
    const allowed = join(cwd, 'bot', 'out.txt')
    const denied = join(cwd, 'private.txt')
    const agent = agentSending([], [allowed, denied])
    const { bot } = botAllowing(join(cwd, 'bot'))
    const { asked } = await botTurn(agent, bot, cwd)
    expect(readFileSync(allowed, 'utf8')).toBe('bot wrote this')
    expect(existsSync(denied)).toBe(false)
    expect(agent.writeErrors).toHaveLength(1)
    expect(asked).not.toHaveBeenCalled()
  })

  it('tells the agent what was refused when it stops at a denial, and the turn ends with its reply', async () => {
    const cwd = tempDir()
    const agent = agentStoppingAtDenial({ kind: 'edit', path: join(tmpdir(), 'elsewhere', 'secret.txt') })
    const { bot } = botAllowing(cwd)
    const { result } = await botTurn(agent, bot, cwd)
    expect(agent.prompts).toHaveLength(2)
    expect(agent.prompts[1]).toContain('File secret.txt: Outside the bot folder.')
    expect(JSON.stringify(result)).toContain('Wrote what I could')
  })

  it('sends no follow-up when nothing was refused', async () => {
    const cwd = tempDir()
    const agent = agentStoppingAtDenial({ kind: 'edit', path: join(cwd, 'notes.md') })
    const { bot } = botAllowing(cwd)
    await botTurn(agent, bot, cwd)
    expect(agent.prompts).toHaveLength(1)
  })
})
