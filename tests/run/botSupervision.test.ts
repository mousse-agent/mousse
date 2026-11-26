/**
 * A bot answers for the threads it started (supervision): a real `OrchestratorService` and Run Engine over a temporary
 * profile, with the bot's threads faked as `botThreadsDaemon.test.ts` does. The bot that started a thread answers that
 * thread's own questions and approvals without the profile's switch, whoever started the turn, labelled as its own;
 * every other caller and request keeps today's rule; and such a request is marked supervised (no ping, not in Needs me)
 * only while the bot can answer it.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jobThreadIn } from '../../src/mms/bots/launchedThreads'
import type { ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import { BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from '../../src/shared/bots/personal/manifest'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { AgentActor } from '../../src/mms/run/types'
import type { ChatMessage, UserQuestion, UserQuestionAnswers } from '../../src/shared/types'
import { appTurn } from './appToolsFixture'
import { phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const QUESTION: UserQuestion[] = [{ id: 'db', prompt: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] }]
const APPROVAL: UserQuestion[] = [{ id: 'permission', prompt: 'Allow a command?\nnpm test', options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow_always', label: 'Always for this thread' }, { id: 'reject', label: 'Reject' }] }]
const tag = (action: ApprovalTag['action'] = 'command', reason?: string): ApprovalTag => ({
  action,
  permissionKey: `test:${action}`,
  ...(reason ? { reason } : {}),
  options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'allow_always', decision: 'allow', scope: 'always' }, { id: 'reject', decision: 'reject' }],
  tool: { name: 'Bash', input: { command: 'npm test' }, cwd: '/work' }
})

describe('a bot answers for the threads it started', () => {
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []
  let previousHome: string | undefined
  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) {
      daemon.questions.shutdown()
      await daemon.stop().catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /**
   * Two bots, alpha (b1) and beta (b2), each with a chat thread holding a turn with every thread tool. `job` is a thread
   * alpha started; `plain` one nobody did. `roleOf` says what the chat threads are (a subagent of alpha's work, for one case).
   */
  const world = (options: { alphaRole?: 'activation' | 'subagent' } = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-bot-supervision-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const d = phase6Daemon(home, [piAdapter(() => 'done')])
    daemons.push(d)
    mkdirSync(join(home, 'project'))
    const project = d.projects.openProject(join(home, 'project'))
    const held = new Set([...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS])
    const chats = { b1: d.store.createThread('alpha', project.id), b2: d.store.createThread('beta', project.id) }
    const names: Record<string, string> = { b1: 'alpha', b2: 'beta' }
    const actors: Record<string, AgentActor> = {}
    for (const [botId, chat] of Object.entries(chats)) {
      const runId = `run:${botId}`
      d.orch.appToolTurns.register(appTurn({ threadId: chat.id, runId, bot: { activationId: `act-${botId}`, appTools: held } as unknown as BotAuthority }))
      actors[botId] = { kind: 'agent', threadId: chat.id, runId, toolCallId: `call-${botId}` }
    }
    const botOfChat = (threadId: string) => Object.entries(chats).find(([, chat]) => chat.id === threadId)?.[0]
    d.orch.setBotThreads({
      roleOf: (threadId) => (botOfChat(threadId) === 'b1' ? options.alphaRole ?? 'activation' : botOfChat(threadId) ? 'activation' : undefined),
      botOf: (threadId) => {
        const botId = botOfChat(threadId)
        return botId ? { botId, name: names[botId]! } : undefined
      },
      ownerTurn: () => ({})
    })
    const paused = new Set<string>()
    d.orch.setBotSupervision((botId) => (names[botId] && !paused.has(botId) ? { name: names[botId]! } : undefined))
    const job = d.store.createThread('Fix login', project.id, undefined, { createdByThreadId: chats.b1.id, startedByBot: { botId: 'b1', name: 'alpha' } })
    d.orch.setThreadPermissionMode(job.id, 'full')
    const plain = d.store.createThread('Plain', project.id)
    const child = d.store.createThread('Child', project.id, undefined, { lineage: { parentThreadId: job.id, rootThreadId: job.id, relationship: 'subagent' } })
    let sends = 0
    /** A run working in `threadId`, started by a person (`gui`) or not (`internal`), in `mode`. */
    const runIn = async (threadId: string, source: 'gui' | 'internal' = 'internal', mode: PermissionMode = 'ask') => {
      const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: `send-${++sends}`, source })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      d.engine.markStarting(sent.runId)
      const run = d.engine.markRunning(sent.runId)
      d.engine.recordExecutionBinding(run.runId, { instanceId: 'pi:openai', driver: 'pi', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'gpt-replay', policy: { mode: 'default', origin: 'interactive', approvals: 'ask', permissionMode: mode } })
      return run.runId
    }
    /** Asks in `threadId`; returns the request id and what the asking agent gets back. */
    const ask = (threadId: string, approval?: ApprovalTag) => {
      const answered = d.questions.requestAnswers(approval ? APPROVAL : QUESTION, threadId, approval ? { approval } : {}).catch((error: unknown) => error)
      const requestId = d.questions.listPendingForThread(threadId).at(-1)!.requestId
      return { requestId, answered }
    }
    let calls = 0
    const host = d.orch.mcpToolHost()
    const answer = (botId: 'b1' | 'b2', threadId: string, requestId: string, answers: UserQuestionAnswers, key = `k${++calls}`) =>
      host.answerApproval!(threadId, requestId, answers, { clientRequestId: `approval_respond:${actors[botId]!.threadId}:${key}`, actor: { ...actors[botId]!, toolCallId: key } })
    const rows = (threadId: string) => d.orch.getOrCreateSession(threadId).messages
    return { d, project, job, plain, child, paused, runIn, ask, answer, rows }
  }

  it('answers a plain question on a thread it started, without the switch, labelled as its own; a retry replays', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const typed = w.ask(w.job.id)
    expect(w.answer('b1', w.job.id, typed.requestId, { db: 'Use the staging database' }, 'q1')).toEqual({ ok: true, answered: 'question', replayed: false })
    // The asking agent reads the answer as the bot's, never the user's.
    expect(await typed.answered).toEqual({ db: 'From alpha, the bot that started this thread (not the user): Use the staging database' })
    expect(w.answer('b1', w.job.id, typed.requestId, { db: 'Use the staging database' }, 'q1')).toEqual({ ok: true, answered: 'question', replayed: true })
    // An option goes through as the option.
    const chosen = w.ask(w.job.id)
    expect(w.answer('b1', w.job.id, chosen.requestId, { db: 'pg' })).toMatchObject({ ok: true, answered: 'question' })
    expect(await chosen.answered).toEqual({ db: 'pg' })
    // One system row per answer that won, naming the bot; no message as the user.
    const rows = w.rows(w.job.id).filter((row) => /Answered by alpha \(the bot that started this thread\)/.test(String(row.content)))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.role === 'system')).toBe(true)
    expect(w.rows(w.job.id).some((row) => row.role === 'user')).toBe(false)
  })

  it('takes one answer to a one-question request as that question\'s, and refuses keys that name no question', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const single = w.ask(w.job.id)
    // Keyed by the request id, as a model may: still the only question's answer.
    expect(w.answer('b1', w.job.id, single.requestId, { [single.requestId]: 'pg' })).toMatchObject({ ok: true, answered: 'question' })
    expect(await single.answered).toEqual({ db: 'pg' })
    const two: UserQuestion[] = [QUESTION[0]!, { id: 'size', prompt: 'How big?', options: [{ id: 's', label: 'Small' }] }]
    const answered = w.d.questions.requestAnswers(two, w.job.id, {}).catch((error: unknown) => error)
    const requestId = w.d.questions.listPendingForThread(w.job.id).at(-1)!.requestId
    expect(w.answer('b1', w.job.id, requestId, { db: 'pg', [requestId]: 's' })).toEqual({ ok: false, reason: 'unknown_question', questionIds: ['db', 'size'] })
    expect(w.d.questions.listPendingForThread(w.job.id).map((entry) => entry.requestId)).toEqual([requestId])
    expect(w.answer('b1', w.job.id, requestId, { db: 'pg', size: 's' })).toMatchObject({ ok: true, answered: 'question' })
    expect(await answered).toEqual({ db: 'pg', size: 's' })
  })

  it('a job\'s answer is the reply its last run ended on, by run id: never an earlier turn\'s, and an applet only by name', async () => {
    const w = world()
    const message = (role: ChatMessage['role'], content: string, turnId?: string, extra: Partial<ChatMessage> = {}) => ({ id: `${role}:${content}`, role, content, timestamp: '', ...(turnId ? { turnId } : {}), ...extra }) as ChatMessage
    let transcript: ChatMessage[] = []
    let kept: string | undefined
    const view = () => jobThreadIn({ threads: w.d.store, engine: w.d.engine, asks: () => false, recorded: () => kept, messages: () => transcript }, w.job.id)
    const earlier = await w.runIn(w.job.id)
    w.d.engine.markTerminal(earlier, 'completed')
    const last = await w.runIn(w.job.id)
    w.d.engine.markTerminal(last, 'completed')
    const before = [message('user', 'Fix page A', earlier), message('assistant', 'Fixed page A.', earlier)]

    // The last run wrote nothing and kept nothing: no answer, never the earlier turn's reply.
    transcript = [...before, message('user', 'Fix page B', last)]
    expect(view()).toMatchObject({ status: 'done' })
    expect(view().result).toBeUndefined()

    // Its reply holds a published applet after plenty of prose: the answer names the applet, never its source.
    const source = { schemaVersion: 1, title: 'Price chart', description: 'Prices.', html: '<main id="secret-markup"></main>', css: '', js: 'drawChart()' }
    const reply = `${'The prices over the year, as asked. '.repeat(8)}\n\n\u0060\u0060\u0060mousse-applet\n${JSON.stringify(source)}\n\u0060\u0060\u0060`
    const reference = { appletId: 'ap1', revisionId: 'rev1', sourceHash: 'h', title: 'Price chart', description: 'Prices.' }
    transcript = [...before, message('user', 'Chart prices', last), message('assistant', reply, last, { presentationParts: [{ type: 'applet', reference }] })]
    kept = 'The prices over the year.'
    const result = view().result!
    expect(result).toContain('The prices over the year, as asked.')
    expect(result).toContain('[Applet: Price chart (appletId ap1, revision rev1)]')
    expect(result).not.toContain('mousse-applet')
    expect(result).not.toContain('drawChart')
  })

  it('approves on a thread it started without the switch, named as itself, no wider than the thread\'s own mode', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const asked = w.ask(w.job.id, tag('command'))
    expect(w.answer('b1', w.job.id, asked.requestId, { permission: 'allow' })).toEqual({ ok: true, decision: 'allow', replayed: false })
    expect(w.d.engine.approvals.get(asked.requestId)).toMatchObject({ status: 'answered', answeredBy: { kind: 'agent' } })
    expect(w.rows(w.job.id).some((row) => row.role === 'system' && /^Approved by alpha \(the bot that started this thread\)/.test(String(row.content)))).toBe(true)
    // Once the owner narrows the thread to Auto-accept edits, a command is above it; an edit is not.
    w.d.orch.setThreadPermissionMode(w.job.id, 'accept_edits')
    const command = w.ask(w.job.id, tag('command'))
    expect(w.answer('b1', w.job.id, command.requestId, { permission: 'allow' })).toEqual({ ok: false, reason: 'mode_forbids' })
    const edit = w.ask(w.job.id, tag('edit'))
    expect(w.answer('b1', w.job.id, edit.requestId, { permission: 'allow' })).toMatchObject({ ok: true, decision: 'allow' })
  })

  // Who asks, where, and what is refused. A question is refused as the user's, an approval by today's rule.
  it.each([
    ['another bot', { bot: 'b2' as const }, 'question_for_user', 'approvals_disabled'],
    ['a subagent of its own work', { alphaRole: 'subagent' as const }, 'question_for_user', 'approvals_disabled'],
    ['a thread nobody started, with the switch off', { thread: 'plain' as const }, 'question_for_user', 'approvals_disabled'],
    // A subagent's thread is never a thread the bot started (the rule table covers `not_parent` for it).
    ['the started thread\'s subagent', { thread: 'child' as const }, 'question_for_user', 'approvals_disabled']
  ])('refuses %s', async (_name, input, questionReason, approvalReason) => {
    const w = world(input.alphaRole ? { alphaRole: input.alphaRole } : {})
    const threadId = w[input.thread ?? 'job'].id
    await w.runIn(threadId)
    const question = w.ask(threadId)
    expect(w.answer(input.bot ?? 'b1', threadId, question.requestId, { db: 'pg' })).toEqual({ ok: false, reason: questionReason })
    w.d.questions.dismiss(question.requestId)
    const approval = w.ask(threadId, tag('command'))
    expect(w.answer(input.bot ?? 'b1', threadId, approval.requestId, { permission: 'allow' })).toEqual({ ok: false, reason: approvalReason })
    expect(w.d.questions.listPendingForThread(threadId)).toHaveLength(1)
  })

  it('answers on a turn its owner started in a thread it started: the bot owns that thread', async () => {
    const w = world()
    await w.runIn(w.job.id, 'gui', 'full')
    const question = w.ask(w.job.id)
    expect(w.d.orch.supervisorOf(w.job.id, question.requestId)).toEqual({ botId: 'b1', name: 'alpha' })
    expect(w.answer('b1', w.job.id, question.requestId, { db: 'pg' })).toEqual({ ok: true, answered: 'question', replayed: false })
    expect(await question.answered).toEqual({ db: 'pg' })
    const approval = w.ask(w.job.id, tag('command'))
    expect(w.answer('b1', w.job.id, approval.requestId, { permission: 'allow' })).toEqual({ ok: true, decision: 'allow', replayed: false })
    // Another bot is still refused there, as a person's turn is the person's to everyone else.
    const other = w.ask(w.job.id, tag('command'))
    expect(w.answer('b2', w.job.id, other.requestId, { permission: 'allow' })).toEqual({ ok: false, reason: 'person_turn' })
  })

  it('refuses what the provider keeps for a person and "always", on a thread it started', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const reserved = w.ask(w.job.id, tag('command', 'Claude Code asks even in Full access.'))
    expect(w.answer('b1', w.job.id, reserved.requestId, { permission: 'allow' })).toEqual({ ok: false, reason: 'person_only' })
    w.d.questions.dismiss(reserved.requestId)
    const asked = w.ask(w.job.id, tag('command'))
    expect(w.answer('b1', w.job.id, asked.requestId, { permission: 'allow_always' })).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
    expect(w.d.engine.approvals.get(asked.requestId)).toMatchObject({ status: 'pending' })
  })

  it('lists what a thread it started waits on in the job\'s view, without "always"', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const approval = w.ask(w.job.id, tag('command'))
    const question = w.ask(w.job.id)
    const view = jobThreadIn({ threads: w.d.store, engine: w.d.engine, asks: (id) => w.d.questions.listPendingForThread(id).length > 0, pending: (id) => w.d.questions.listPendingForThread(id) }, w.job.id)
    expect(view).toMatchObject({ status: 'needs_input' })
    expect(view.asks).toEqual([
      { requestId: approval.requestId, approval: true, questions: [{ id: 'permission', text: 'Allow a command?\nnpm test', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }] },
      { requestId: question.requestId, approval: false, questions: [{ id: 'db', text: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] }] }
    ])
  })

  it('marks a request supervised only while its bot can answer it: not a paused bot, not a subagent\'s, whoever started the turn', async () => {
    const w = world()
    await w.runIn(w.job.id)
    const asked = w.ask(w.job.id, tag('command'))
    expect(w.d.orch.supervisorOf(w.job.id, asked.requestId)).toEqual({ botId: 'b1', name: 'alpha' })
    expect(w.d.orch.waitSupervised(w.job.id)).toBe(true)
    // A secret request waits for the owner alone.
    expect(w.d.orch.waitSupervised(w.job.id, true)).toBe(false)
    // Paused (or deleted, or "use your threads" off): the owner is asked again.
    w.paused.add('b1')
    expect(w.d.orch.supervisorOf(w.job.id, asked.requestId)).toBeUndefined()
    expect(w.d.orch.waitSupervised(w.job.id)).toBe(false)
    w.paused.delete('b1')
    // The thread's subagent is the owner's; a turn the owner started in another thread the bot started is the bot's.
    await w.runIn(w.child.id)
    const below = w.ask(w.child.id)
    expect(w.d.orch.supervisorOf(w.child.id, below.requestId)).toBeUndefined()
    const mine = w.d.store.createThread('Owner took over', w.project.id, undefined, { startedByBot: { botId: 'b1', name: 'alpha' } })
    await w.runIn(mine.id, 'gui')
    const owners = w.ask(mine.id)
    expect(w.d.orch.supervisorOf(mine.id, owners.requestId)).toEqual({ botId: 'b1', name: 'alpha' })
    expect(w.d.orch.waitSupervised(mine.id)).toBe(true)
  })
})
