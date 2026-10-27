import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { getDefaultSettings } from '../src/shared/settings'
import type { PermissionMode } from '../src/shared/permissionMode'
import { LlmClient, type DelegationToolHost } from '../src/mms/orchestrator/LlmClient'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../src/mms/run/EffectOutbox'
import { RunEngine } from '../src/mms/run/RunEngine'
import { RunStore } from '../src/mms/run/RunStore'

/**
 * The pi loop under a permission mode: a command asks under Ask and Auto-accept edits, an edit asks
 * only under Ask, integrating a subagent's work asks under Ask, a rejection reaches the model as a tool
 * error, and the next turn's mode decides again. (The Pi RPC route that takes over tool calls re-points
 * this test at itself; see the comment at the gate in `LlmClient`.)
 */
const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
const response = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
  role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test', content, stopReason, timestamp: Date.now(),
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: emptyCost }
} as AssistantMessage)
const streamOf = (message: AssistantMessage) => ({ async *[Symbol.asyncIterator]() {}, result: async () => message })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function harness() {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
  settings.integrations.skills.enabled = false
  const project = mkdtempSync(join(tmpdir(), 'mousse-pi-approvals-'))
  dirs.push(project)
  const questions = new UserQuestionService()
  const queue: AssistantMessage[] = []
  const contexts: Context[] = []
  const models = {
    getModel: (provider: string, id: string) => ({ id, name: id, api: 'anthropic-messages', provider, baseUrl: '', reasoning: false, input: ['text'], cost: emptyCost, contextWindow: 128_000, maxTokens: 8_000 }),
    getAuth: async () => ({ apiKey: 'test' }),
    streamSimple: (_model: unknown, context: Context) => { contexts.push(structuredClone(context)); return streamOf(queue.shift()!) }
  }
  const client = new LlmClient(
    { get: () => settings } as never,
    { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { questions }
  )
  /** One turn: the model calls `calls` in order, then stops; `answer` answers each approval that is asked. */
  const run = async (
    permissionMode: PermissionMode,
    calls: Array<{ name: string; arguments: Record<string, unknown> }>,
    answer: string | ((prompt: string, options: string[]) => string) | undefined,
    extra: { delegation?: DelegationToolHost } = {}
  ) => {
    const asked: string[] = []
    /** The option ids each question offered. */
    const offered: string[][] = []
    questions.on('pending', (event: { requestId: string; questions: Array<{ prompt: string; options: Array<{ id: string }> }> }) => {
      const options = event.questions[0]!.options.map((option) => option.id)
      asked.push(event.questions[0]!.prompt)
      offered.push(options)
      if (answer) questions.submitAnswers(event.requestId, { permission: typeof answer === 'function' ? answer(event.questions[0]!.prompt, options) : answer }, { kind: 'user' })
    })
    queue.push(response(calls.map((call, index) => ({ type: 'toolCall' as const, id: `call-${index}`, ...call })), 'toolUse'), response([{ type: 'text', text: 'done' }], 'stop'))
    await client.chat([userMessage('work')], undefined, { mode: 'agent', projectPath: project, threadId: 'thread-1', permissionMode, ...extra })
    questions.removeAllListeners('pending')
    const results = contexts.at(-1)!.messages.filter((message) => message.role === 'toolResult') as Array<{ isError?: boolean; content: Array<{ text?: string }> }>
    return { asked, offered, results }
  }
  return { project, run, questions }
}

const write = (path: string, content = 'x') => ({ name: 'write', arguments: { path, content } })

describe('pi loop approvals', () => {
  it('names the directory the call runs in, so a saved approval is not reused in another workspace', async () => {
    const { run, questions, project } = harness()
    const spy = vi.spyOn(questions, 'requestAnswers')
    await run('ask', [{ name: 'bash', arguments: { command: 'echo hi' } }, { name: 'write', arguments: { path: 'a.txt', content: 'x' } }], 'reject')
    const tools = spy.mock.calls.map(([, , options]) => options?.approval?.tool)
    expect(tools).toEqual([
      { name: 'bash', input: { command: 'echo hi' }, cwd: project },
      { name: 'write', input: { path: 'a.txt', content: 'x' }, cwd: project }
    ])
  })

  it('asks before a command under Ask and Auto-accept edits, and a rejection is a tool error', async () => {
    for (const mode of ['ask', 'accept_edits'] as const) {
      const { run } = harness()
      const { asked, results } = await run(mode, [{ name: 'bash', arguments: { command: 'echo hi' } }], 'reject')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain('echo hi')
      expect(results[0]).toMatchObject({ isError: true })
      expect(results[0]!.content[0]!.text).toContain('rejected')
    }
  })

  it('asks before an edit only under Ask, and writes nothing when it is rejected', async () => {
    const accepted = harness()
    const noAsk = await accepted.run('accept_edits', [write('a.txt', 'one')], undefined)
    expect(noAsk.asked).toEqual([])
    expect(readFileSync(join(accepted.project, 'a.txt'), 'utf8')).toBe('one')

    const ask = harness()
    const rejected = await ask.run('ask', [write('a.txt', 'one')], 'reject')
    expect(rejected.asked).toHaveLength(1)
    expect(existsSync(join(ask.project, 'a.txt'))).toBe(false)
    const allowed = await ask.run('ask', [write('b.txt', 'two')], 'allow')
    expect(allowed.asked).toHaveLength(1)
    expect(readFileSync(join(ask.project, 'b.txt'), 'utf8')).toBe('two')
  })

  it('never asks under Full access', async () => {
    const full = harness()
    const { asked } = await full.run('full', [write('a.txt')], undefined)
    expect(asked).toEqual([])
    expect(existsSync(join(full.project, 'a.txt'))).toBe(true)
  })

  it('asks before integrating a subagent\'s work under Ask, and not under Auto-accept edits', async () => {
    const integrated: string[] = []
    const delegation = { integrateDelegation: async () => { integrated.push('integrated'); return { integrated: true } } } as unknown as DelegationToolHost
    const call = { name: 'integrate_delegation', arguments: { subagent: 'Reviewer' } }

    const denied = harness()
    const rejected = await denied.run('ask', [call], 'reject', { delegation })
    expect(rejected.asked).toHaveLength(1)
    expect(integrated).toEqual([])
    expect(rejected.results[0]).toMatchObject({ isError: true })

    const accepting = harness()
    const ran = await accepting.run('accept_edits', [call], undefined, { delegation })
    expect(ran.asked).toEqual([])
    expect(integrated).toEqual(['integrated'])
  })

  describe('"Always for this thread"', () => {
    /** The question service bound to a Run Engine that runs `thread-1`, as a profile binds it; `state` is what the run is bound to. */
    async function bind(questions: UserQuestionService, permissionMode: PermissionMode) {
      const profileHome = mkdtempSync(join(tmpdir(), 'mousse-pi-always-'))
      dirs.push(profileHome)
      const db = new ProfileDatabase({ profileHome })
      const store = new RunStore(db)
      const engine = new RunEngine({ store, pid: 1, outbox: new EffectOutbox(store) })
      engine.reconcileOnBoot()
      const state = { permissionMode }
      questions.setApprovalStore({
        store: engine.approvals,
        context: (threadId) => {
          const run = engine.getActiveRun(threadId)
          return run ? { runId: run.runId, instanceId: 'pi', provider: 'pi', origin: 'interactive', permissionMode: state.permissionMode, approvals: 'ask' } : null
        },
        effectDelivery: () => false,
        continuationDue: () => undefined
      })
      const sent = await engine.dispatch({ kind: 'send', threadId: 'thread-1', clientRequestId: 'pi-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      engine.markStarting(sent.runId)
      engine.markRunning(sent.runId)
      return { engine, state, close: () => db.close() }
    }
    /** "Always" to `echo hi`, a rejection to anything else. */
    const alwaysForEcho = (prompt: string): string => (prompt.endsWith('\necho hi') ? 'allow_always' : 'reject')
    const bashEcho = (command: string) => [{ name: 'bash', arguments: { command } }]

    it('answers the same command in the same folder again, and asks for another command, argument or file', async () => {
      const thread = harness()
      const { engine, close } = await bind(thread.questions, 'ask')
      try {
        const first = await thread.run('ask', bashEcho('echo hi'), alwaysForEcho)
        expect(first.asked).toHaveLength(1)
        expect(first.offered).toEqual([['allow', 'allow_always', 'reject']])
        expect(first.results[0]).not.toMatchObject({ isError: true })
        expect(engine.approvals.listRules('thread-1')).toEqual([expect.objectContaining({ permissionKey: 'pi:command', grantedUnder: 'ask' })])

        // The same command runs without a question; near misses ask and are rejected.
        const again = await thread.run('ask', bashEcho('echo hi'), alwaysForEcho)
        expect(again.asked).toEqual([])
        expect(again.results[0]).not.toMatchObject({ isError: true })
        for (const command of ['echo hi there', 'echo  hi', 'echo hi; rm x']) {
          const near = await thread.run('ask', bashEcho(command), alwaysForEcho)
          expect(near.asked, command).toHaveLength(1)
          expect(near.results[0], command).toMatchObject({ isError: true })
        }
        // A command rule does not answer an edit.
        expect((await thread.run('ask', [write('a.txt')], alwaysForEcho)).asked).toHaveLength(1)
        expect(engine.approvals.listRules('thread-1')).toHaveLength(1)
      } finally {
        close()
      }
    })

    it('stops answering once the thread asks about more than when the rule was made', async () => {
      const thread = harness()
      const { state, close } = await bind(thread.questions, 'accept_edits')
      try {
        await thread.run('accept_edits', bashEcho('echo hi'), alwaysForEcho)
        expect((await thread.run('accept_edits', bashEcho('echo hi'), alwaysForEcho)).asked).toEqual([])
        state.permissionMode = 'ask'
        expect((await thread.run('ask', bashEcho('echo hi'), 'reject')).asked).toHaveLength(1)
      } finally {
        close()
      }
    })

    it('never offers "always" for integrating a subagent\'s work, which is not the same work twice', async () => {
      const integrated: string[] = []
      const delegation = { integrateDelegation: async () => { integrated.push('integrated'); return { integrated: true } } } as unknown as DelegationToolHost
      const call = { name: 'integrate_delegation', arguments: { subagent: 'Reviewer' } }
      const thread = harness()
      const { engine, close } = await bind(thread.questions, 'ask')
      try {
        for (let times = 0; times < 2; times += 1) {
          const ran = await thread.run('ask', [call], (_prompt, options) => (options.includes('allow_always') ? 'allow_always' : 'allow'), { delegation })
          expect(ran.offered).toEqual([['allow', 'reject']])
        }
        expect(integrated).toEqual(['integrated', 'integrated'])
        expect(engine.approvals.listRules('thread-1')).toEqual([])
      } finally {
        close()
      }
    })
  })

  it('decides again on the next turn: after a change to Auto-accept edits an edit stops asking', async () => {
    const thread = harness()
    expect((await thread.run('ask', [write('a.txt')], 'allow')).asked).toHaveLength(1)
    expect((await thread.run('accept_edits', [write('b.txt')], undefined)).asked).toEqual([])
  })
})
