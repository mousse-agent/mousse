/**
 * Saved approval requests (docs/run-engine/SPEC.md §17): the store and the question service over a
 * real Run Engine database, then whole daemons (orchestrator, engine, effect worker) that crash,
 * restart and continue.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunPolicy, TurnOrigin } from '../../src/shared/harness/types'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { UserQuestionService, type ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import type { PendingUserQuestions } from '../../src/shared/types'
import type { TurnInput } from '../../src/mms/harness/adapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ThreadApprovals, type ContinuationDue } from '../../src/mms/run/ThreadApprovals'
import type { RunRecord } from '../../src/mms/run/types'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

type Tool = NonNullable<ApprovalTag['tool']>

const BASH = (command: string, extra: Record<string, unknown> = {}): Tool => ({ name: 'Bash', input: { command, ...extra }, cwd: '/work/app' })

/** What the provider asks: the card the user sees, and what each option means. */
const prompt = (text = 'Allow Claude Code to run a command (Bash)?\nnpm test'): PendingUserQuestions['questions'] => [
  { id: 'permission', prompt: text, options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }
]
const tag = (extra: Partial<ApprovalTag> = {}): ApprovalTag => ({
  action: 'command',
  permissionKey: 'claude:command',
  options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
  ...extra
})
const USER = { kind: 'user', via: 'gui' } as const
/** The class of action a Claude tool is, as the provider asks it: the key and the kind of approval. */
const kindOf = (tool: Tool): Pick<ApprovalTag, 'action' | 'permissionKey'> =>
  ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool.name) ? { action: 'edit', permissionKey: 'claude:edit' } : { action: 'command', permissionKey: 'claude:command' }
/** `listRuns` is newest first. */
const asc = (runs: RunRecord[]): RunRecord[] => [...runs].reverse()

describe('saved approval requests: the store and the question service', () => {
  let profileHome: string | undefined
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const db of dbs.splice(0)) db.close()
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  /** An engine and a question service bound to it, as the orchestrator binds them. */
  const fixture = () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-approvals-'))
    const db = new ProfileDatabase({ profileHome })
    dbs.push(db)
    const store = new RunStore(db)
    const engine = new RunEngine({ store, pid: 1, outbox: new EffectOutbox(store) })
    engine.reconcileOnBoot()
    const questions = new UserQuestionService()
    const origins = new Map<string, TurnOrigin>()
    /** The permission mode and approvals policy each thread's run is bound to (the strictest unless a test says otherwise). */
    const modes = new Map<string, PermissionMode>()
    const policies = new Map<string, RunPolicy['approvals']>()
    /** Threads whose run no person started (a scheduled job, a webhook, a subagent, a bot, an agent's message). */
    const unattended = new Set<string>()
    /** The thread's own mode now, when it differs from the run's (a tighter mode applies to the next turn). */
    const currentModes = new Map<string, PermissionMode>()
    /** Threads whose run binding records no permission mode. */
    const unknownModes = new Set<string>()
    const continuations: ContinuationDue[] = []
    const mode = { effects: false }
    questions.setLineageSource((threadId) => engine.delegations.getLineage(threadId))
    questions.setApprovalStore({
      store: engine.approvals,
      context: (threadId) => {
        const run = engine.getActiveRun(threadId)
        return run
          ? { runId: run.runId, instanceId: 'claude', provider: 'claude', origin: origins.get(threadId) ?? 'interactive', ...(unknownModes.has(threadId) ? {} : { permissionMode: modes.get(threadId) ?? 'ask' }), ...(currentModes.has(threadId) ? { currentMode: currentModes.get(threadId)! } : {}), approvals: policies.get(threadId) ?? 'ask', startedByPerson: !unattended.has(threadId) }
          : null
      },
      effectDelivery: () => mode.effects,
      continuationDue: (due) => continuations.push(due)
    })
    // The orchestrator closes a callback when its request is closed by the engine (a run that ended).
    engine.on('event', (event: { type: string; payload: { requestId?: string; reason?: string } }) => {
      if (event.type === 'approval.cancelled' && event.payload.requestId) questions.approvalClosed(event.payload.requestId, event.payload.reason ?? 'withdrawn')
    })
    return { engine, store, questions, origins, modes, currentModes, unattended, unknownModes, policies, continuations, mode }
  }

  const running = async (engine: RunEngine, threadId: string, key: string): Promise<RunRecord> => {
    const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    return engine.markRunning(sent.runId)
  }

  /** Asks and returns the callback's promise with the request id; the promise never throws here. */
  const ask = (f: ReturnType<typeof fixture>, threadId: string, approval: ApprovalTag = tag({ tool: BASH('npm test') }), questions = prompt()) => {
    const outcome: { value?: Record<string, string | string[]>; error?: Error } = {}
    const promise = f.questions.requestAnswers(questions, threadId, { approval }).then((value) => { outcome.value = value }, (error: Error) => { outcome.error = error })
    const requestId = f.questions.listPendingForThread(threadId).at(-1)!.requestId
    return { requestId, promise, outcome }
  }

  it('saves a request before asking and lists it with the plain questions, which stay in memory', async () => {
    const f = fixture()
    const run = await running(f.engine, 't', 'req-1')
    const events: unknown[] = []
    f.questions.on('pending', (payload) => events.push(payload))
    const request = ask(f, 't', tag({ tool: BASH('npm test'), reason: 'Claude Code asks even in Full access: its own safety check.' }))
    const plain = f.questions.requestAnswers([{ id: 'q', prompt: 'Plain?', options: [] }], 't')
    plain.catch(() => undefined)

    expect(f.engine.approvals.get(request.requestId)).toMatchObject({
      status: 'pending', answerPath: 'live', threadId: 't', runId: run.runId, instanceId: 'claude', provider: 'claude',
      action: 'command', permissionKey: 'claude:command', reason: 'Claude Code asks even in Full access: its own safety check.'
    })
    expect(f.engine.approvals.get(request.requestId)!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Only the approval is a row; one pending event per request.
    expect(f.engine.approvals.listPending('t').map((row) => row.requestId)).toEqual([request.requestId])
    expect(events).toHaveLength(2)
    const listed = f.questions.listPendingForThread('t')
    expect(listed).toHaveLength(2)
    const view = listed.find((entry) => entry.requestId === request.requestId)!
    expect(view.approval).toMatchObject({ answerPath: 'live', reason: expect.stringContaining('own safety check') })
    expect(view.questions[0]!.options).toEqual([
      { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
      { id: 'reject', label: 'Reject', decision: 'reject' }
    ])
    expect(f.questions.getPending(request.requestId)).not.toBeNull()
    expect(f.store.listEvents('t').filter((event) => event.type === 'approval.pending')).toHaveLength(1)
    f.questions.dismissAllForThread('t')
    await request.promise
  })

  describe('decisions are read from what an option means, never from its provider id', () => {
    const decide = async (questions: PendingUserQuestions['questions'], options: ApprovalTag['options'], answers: Record<string, string>) => {
      const f = fixture()
      await running(f.engine, 't', 'req-1')
      const request = ask(f, 't', tag({ options, tool: BASH('ls') }), questions)
      const settled = f.questions.settle(request.requestId, answers, USER)
      await request.promise
      return { settled, row: f.engine.approvals.get(request.requestId)!, outcome: request.outcome }
    }

    it('Claude and Codex answer { permission: allow }', async () => {
      const { settled, row, outcome } = await decide(prompt(), tag().options, { permission: 'allow' })
      expect(settled).toEqual({ ok: true, decision: 'allow' })
      expect(row).toMatchObject({ status: 'answered', decision: 'allow', decisionScope: 'once', answeredBy: { kind: 'user', via: 'gui' } })
      expect(outcome.value).toEqual({ permission: 'allow' })
    })

    it('an ACP file write answers { write: allow }', async () => {
      const { row } = await decide(
        [{ id: 'write', prompt: 'Allow the agent to write a.txt?', options: [{ id: 'allow', label: 'Allow this edit' }, { id: 'reject', label: 'Reject' }] }],
        tag().options,
        { write: 'allow' }
      )
      expect(row.decision).toBe('allow')
    })

    it('an ACP permission answers the agent\'s own option id, whatever it is called', async () => {
      const options = [{ id: 'proceed_once', decision: 'allow' as const, scope: 'once' as const }, { id: 'abort', decision: 'reject' as const }]
      const questions = [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'proceed_once', label: 'Yes, once' }, { id: 'abort', label: 'No' }] }]
      expect((await decide(questions, options, { permission: 'proceed_once' })).row.decision).toBe('allow')
      expect((await decide(questions, options, { permission: 'abort' })).row.decision).toBe('reject')
    })

    it('an option nobody offered rejects, and a typed answer is the reason the agent is given', async () => {
      const { row, outcome } = await decide(prompt(), tag().options, { permission: 'use pnpm instead' })
      expect(row).toMatchObject({ decision: 'reject', feedback: 'use pnpm instead' })
      expect(outcome.value).toMatchObject({ permission: 'use pnpm instead', feedback: 'use pnpm instead' })
    })
  })

  it('the deny path: a rejection carries its reason to the agent and no grant is left', async () => {
    const f = fixture()
    await running(f.engine, 't', 'req-1')
    const request = ask(f, 't')
    expect(f.questions.settle(request.requestId, { permission: 'reject', feedback: '  never run tests here  ' }, { kind: 'user', via: 'cli' })).toEqual({ ok: true, decision: 'reject' })
    await request.promise
    expect(request.outcome.value).toEqual({ permission: 'reject', feedback: 'never run tests here' })
    expect(f.engine.approvals.get(request.requestId)).toMatchObject({ status: 'answered', decision: 'reject', feedback: 'never run tests here', answeredBy: { kind: 'user', via: 'cli' }, deliveredAt: expect.any(String) })
    expect(f.engine.approvals.consumeContinuationGrant('t', 'any', f.engine.approvals.get(request.requestId)!.fingerprint)).toBe(false)
    expect(f.questions.listPendingForThread('t')).toEqual([])
  })

  it('one answer wins a race: the second gets already_answered with the winner and the callback is resolved once', async () => {
    const f = fixture()
    await running(f.engine, 't', 'req-1')
    const request = ask(f, 't')
    const resolved = vi.fn()
    void request.promise.then(resolved)
    const cleared = vi.fn()
    f.questions.on('cleared', cleared)

    const winner = f.questions.settle(request.requestId, { permission: 'allow' }, { kind: 'user', via: 'cli' })
    const loser = f.questions.settle(request.requestId, { permission: 'reject' }, { kind: 'user', via: 'bridge' })
    expect(winner).toEqual({ ok: true, decision: 'allow' })
    expect(loser).toEqual({ ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'cli' }, decision: 'allow' })
    await request.promise
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(request.outcome.value).toEqual({ permission: 'allow' })
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(f.engine.approvals.get(request.requestId)).toMatchObject({ decision: 'allow', answeredBy: { kind: 'user', via: 'cli' } })
    // Dismissing after an answer is no second answer either.
    expect(f.questions.dismiss(request.requestId, USER)).toBe(false)
    expect(f.store.listEvents('t').filter((event) => event.type === 'approval.answered')).toHaveLength(1)
  })

  it('an answer is committed with its delivery effect and reaches the provider once, from the executor', async () => {
    const f = fixture()
    f.mode.effects = true
    await running(f.engine, 't', 'req-1')
    const request = ask(f, 't')
    expect(f.questions.settle(request.requestId, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
    // The answer and its delivery intent are one commit; the provider has not heard yet.
    const effect = f.engine.outbox.listForThread('t').find((entry) => entry.kind === 'request.respond')
    expect(effect).toMatchObject({ status: 'pending', class: 'process_bound', payload: { requestId: request.requestId } })
    expect(f.engine.approvals.get(request.requestId)).toMatchObject({ status: 'answered', deliveredAt: null })
    expect(request.outcome.value).toBeUndefined()
    expect(f.questions.listPendingForThread('t')).toEqual([])

    expect(f.questions.deliver(request.requestId)).toBe(true)
    await request.promise
    expect(request.outcome.value).toEqual({ permission: 'allow' })
    expect(f.engine.approvals.get(request.requestId)!.deliveredAt).toEqual(expect.any(String))
    // A repeat of the executor (or a late duplicate) delivers nothing.
    expect(f.questions.deliver(request.requestId)).toBe(false)
  })

  describe('requests closed without an answer', () => {
    it('the provider withdrawing (its signal aborts) or Stop closes the row; a later Approve learns it is closed', async () => {
      const f = fixture()
      await running(f.engine, 't', 'req-1')
      const controller = new AbortController()
      const withdrawn: { error?: Error } = {}
      const promise = f.questions.requestAnswers(prompt(), 't', { approval: tag({ tool: BASH('a') }), signal: controller.signal }).catch((error: Error) => { withdrawn.error = error })
      const withdrawnId = f.questions.listPendingForThread('t')[0]!.requestId
      controller.abort()
      await promise
      expect(f.engine.approvals.get(withdrawnId)).toMatchObject({ status: 'cancelled', cancelReason: 'withdrawn' })
      expect(withdrawn.error).toBeInstanceOf(Error)
      expect(f.questions.settle(withdrawnId, { permission: 'allow' }, USER)).toEqual({ ok: false, reason: 'cancelled', cancelReason: 'withdrawn' })
      expect(f.questions.listPendingForThread('t')).toEqual([])

      const stopped = ask(f, 't', tag({ tool: BASH('b') }))
      f.questions.dismissAllForThread('t', 'stopped')
      await stopped.promise
      expect(stopped.outcome.error).toBeInstanceOf(Error)
      expect(f.engine.approvals.get(stopped.requestId)).toMatchObject({ status: 'cancelled', cancelReason: 'stopped' })
      expect(f.store.listEvents('t').filter((event) => event.type === 'approval.cancelled').map((event) => (event.payload as { reason: string }).reason)).toEqual(['withdrawn', 'stopped'])
    })

    it('a run that ends closes its request and the thread leaves awaiting input; an in-memory ask_user still waits', async () => {
      const f = fixture()
      const run = await running(f.engine, 't', 'req-1')
      const request = ask(f, 't')
      const plain = f.questions.requestAnswers([{ id: 'q', prompt: 'Which database?', options: [{ id: 'a', label: 'A' }] }], 't')
      plain.catch(() => undefined)
      expect(f.questions.listPendingForThread('t')).toHaveLength(2)

      f.engine.markTerminal(run.runId, 'failed', { error: 'boom' })
      await request.promise
      expect(request.outcome.error).toBeInstanceOf(Error)
      expect(f.engine.approvals.get(request.requestId)).toMatchObject({ status: 'cancelled', cancelReason: 'turn_ended' })
      // Only the question that lives in memory still shows the thread as waiting.
      expect(f.questions.listPendingForThread('t').map((entry) => entry.questions[0]!.id)).toEqual(['q'])
      // An answer after the run ended is refused with the reason, and nothing is delivered.
      expect(f.questions.settle(request.requestId, { permission: 'allow' }, USER)).toEqual({ ok: false, reason: 'cancelled', cancelReason: 'turn_ended' })
      expect(f.questions.submitAnswers(request.requestId, { permission: 'allow' }, USER)).toBe(false)
    })

    it('deleting the thread closes its requests', async () => {
      const f = fixture()
      await running(f.engine, 't', 'req-1')
      const request = ask(f, 't')
      f.engine.approvals.cancelForThread('t', 'thread_deleted')
      await request.promise
      expect(f.engine.approvals.get(request.requestId)).toMatchObject({ status: 'cancelled', cancelReason: 'thread_deleted' })
      expect(f.questions.listPendingForThread('t')).toEqual([])
    })

    it('a request with no timeout while a person runs the turn; an unattended origin keeps the ten minutes', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const f = fixture()
      await running(f.engine, 'person', 'req-1')
      await running(f.engine, 'job', 'req-2')
      f.origins.set('job', 'schedule')
      const person = ask(f, 'person')
      const job = ask(f, 'job', tag({ tool: BASH('make') }))

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
      await job.promise
      expect(job.outcome.error?.message).toBe('User did not answer in time.')
      expect(f.engine.approvals.get(job.requestId)).toMatchObject({ status: 'cancelled', cancelReason: 'timed_out' })
      expect(f.questions.settle(job.requestId, { permission: 'allow' }, USER)).toEqual({ ok: false, reason: 'cancelled', cancelReason: 'timed_out' })
      // The person's request is still waiting a day later, answerable, and nobody was notified again.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(f.engine.approvals.get(person.requestId)!.status).toBe('pending')
      expect(f.questions.settle(person.requestId, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      await person.promise
      expect(person.outcome.value).toEqual({ permission: 'allow' })
    })

    it('an explicit timeout applies to a saved request too', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const f = fixture()
      await running(f.engine, 't', 'req-1')
      const outcome: { error?: Error } = {}
      const promise = f.questions.requestAnswers(prompt(), 't', { approval: tag(), timeoutMs: 1000 }).catch((error: Error) => { outcome.error = error })
      const requestId = f.questions.listPendingForThread('t')[0]!.requestId
      await vi.advanceTimersByTimeAsync(1001)
      await promise
      expect(outcome.error?.message).toBe('User did not answer in time.')
      expect(f.engine.approvals.get(requestId)!.cancelReason).toBe('timed_out')
    })
  })

  describe('who may answer is decided where the request is settled', () => {
    const lineage = { parentThreadId: 'parent', relationship: 'subagent' as const }
    const store = () => {
      const f = fixture()
      const approvals = new ThreadApprovals(f.store, { outbox: f.engine.outbox, lineage: (threadId) => (threadId === 'child' ? lineage : null) })
      approvals.create({ requestId: 'r-1', threadId: 'child', instanceId: 'codex', provider: 'codex', action: 'command', permissionKey: 'codex:command', questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'always', label: 'Always', decision: 'allow', scope: 'always' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }] })
      return approvals
    }
    const parent = (permissionMode: 'ask' | 'accept_edits' | 'full', threadId = 'parent') => ({ kind: 'agent', threadId, runId: 'run-p', permissionMode }) as const

    it('refuses an agent that is not the parent, its own request, a mode that would ask, and a standing grant; the request stays pending', () => {
      const approvals = store()
      expect(approvals.settle('r-1', { permission: 'allow' }, parent('full', 'stranger'))).toEqual({ ok: false, reason: 'not_parent' })
      expect(approvals.settle('r-1', { permission: 'allow' }, parent('full', 'child'))).toEqual({ ok: false, reason: 'own_request' })
      expect(approvals.settle('r-1', { permission: 'allow' }, parent('accept_edits'))).toEqual({ ok: false, reason: 'mode_forbids' })
      expect(approvals.settle('r-1', { permission: 'always' }, parent('full'))).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
      expect(approvals.get('r-1')).toMatchObject({ status: 'pending', decision: null })
      expect(approvals.settle('r-1', { permission: 'allow' }, parent('full'))).toMatchObject({ ok: true, decision: 'allow' })
      expect(approvals.get('r-1')!.answeredBy).toEqual({ kind: 'agent', threadId: 'parent', runId: 'run-p' })
    })

    it('a user may always answer, and an answer to an unknown request says so', () => {
      const approvals = store()
      expect(approvals.settle('missing', { permission: 'allow' }, USER)).toEqual({ ok: false, reason: 'unknown' })
      expect(approvals.settle('r-1', { permission: 'always' }, USER)).toMatchObject({ ok: true, decision: 'allow', scope: 'always' })
    })
  })

  describe('"Always for this thread" (SPEC §17.8)', () => {
    const ALWAYS = 'allow_always'
    const CWD = '/work/app'
    const claudeEdit = (input: Record<string, unknown>, cwd = CWD): Tool => ({ name: 'Edit', input, cwd })

    /** A thread `t` with a run that asks under `mode`, as a run bound to that mode does. */
    const asking = async (mode: PermissionMode = 'accept_edits') => {
      const f = fixture()
      f.modes.set('t', mode)
      await running(f.engine, 't', 'req-1')
      return f
    }
    /** Requests `tool` the way the provider does and says whether the user was asked. A request that was asked stays pending. */
    const request = (f: ReturnType<typeof fixture>, tool: Tool | undefined, extra: Partial<ApprovalTag> = {}, threadId = 't') => {
      const before = f.questions.listPendingForThread(threadId).length
      const approval = tag({ ...(tool ? { tool, ...kindOf(tool) } : {}), ...extra })
      const outcome: { value?: Record<string, string | string[]>; error?: Error } = {}
      const promise = f.questions.requestAnswers(prompt(`Allow Claude Code to run ${tool?.name ?? 'something'}?\n${JSON.stringify(tool?.input ?? {})}`), threadId, { approval })
        .then((value) => { outcome.value = value }, (error: Error) => { outcome.error = error })
      const pending = f.questions.listPendingForThread(threadId)
      return { asked: pending.length > before, requestId: pending.at(-1)?.requestId ?? '', optionIds: pending.length > before ? pending.at(-1)!.questions[0]!.options.map((option) => option.id) : [], promise, outcome }
    }
    /** Asks and, when asked, withdraws the request again so the test goes on. */
    const probe = async (f: ReturnType<typeof fixture>, tool: Tool | undefined, extra: Partial<ApprovalTag> = {}, threadId = 't') => {
      const result = request(f, tool, extra, threadId)
      if (result.asked) f.questions.dismissAllForThread(threadId)
      await result.promise
      return result
    }
    /** The user answers "Always for this thread" to a request for `tool`. */
    const allowAlways = async (f: ReturnType<typeof fixture>, tool: Tool, threadId = 't') => {
      const result = request(f, tool, {}, threadId)
      expect(result.asked).toBe(true)
      expect(f.questions.settle(result.requestId, { permission: ALWAYS }, USER)).toEqual({ ok: true, decision: 'allow' })
      await result.promise
      return result
    }
    const rules = (f: ReturnType<typeof fixture>, threadId = 't') => f.engine.approvals.listRules(threadId)
    const eventTypes = (f: ReturnType<typeof fixture>, type: string, threadId = 't') => f.store.listEvents(threadId).filter((event) => event.type === type)

    it('is offered only on a request that names its exact action, can be skipped, and runs where the user is asked', async () => {
      const f = await asking()
      const view = request(f, BASH('npm test'))
      expect(f.questions.getPending(view.requestId)!.questions[0]!.options).toEqual([
        { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
        { id: ALWAYS, label: 'Always for this thread', decision: 'allow', scope: 'always' },
        { id: 'reject', label: 'Reject', decision: 'reject' }
      ])
      f.questions.dismissAllForThread('t')
      await view.promise

      const offered = async (tool: Tool | undefined, extra: Partial<ApprovalTag> = {}) => (await probe(f, tool, extra)).optionIds.includes(ALWAYS)
      expect(await offered(BASH('npm test'))).toBe(true)
      // No fingerprint, no rule: nothing identifies the action.
      expect(await offered(undefined)).toBe(false)
      expect(await offered({ name: 'Bash', input: { command: 'npm test' } })).toBe(false)
      expect(await offered({ name: 'Bash', input: { description: 'no command' }, cwd: CWD })).toBe(false)
      expect(await offered({ name: 'integrate_delegation', input: { delegationId: 'd1' }, cwd: CWD }, { permissionKey: 'mousse:integrate', action: 'edit' })).toBe(false)
      // A check the provider will not let Mousse skip is never "always".
      expect(await offered(BASH('npm test'), { reason: 'Claude Code asks even in Full access: its own safety check.' })).toBe(false)
      // A run that does not ask (its policy grants) and a thread with no run have nothing to remember.
      f.policies.set('t', 'grants')
      expect(await offered(BASH('npm test'))).toBe(false)
      f.policies.delete('t')
      expect((await probe(f, BASH('npm test'), {}, 'idle')).optionIds).toEqual(['allow', 'reject'])
    })

    it('answering it allows the request once for the provider, records one rule with the mode it was granted under, and says so in the thread', async () => {
      const f = await asking('accept_edits')
      const first = await allowAlways(f, BASH('npm test'))
      // The provider only knows its own option.
      expect(first.outcome.value).toEqual({ permission: 'allow' })
      const row = f.engine.approvals.get(first.requestId)!
      expect(row).toMatchObject({ status: 'answered', decision: 'allow', decisionScope: 'always', permissionMode: 'accept_edits', answers: { permission: 'allow' } })
      expect(rules(f)).toEqual([expect.objectContaining({
        threadId: 't', fingerprint: row.fingerprint, permissionKey: 'claude:command', action: 'command', grantedUnder: 'accept_edits',
        sourceRequestId: first.requestId, summary: expect.stringContaining('npm test')
      })])
      expect(eventTypes(f, 'approval.rule_granted')).toHaveLength(1)
      expect(eventTypes(f, 'approval.answered')[0]!.payload).toMatchObject({ decision: 'allow', scope: 'always' })
    })

    it('then answers that exact request without asking, in the same thread, and records why nothing asked', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      const events: unknown[] = []
      f.questions.on('pending', (payload) => events.push(payload))

      // A different label for the same command is the same action; so is the same request again, any number of times.
      for (const tool of [BASH('npm test'), BASH('npm test', { description: 'Run the unit tests' }), BASH('npm test')]) {
        const again = request(f, tool)
        expect(again.asked).toBe(false)
        await again.promise
        expect(again.outcome.value).toEqual({ permission: 'allow' })
      }
      expect(events).toEqual([])
      expect(f.engine.approvals.listPending('t')).toEqual([])
      expect(eventTypes(f, 'approval.rule_applied')).toHaveLength(3)
      // Only the first request is a row: a rule answers without saving a request.
      expect(f.store.listEvents('t').filter((event) => event.type === 'approval.pending')).toHaveLength(1)
    })

    it('never widens: another command, folder, argument or tool still asks', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      const nearMisses: Array<[string, Tool]> = [
        ['an extra argument', BASH('npm test --watch')],
        ['a longer command', BASH('npm test && rm -rf dist')],
        ['a command chained before it', BASH('rm -rf dist; npm test')],
        ['different spacing', BASH('npm  test')],
        ['different case', BASH('NPM test')],
        ['a prefix', BASH('npm')],
        ['another timeout', BASH('npm test', { timeout: 5000 })],
        ['running in the background', BASH('npm test', { run_in_background: true })],
        ['another folder', { ...BASH('npm test'), cwd: '/work/other' }],
        ['a subfolder', { ...BASH('npm test'), cwd: '/work/app/packages/a' }],
        ['the parent folder', { ...BASH('npm test'), cwd: '/work' }],
        ['another shell', { name: 'PowerShell', input: { command: 'npm test' }, cwd: CWD }]
      ]
      for (const [name, tool] of nearMisses) {
        const result = await probe(f, tool)
        expect(result.asked, name).toBe(true)
      }
      // Asking about them made no rule.
      expect(rules(f)).toHaveLength(1)
    })

    it('a file rule covers that edit only: another path, text, mode or tool asks', async () => {
      const f = await asking()
      const edit = { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' }
      await allowAlways(f, claudeEdit(edit))
      // The same edit, with an explicit default, is the same edit.
      expect((await probe(f, claudeEdit({ ...edit, replace_all: false }))).asked).toBe(false)
      for (const [name, tool] of [
        ['another file', claudeEdit({ ...edit, file_path: '/work/app/src/b.ts' })],
        ['a sibling with the same prefix', claudeEdit({ ...edit, file_path: '/work/app/src/a.ts.bak' })],
        ['a parent path', claudeEdit({ ...edit, file_path: '/work/app/src/../secrets.env' })],
        ['other new text', claudeEdit({ ...edit, new_string: 'c' })],
        ['other old text', claudeEdit({ ...edit, old_string: 'x' })],
        ['replacing every match', claudeEdit({ ...edit, replace_all: true })],
        ['another folder', claudeEdit(edit, '/work/other')],
        ['a whole-file write', { name: 'Write', input: { file_path: edit.file_path, content: 'b' }, cwd: CWD } as Tool]
      ] as Array<[string, Tool]>)
        expect((await probe(f, tool)).asked, name).toBe(true)
      // A command rule never answers an edit, nor an edit rule a command.
      expect((await probe(f, BASH('npm test'))).asked).toBe(true)
    })

    it('an action with no fingerprint never matches a rule, whatever rules the thread has', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      expect(f.engine.approvals.matchRule('t', 'claude:command', null, 'full')).toBeNull()
      for (const [name, tool, extra] of [
        ['no tool description', undefined, {}],
        ['no directory', { name: 'Bash', input: { command: 'npm test' } }, {}],
        ['an input that fails its shape', { name: 'Bash', input: { command: 42 }, cwd: CWD }, {}],
        ['a Mousse tool', { name: 'integrate_delegation', input: { delegationId: 'd1' }, cwd: CWD }, { permissionKey: 'mousse:integrate', action: 'edit' as const }],
        ['a check the provider will not skip', BASH('npm test'), { reason: 'its own safety check' }]
      ] as Array<[string, Tool | undefined, Partial<ApprovalTag>]>) {
        expect((await probe(f, tool, extra)).asked, name).toBe(true)
      }
      // A rule row cannot be matched by the empty fingerprint either.
      expect(rules(f).every((rule) => rule.fingerprint.length === 64)).toBe(true)
    })

    it('belongs to its thread: another thread asks, and so do a fork or a subagent, which are other threads', async () => {
      const f = await asking()
      await running(f.engine, 'other', 'req-2')
      f.modes.set('other', 'accept_edits')
      await allowAlways(f, BASH('npm test'))
      expect((await probe(f, BASH('npm test'), {}, 'other')).asked).toBe(true)
      expect(rules(f, 'other')).toEqual([])
      expect((await probe(f, BASH('npm test'))).asked).toBe(false)
      // Revoking on one thread leaves the other's rules alone.
      await allowAlways(f, BASH('npm test'), 'other')
      expect(f.engine.approvals.revokeRules('t')).toBe(1)
      expect(rules(f, 'other')).toHaveLength(1)
      expect((await probe(f, BASH('npm test'), {}, 'other')).asked).toBe(false)
    })

    it('is ignored while the thread asks about more than it did, and answers again when the mode loosens', async () => {
      const f = await asking('accept_edits')
      await allowAlways(f, BASH('npm test'))
      f.modes.set('t', 'ask')
      expect((await probe(f, BASH('npm test'))).asked).toBe(true)
      // The rule is not cleared: it waits.
      expect(rules(f)).toHaveLength(1)
      f.modes.set('t', 'accept_edits')
      expect((await probe(f, BASH('npm test'))).asked).toBe(false)
      // A rule made under Ask holds at every mode that asks less.
      const strict = await asking('ask')
      await allowAlways(strict, BASH('npm test'))
      expect(rules(strict)[0]!.grantedUnder).toBe('ask')
      strict.modes.set('t', 'accept_edits')
      expect((await probe(strict, BASH('npm test'))).asked).toBe(false)
      // Under Full access the run asks nothing but the checks the provider keeps: a rule does not answer those.
      strict.modes.set('t', 'full')
      strict.policies.set('t', 'grants')
      expect((await probe(strict, BASH('npm test'))).asked).toBe(true)
    })

    it('asked again under a stricter mode, the rule keeps the stricter grant', async () => {
      const f = await asking('accept_edits')
      await allowAlways(f, BASH('npm test'))
      f.modes.set('t', 'ask')
      await allowAlways(f, BASH('npm test'))
      expect(rules(f)).toHaveLength(1)
      expect(rules(f)[0]!.grantedUnder).toBe('ask')
      // A later "always" under a looser mode does not loosen it.
      f.modes.set('t', 'accept_edits')
      f.engine.approvals.revokeRules('t')
      await allowAlways(f, BASH('npm test'))
      expect(rules(f)[0]!.grantedUnder).toBe('accept_edits')
    })

    it('only a user makes one: a refusal, a typed answer, an agent and a request saved without its mode make none', async () => {
      const f = await asking()
      const rejected = request(f, BASH('npm test'))
      f.questions.settle(rejected.requestId, { permission: 'reject' }, USER)
      await rejected.promise
      const typed = request(f, BASH('npm test'))
      f.questions.settle(typed.requestId, { permission: 'always, please' }, USER)
      await typed.promise
      expect(rules(f)).toEqual([])
      expect(f.engine.approvals.get(typed.requestId)).toMatchObject({ decision: 'reject', decisionScope: null })

      // An agent answering for its subagent may approve once, never "always": the request stays pending.
      const child = f.engine.approvals
      const lineage = { parentThreadId: 'parent', relationship: 'subagent' as const }
      const agentStore = new ThreadApprovals(f.store, { outbox: f.engine.outbox, lineage: (threadId) => (threadId === 't' ? lineage : null) })
      const asked = request(f, BASH('npm test'))
      expect(agentStore.settle(asked.requestId, { permission: ALWAYS }, { kind: 'agent', threadId: 'parent', runId: 'run-p', permissionMode: 'full' })).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
      expect(child.get(asked.requestId)!.status).toBe('pending')
      expect(rules(f)).toEqual([])
      f.questions.dismissAllForThread('t')
      await asked.promise

      // A request saved before the mode was recorded cannot say what the rule was granted under.
      const legacy = child.create({
        requestId: 'legacy', threadId: 't', instanceId: 'claude', provider: 'claude', action: 'command', permissionKey: 'claude:command', fingerprint: 'a'.repeat(64),
        questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: ALWAYS, label: 'Always', decision: 'allow', scope: 'always' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }]
      })
      expect(child.settle(legacy.requestId, { permission: ALWAYS }, USER)).toMatchObject({ ok: true, decision: 'allow', scope: 'always' })
      expect(rules(f)).toEqual([])
    })

    it('two clients answering "always" at once leave one rule, and the loser is told who won', async () => {
      const f = await asking()
      const result = request(f, BASH('npm test'))
      const winner = f.questions.settle(result.requestId, { permission: ALWAYS }, { kind: 'user', via: 'cli' })
      const loser = f.questions.settle(result.requestId, { permission: 'reject' }, { kind: 'user', via: 'bridge' })
      expect(winner).toEqual({ ok: true, decision: 'allow' })
      expect(loser).toEqual({ ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'cli' }, decision: 'allow' })
      await result.promise
      expect(rules(f)).toHaveLength(1)
      expect(eventTypes(f, 'approval.rule_granted')).toHaveLength(1)
    })

    it('can be revoked one at a time or all at once, after which the request asks again', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      await allowAlways(f, BASH('npm run build'))
      expect(rules(f)).toHaveLength(2)
      const first = rules(f).find((rule) => rule.summary.includes('npm test'))!
      const second = rules(f).find((rule) => rule.summary.includes('npm run build'))!
      expect(f.engine.approvals.revokeRules('t', 'f'.repeat(64))).toBe(0)
      expect(f.engine.approvals.revokeRules('t', first.fingerprint)).toBe(1)
      expect((await probe(f, BASH('npm test'))).asked).toBe(true)
      expect((await probe(f, BASH('npm run build'))).asked).toBe(false)
      expect(f.engine.approvals.revokeRules('t')).toBe(1)
      expect(rules(f)).toEqual([])
      expect((await probe(f, BASH('npm run build'))).asked).toBe(true)
      expect(eventTypes(f, 'approval.rule_revoked').map((event) => (event.payload as { fingerprint: string }).fingerprint)).toEqual([first.fingerprint, second.fingerprint])
      expect(f.engine.approvals.revokeRules('t')).toBe(0)
    })

    it('asks when the rules cannot be read, rather than answering', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.spyOn(f.engine.approvals, 'matchRule').mockImplementation(() => { throw new Error('database is locked') })
      expect((await probe(f, BASH('npm test'))).asked).toBe(true)
    })

    it('answers and is offered only in turns a person started: scheduled, webhook, subagent, bot and agent-sent turns ask as before', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      f.unattended.add('t')
      // The rule exists and the mode would allow it, but no person started this turn: asked, and no "always" offered.
      const asked = await probe(f, BASH('npm test'))
      expect(asked.asked).toBe(true)
      expect(asked.optionIds).toEqual(['allow', 'reject'])
      expect((await probe(f, BASH('npm run build'))).optionIds).toEqual(['allow', 'reject'])
      expect(rules(f)).toHaveLength(1)
      expect(eventTypes(f, 'approval.rule_applied')).toHaveLength(0)
      f.unattended.delete('t')
      expect((await probe(f, BASH('npm test'))).asked).toBe(false)
    })

    it('is not offered, made or matched when the run\'s binding records no permission mode', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      f.unknownModes.add('t')
      const result = await probe(f, BASH('npm test'))
      expect(result.asked).toBe(true)
      expect(result.optionIds).toEqual(['allow', 'reject'])
    })

    it('pauses at once when the thread\'s own mode is stricter than the run\'s, which a mode change only applies to the next turn', async () => {
      const f = await asking('accept_edits')
      await allowAlways(f, BASH('npm test'))
      f.currentModes.set('t', 'ask')
      expect((await probe(f, BASH('npm test'))).asked).toBe(true)
      f.currentModes.delete('t')
      expect((await probe(f, BASH('npm test'))).asked).toBe(false)
    })

    it('answering "always" allows the identical requests waiting beside it, and no other', async () => {
      const f = await asking()
      const first = request(f, BASH('npm test'))
      const twin = request(f, BASH('npm test'))
      const other = request(f, BASH('npm run build'))
      expect([first.asked, twin.asked, other.asked]).toEqual([true, true, true])
      expect(f.questions.settle(first.requestId, { permission: ALWAYS }, USER)).toEqual({ ok: true, decision: 'allow' })
      await Promise.all([first.promise, twin.promise])
      expect(twin.outcome.value).toEqual({ permission: 'allow' })
      expect(f.engine.approvals.get(twin.requestId)).toMatchObject({ status: 'answered', decision: 'allow', decisionScope: 'once', answeredBy: { kind: 'user', via: 'gui' } })
      expect(f.engine.approvals.get(other.requestId)!.status).toBe('pending')
      expect(f.questions.listPendingForThread('t').map((entry) => entry.requestId)).toEqual([other.requestId])
      f.questions.dismissAllForThread('t')
      await other.promise
    })

    it('shows the end of a long command, so two that differ only there are told apart', async () => {
      const f = await asking()
      const long = (tail: string) => BASH(`echo ${'x'.repeat(900)} ${tail}`)
      await allowAlways(f, long('one'))
      await allowAlways(f, long('two'))
      const summaries = rules(f).map((rule) => rule.summary)
      expect(summaries).toHaveLength(2)
      for (const summary of summaries) {
        expect(summary.length).toBeLessThanOrEqual(500)
        expect(summary).toContain(' ... ')
      }
      expect(summaries.some((summary) => summary.includes('one"}'))).toBe(true)
      expect(summaries.some((summary) => summary.includes('two"}'))).toBe(true)
    })

    it('a linked device cannot make a rule: the answer is refused and the request stays pending', async () => {
      const f = await asking()
      const result = request(f, BASH('npm test'))
      expect(f.questions.settle(result.requestId, { permission: ALWAYS }, { kind: 'user', via: 'bridge' })).toEqual({ ok: false, reason: 'bridge_no_standing_grant' })
      expect(f.engine.approvals.get(result.requestId)!.status).toBe('pending')
      expect(rules(f)).toEqual([])
      // It can still allow once.
      expect(f.questions.settle(result.requestId, { permission: 'allow' }, { kind: 'user', via: 'bridge' })).toEqual({ ok: true, decision: 'allow' })
      await result.promise
      expect(rules(f)).toEqual([])
    })

    it("another of the user's computers makes a rule within its limit, and the record names the computer", async () => {
      const device = (maxPermissionMode: 'ask' | 'accept_edits' | 'full') => ({ kind: 'user' as const, via: 'bridge' as const, node: 'nod_laptop', maxPermissionMode })
      const f = await asking()
      // A command under a device that is limited to Auto-accept edits: refused, still pending, no rule.
      const refused = request(f, BASH('npm test'))
      expect(f.questions.settle(refused.requestId, { permission: ALWAYS }, device('accept_edits'))).toEqual({ ok: false, reason: 'device_mode_forbids' })
      expect(f.engine.approvals.get(refused.requestId)!.status).toBe('pending')
      expect(rules(f)).toEqual([])
      // The same answer from a device raised to Full access makes the rule and is recorded with the computer.
      expect(f.questions.settle(refused.requestId, { permission: ALWAYS }, device('full'))).toEqual({ ok: true, decision: 'allow' })
      await refused.promise
      expect(rules(f)).toHaveLength(1)
      expect(f.engine.approvals.get(refused.requestId)).toMatchObject({ status: 'answered', answeredBy: { kind: 'user', via: 'bridge', node: 'nod_laptop' } })
    })

    it('goes with the thread', async () => {
      const f = await asking()
      await allowAlways(f, BASH('npm test'))
      expect(rules(f)).toHaveLength(1)
      f.engine.approvals.deleteForThread('t')
      expect(rules(f)).toEqual([])
    })
  })

  it('without a store an approval is an in-memory question, as before', async () => {
    const questions = new UserQuestionService()
    const waiter = questions.requestAnswers(prompt(), 't', { approval: tag() })
    const [pending] = questions.listPendingForThread('t')
    expect(pending!.approval).toBeUndefined()
    expect(questions.settle(pending!.requestId, { permission: 'allow' }, USER)).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toEqual({ permission: 'allow' })
    expect(questions.getRequest(pending!.requestId)).toBeNull()
  })

  it('a request that cannot be saved falls back to memory and is still answerable', async () => {
    const f = fixture()
    await running(f.engine, 't', 'req-1')
    vi.spyOn(f.engine.approvals, 'create').mockImplementationOnce(() => { throw new Error('disk full') })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const waiter = f.questions.requestAnswers(prompt(), 't', { approval: tag() })
    const [pending] = f.questions.listPendingForThread('t')
    expect(f.engine.approvals.listPending('t')).toEqual([])
    expect(f.questions.settle(pending!.requestId, { permission: 'allow' }, USER)).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toEqual({ permission: 'allow' })
  })

  it('saved prompts are bounded and carry no credentials; a deleted thread takes its requests with it', async () => {
    const f = fixture()
    await running(f.engine, 't', 'req-1')
    const request = ask(f, 't', tag({ tool: BASH('curl') }), prompt(`Allow Codex to run this command?\ncurl -H "Authorization: Bearer abcdef0123456789abcdef" "https://x.test?token=hunter2value" ${'y'.repeat(9000)}`))
    const saved = f.engine.approvals.get(request.requestId)!.questions[0]!.prompt
    expect(saved).not.toContain('abcdef0123456789abcdef')
    expect(saved).not.toContain('hunter2value')
    expect(saved.length).toBeLessThanOrEqual(4500)
    f.questions.settle(request.requestId, { permission: 'reject', feedback: 'no: sk-live-abcdef123456 leaked' }, USER)
    await request.promise
    const row = f.engine.approvals.get(request.requestId)!
    expect(row.feedback).not.toContain('sk-live-abcdef123456')
    expect(JSON.stringify(row.answers)).not.toContain('sk-live-abcdef123456')

    expect(f.engine.approvals.deleteForThread('t')).toBe(1)
    expect(f.engine.approvals.get(request.requestId)).toBeNull()
  })

  it('shutdown releases the callbacks and leaves the saved requests exactly as they are', async () => {
    const f = fixture()
    await running(f.engine, 't', 'req-1')
    const request = ask(f, 't')
    f.questions.shutdown()
    await request.promise
    expect(request.outcome.error?.name).toBe('AbortError')
    expect(f.engine.approvals.get(request.requestId)).toMatchObject({ status: 'pending', decision: null })
  })
})

describe('approval requests across a daemon restart', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const daemons: Phase6Daemon[] = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-approval-restart-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
  })
  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) {
      // A turn still waiting for the user must end before the daemon can stop.
      daemon.questions.shutdown()
      await daemon.stop().catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /**
   * The binding a real turn on the pi instance records. Requests are fingerprinted with the instance
   * they were asked on, so a run set up by hand needs the instance a continuation will run on.
   */
  const bindRun = (daemon: Phase6Daemon, run: RunRecord, origin: TurnOrigin = 'interactive'): void => {
    daemon.engine.recordExecutionBinding(run.runId, {
      instanceId: 'pi:openai', driver: 'pi', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'gpt-replay',
      policy: { mode: 'default', origin, approvals: 'ask', permissionMode: 'accept_edits' }
    })
  }

  /** A pi-shaped adapter whose script can ask the daemon's questions, like a provider does. */
  const scripted = (script: (input: TurnInput) => Promise<string> | string) => piAdapter((input) => script(input))

  /**
   * A daemon that dies while the run it is executing waits for the user: the run is active, each
   * `asks` entry is a request from it, and `tools` are started in the tool ledger.
   */
  const crashWhileAsking = async (asks: Tool[], options: { startedTools?: string[]; origin?: TurnOrigin; answerBeforeCrash?: boolean } = {}) => {
    const first = phase6Daemon(home!, [scripted(() => 'unused')], { pid: 1 })
    const thread = first.store.createThread('Approvals')
    first.orch.setThreadModelOverride(thread.id, PI)
    const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    first.engine.markStarting(sent.runId)
    const run = first.engine.markRunning(sent.runId)
    bindRun(first, run, options.origin)
    for (const [index, name] of (options.startedTools ?? []).entries())
      first.engine.tools.start({ invocationId: `call-${index}`, runId: run.runId, attemptId: run.activeAttemptId!, tool: name, argsDigest: 'd', now: new Date().toISOString() })
    const requestIds: string[] = []
    for (const tool of asks) {
      const waiter = first.questions.requestAnswers(prompt(`Allow Claude Code to run a command (${tool.name})?\n${JSON.stringify(tool.input)}`), thread.id, { approval: tag({ tool, ...kindOf(tool) }) })
      waiter.catch(() => undefined)
      requestIds.push(first.questions.listPendingForThread(thread.id).at(-1)!.requestId)
    }
    if (options.answerBeforeCrash) {
      // The answer is committed with its delivery effect, but the worker is gone before it runs.
      await first.worker.stop()
      first.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
    }
    await first.crash()
    // The process is gone: its callbacks die with it, the rows stay.
    first.questions.markInterruptedByDaemonRestart()
    return { threadId: thread.id, runId: run.runId, requestIds }
  }

  const boot = (adapter = scripted(() => 'ok'), pid = 2): Phase6Daemon => {
    const daemon = phase6Daemon(home!, [adapter], { pid })
    daemons.push(daemon)
    return daemon
  }

  const seen = (adapter: ReturnType<typeof piAdapter>): string[] => adapter.turns.flatMap((turn) => turn.messages.map((message) => String(message.content)))
  const settled = (daemon: Phase6Daemon, threadId: string, count: number) => waitFor(() => {
    const runs = asc(daemon.engine.listRuns(threadId))
    return runs.length >= count && runs.every((run) => ['completed', 'failed', 'interrupted', 'cancelled', 'uncertain'].includes(run.status))
  }, `${count} run(s) of the thread to settle`)

  it('a pending approval survives a daemon restart and nothing is granted or started by it', async () => {
    const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
    const adapter = scripted(() => 'ok')
    const second = boot(adapter)

    expect(second.boot.approvals.continued).toEqual(requestIds)
    const [pending] = second.questions.listPendingForThread(threadId)
    expect(pending).toMatchObject({ requestId: requestIds[0], threadId, approval: { answerPath: 'continue' } })
    expect(pending!.questions[0]!.prompt).toContain('npm test')
    expect(second.questions.getPending(requestIds[0]!)).not.toBeNull()
    expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'pending', decision: null, answerPath: 'continue', runId })
    // No approval was granted and no turn started on its own.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(second.engine.listRuns(threadId)).toHaveLength(1)
    expect(adapter.turns).toEqual([])
    expect(second.engine.approvals.get(requestIds[0]!)!.grantConsumedAt).toBeNull()
    // The restart note names the request.
    const note = second.engine.listEvents(threadId).find((event) => event.type === 'restart.note')
    expect((note!.payload as { approvalRequestIds?: string[] }).approvalRequestIds).toEqual(requestIds)
  })

  it('answering after a restart continues the thread once, the same action runs without asking, and a second client learns it lost', async () => {
    const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
    let second!: Phase6Daemon
    const asked: string[] = []
    const adapter = scripted(async (input) => {
      // The continued agent asks for the same action again, with only its description changed.
      const answers = await second.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test', { description: 'Run the unit tests' }) }) })
      return answers.permission === 'allow' ? 'ran it' : 'blocked'
    })
    second = boot(adapter)
    second.questions.on('pending', (payload: { requestId: string }) => asked.push(payload.requestId))

    const answered = second.questions.settle(requestIds[0]!, { permission: 'allow' }, { kind: 'user', via: 'cli' })
    expect(answered).toEqual({ ok: true, decision: 'allow' })
    await settled(second, threadId, 2)

    const runs = asc(second.engine.listRuns(threadId))
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({ status: 'completed', clientRequestId: `approval-run:${runId}`, outcome: { continuationOf: runId } })
    expect(adapter.turns).toHaveLength(1)
    // The agent was told what was decided, before the message that continued it.
    expect(seen(adapter).some((text) => text.includes('The user approved: Allow Claude Code to run a command (Bash)?'))).toBe(true)
    // Its request for the same action was answered by the grant: nobody was asked again.
    expect(asked).toEqual([])
    expect(second.orch.getMessages(threadId).some((message) => message.role === 'assistant' && message.content === 'ran it')).toBe(true)
    expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ continuationRunId: runs[1]!.runId, grantConsumedAt: expect.any(String), deliveredAt: expect.any(String), answeredBy: { kind: 'user', via: 'cli' } })

    // A second client answering the same request learns who won and starts nothing.
    expect(second.questions.settle(requestIds[0]!, { permission: 'reject' }, { kind: 'user', via: 'gui' })).toEqual({
      ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'cli' }, decision: 'allow'
    })
    expect(second.engine.listRuns(threadId)).toHaveLength(2)
  })

  describe('the grant covers the same action once, inside the run it started', () => {
    /**
     * A daemon dies waiting for `approved`; after the restart the user approves it and the continued agent
     * asks for each of `rerequests` in turn. Resolves with which of them the user was asked about.
     */
    const rerequest = async (approved: Tool, rerequests: Array<{ tool: Tool }>) => {
      const { threadId, requestIds } = await crashWhileAsking([approved])
      let second!: Phase6Daemon
      const asked: boolean[] = []
      const adapter = scripted(async (input) => {
        for (const { tool } of rerequests) {
          const before = second.engine.approvals.listPending(input.threadId).length
          const waiting = second.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool, ...kindOf(tool) }) })
          const wasAsked = second.engine.approvals.listPending(input.threadId).length > before
          asked.push(wasAsked)
          if (wasAsked) second.questions.settle(second.engine.approvals.listPending(input.threadId).at(-1)!.requestId, { permission: 'reject' }, USER)
          await waiting.catch(() => undefined)
        }
        return 'done'
      })
      second = boot(adapter)
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      await settled(second, threadId, 2)
      return { asked, second, threadId, requestId: requestIds[0]! }
    }

    it('a re-request that differs only in its description is not asked; the same action passes exactly once', async () => {
      const { asked } = await rerequest(BASH('npm test'), [{ tool: BASH('npm test', { description: 'again' }) }, { tool: BASH('npm test') }])
      expect(asked).toEqual([false, true])
    })

    it('a different command asks again', async () => {
      expect((await rerequest(BASH('npm test'), [{ tool: BASH('rm -rf dist') }])).asked).toEqual([true])
    })

    it('a PowerShell request never consumes a Bash grant for the same command text', async () => {
      expect((await rerequest(BASH('npm test'), [{ tool: { name: 'PowerShell', input: { command: 'npm test' }, cwd: '/work/app' } }])).asked).toEqual([true])
    })

    const edit = { file_path: '/a.ts', old_string: 'a', new_string: 'b' }
    const approvedEdit: Tool = { name: 'Edit', input: edit, cwd: '/work/app' }
    const notebook = { notebook_path: '/n.ipynb', new_source: 'x', cell_id: 'c1' }
    const approvedNotebook: Tool = { name: 'NotebookEdit', input: notebook, cwd: '/work/app' }
    const variant = (tool: Tool, input: Record<string, unknown>): Tool => ({ ...tool, input })

    it.each([
      ['an omitted and an explicit replace_all: false match', approvedEdit, { ...edit, replace_all: false }, false],
      ['replace_all: true is a different edit', approvedEdit, { ...edit, replace_all: true }, true],
      ['an omitted and an explicit edit_mode: replace match', approvedNotebook, { ...notebook, edit_mode: 'replace' }, false],
      ['another edit_mode is a different edit', approvedNotebook, { ...notebook, edit_mode: 'insert' }, true],
      ['another cell_type is a different edit', approvedNotebook, { ...notebook, cell_type: 'markdown' }, true]
    ] as Array<[string, Tool, Record<string, unknown>, boolean]>)('%s', async (_name, approved, input, wasAsked) => {
      expect((await rerequest(approved, [{ tool: variant(approved, input) }])).asked).toEqual([wasAsked])
    })

    it('an input that fails the tool\'s declared shape gets no grant', async () => {
      const malformed: Tool = { name: 'Bash', input: { description: 'no command' }, cwd: '/work/app' }
      const { asked, second, requestId } = await rerequest(malformed, [{ tool: malformed }])
      expect(asked).toEqual([true])
      expect(second.engine.approvals.get(requestId)!.fingerprint).toBeNull()
    })

    it('an unused grant is not consumable by the next run of the thread', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      let second!: Phase6Daemon
      let asking = false
      const adapter = scripted(async (input) => {
        // The continuation never asks for it; a later message's turn does.
        if (!asking) return 'continued without it'
        const before = second.engine.approvals.listPending(input.threadId).length
        const waiting = second.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
        const wasAsked = second.engine.approvals.listPending(input.threadId).length > before
        second.questions.dismissAllForThread(input.threadId)
        await waiting.catch(() => undefined)
        return wasAsked ? 'asked' : 'granted'
      })
      second = boot(adapter)
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
      await settled(second, threadId, 2)
      expect(second.engine.approvals.get(requestIds[0]!)!.grantConsumedAt).toBeNull()

      asking = true
      await second.orch.send('Run the tests now', false, { threadId, clientRequestId: 'next-message' })
      expect(second.orch.getMessages(threadId).filter((message) => message.role === 'assistant').at(-1)!.content).toBe('asked')
      expect(second.engine.approvals.get(requestIds[0]!)!.grantConsumedAt).toBeNull()
    })
  })

  describe('"Always for this thread" across a restart', () => {
    /** Asks each of `tools` in turn on the thread's current run; says which of them the user was asked about. The ones asked are rejected. */
    const probeTurn = async (daemon: Phase6Daemon, threadId: string, tools: Tool[]): Promise<boolean[]> => {
      const asked: boolean[] = []
      for (const tool of tools) {
        const before = daemon.engine.approvals.listPending(threadId).length
        const waiting = daemon.questions.requestAnswers(prompt(), threadId, { approval: tag({ tool, ...kindOf(tool) }) })
        const wasAsked = daemon.engine.approvals.listPending(threadId).length > before
        asked.push(wasAsked)
        if (wasAsked) daemon.questions.settle(daemon.engine.approvals.listPending(threadId).at(-1)!.requestId, { permission: 'reject' }, USER)
        await waiting.catch(() => undefined)
      }
      return asked
    }
    const NEAR_MISSES = [BASH('npm test --watch'), { ...BASH('npm test'), cwd: '/work/other' }, { name: 'PowerShell', input: { command: 'npm test' }, cwd: '/work/app' }] satisfies Tool[]

    it('a rule survives a daemon restart, answers only that exact request in later turns, and is gone once revoked', async () => {
      const first = phase6Daemon(home!, [scripted(() => 'unused')], { pid: 1 })
      const thread = first.store.createThread('Rules')
      first.orch.setThreadModelOverride(thread.id, PI)
      const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      first.engine.markStarting(sent.runId)
      bindRun(first, first.engine.markRunning(sent.runId))
      const waiter = first.questions.requestAnswers(prompt(), thread.id, { approval: tag({ tool: BASH('npm test') }) })
      const requestId = first.questions.listPendingForThread(thread.id)[0]!.requestId
      expect(first.questions.settle(requestId, { permission: 'allow_always' }, { kind: 'user', via: 'cli' })).toEqual({ ok: true, decision: 'allow' })
      await expect(waiter).resolves.toEqual({ permission: 'allow' })
      expect(first.orch.listApprovalRules(thread.id)).toEqual([expect.objectContaining({ permissionKey: 'claude:command', grantedUnder: 'accept_edits', active: true, summary: expect.stringContaining('npm test') })])
      await first.crash()
      first.questions.markInterruptedByDaemonRestart()

      let second!: Phase6Daemon
      const turns: boolean[][] = []
      const adapter = scripted(async (input) => {
        turns.push(await probeTurn(second, input.threadId, [BASH('npm test'), ...NEAR_MISSES]))
        return 'done'
      })
      second = boot(adapter)
      // The rule is still there, as it was written.
      expect(second.orch.listApprovalRules(thread.id)).toEqual([expect.objectContaining({ permissionKey: 'claude:command', grantedUnder: 'accept_edits', active: true })])
      await second.orch.send('Run the tests', false, { threadId: thread.id, clientRequestId: 'after-restart', source: 'gui' })
      expect(turns).toEqual([[false, true, true, true]])
      expect(second.engine.listEvents(thread.id).filter((event) => event.type === 'approval.rule_applied')).toHaveLength(1)

      // Revoking is the user's: the next turn asks again.
      expect(second.orch.clearApprovalRules(thread.id)).toEqual({ removed: 1 })
      await second.orch.send('Run the tests again', false, { threadId: thread.id, clientRequestId: 'after-revoke', source: 'gui' })
      expect(turns[1]).toEqual([true, true, true, true])
    })

    it('"always" answered after a restart continues the thread once, and the rule keeps answering the exact request in later turns', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      let second!: Phase6Daemon
      const turns: boolean[][] = []
      const adapter = scripted(async (input) => {
        turns.push(await probeTurn(second, input.threadId, [BASH('npm test'), ...NEAR_MISSES]))
        return 'done'
      })
      second = boot(adapter)
      expect(second.questions.listPendingForThread(threadId)[0]!.questions[0]!.options.map((option) => option.id)).toEqual(['allow', 'allow_always', 'reject'])

      expect(second.questions.settle(requestIds[0]!, { permission: 'allow_always' }, { kind: 'user', via: 'cli' })).toEqual({ ok: true, decision: 'allow' })
      await settled(second, threadId, 2)
      // The continuation: the one-shot grant answered the exact request; nothing else was waved through.
      expect(turns).toEqual([[false, true, true, true]])
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ decision: 'allow', decisionScope: 'always', grantConsumedAt: expect.any(String) })
      expect(second.orch.listApprovalRules(threadId)).toEqual([expect.objectContaining({ grantedUnder: 'accept_edits', permissionKey: 'claude:command' })])
      expect(second.engine.approvals.listRules(threadId)[0]!.sourceRequestId).toBe(requestIds[0])

      // A later turn is answered by the rule, not by a grant (the grant was used up).
      await second.orch.send('Run the tests again', false, { threadId, clientRequestId: 'later', source: 'gui' })
      expect(turns[1]).toEqual([false, true, true, true])
      expect(second.engine.listEvents(threadId).filter((event) => event.type === 'approval.rule_applied')).toHaveLength(1)
    })

    it('a request that is still pending after a restart offers it, and a message that denies it makes no rule', async () => {      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot(scripted(() => 'redirected'))
      expect(second.questions.listPendingForThread(threadId)[0]!.questions[0]!.options.find((option) => option.id === 'allow_always')).toEqual({ id: 'allow_always', label: 'Always for this thread', decision: 'allow', scope: 'always' })
      await second.orch.send('Use pnpm instead', false, { threadId, clientRequestId: 'message-1' })
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', decision: 'reject', decisionScope: null })
      expect(second.orch.listApprovalRules(threadId)).toEqual([])
    })
  })

  it('two requests of one dead run: the thread continues once, when every one is answered, with both decisions', async () => {
    const { threadId, requestIds } = await crashWhileAsking([BASH('npm test'), BASH('git push')])
    const adapter = scripted(() => 'ok')
    const second = boot(adapter)

    expect(second.questions.listPendingForThread(threadId).map((entry) => entry.approval)).toEqual([
      expect.objectContaining({ answerPath: 'continue', answered: 0, total: 2 }),
      expect.objectContaining({ answerPath: 'continue', answered: 0, total: 2 })
    ])
    expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toEqual({ ok: true, decision: 'allow' })
    // Nothing starts yet, the other card stays answerable and says "1 of 2".
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(second.engine.listRuns(threadId)).toHaveLength(1)
    expect(second.questions.listPendingForThread(threadId)).toEqual([expect.objectContaining({ requestId: requestIds[1], approval: expect.objectContaining({ answered: 1, total: 2 }) })])

    expect(second.questions.settle(requestIds[1]!, { permission: 'reject', feedback: 'do not push from here' }, USER)).toEqual({ ok: true, decision: 'reject' })
    await settled(second, threadId, 2)
    expect(second.engine.listRuns(threadId)).toHaveLength(2)
    expect(adapter.turns).toHaveLength(1)
    const note = seen(adapter).find((text) => text.includes('The user approved'))!
    expect(note).toContain('The user approved: Allow Claude Code to run a command (Bash)?')
    expect(note).toContain('npm test')
    expect(note).toContain('The user denied:')
    expect(note).toContain('git push')
    expect(note).toContain('Reason: do not push from here')
    for (const id of requestIds) expect(second.engine.approvals.get(id)).toMatchObject({ continuationRunId: asc(second.engine.listRuns(threadId))[1]!.runId, deliveredAt: expect.any(String) })
  })

  it('a run a crash left uncertain continues with the acknowledgement and says the tool may already have run', async () => {
    const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm run deploy')], { startedTools: ['Bash'] })
    const adapter = scripted(() => 'checked')
    const second = boot(adapter)

    expect(second.boot.uncertain).toEqual([runId])
    expect(second.boot.approvals.continued).toEqual(requestIds)
    expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ uncertain: true, uncertainTools: ['Bash'] })
    expect(second.questions.listPendingForThread(threadId)[0]!.approval).toMatchObject({ uncertain: true, uncertainTools: ['Bash'] })

    expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
    await settled(second, threadId, 2)
    // Without the acknowledgement the engine would have refused this continuation.
    expect(second.engine.getRun(runId)!.status).toBe('uncertain')
    expect(asc(second.engine.listRuns(threadId))[1]).toMatchObject({ status: 'completed', outcome: { continuationOf: runId } })
    expect(seen(adapter).some((text) => text.includes('check whether it already ran') && text.includes('Bash'))).toBe(true)
  })

  describe('a message sent while approvals wait denies them with the message as the reason', () => {
    it('one request, and several: exactly one run starts, no generic continuation, and the agent is told', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test'), BASH('git push')])
      const adapter = scripted(() => 'redirected')
      const second = boot(adapter)

      await second.orch.send('Use pnpm instead', false, { threadId, clientRequestId: 'message-1' })
      const runs = asc(second.engine.listRuns(threadId))
      expect(runs).toHaveLength(2)
      expect(runs[1]).toMatchObject({ clientRequestId: 'message-1', status: 'completed' })
      expect(runs[1]!.outcome?.continuationOf).toBeUndefined()
      expect(second.engine.store.getReceipt(`approval-run:${runId}`)).toBeNull()
      for (const id of requestIds)
        expect(second.engine.approvals.get(id)).toMatchObject({ status: 'answered', decision: 'reject', feedback: 'Use pnpm instead', continuationRunId: runs[1]!.runId, deliveredAt: expect.any(String), answeredBy: { kind: 'user' } })
      expect(adapter.turns).toHaveLength(1)
      const note = seen(adapter).find((text) => text.includes('The user denied'))!
      expect(note).toContain('Reason: Use pnpm instead')
      expect(second.questions.listPendingForThread(threadId)).toEqual([])

      // Another restart finds nothing undelivered and starts no extra continuation.
      await second.crash()
      const third = boot(scripted(() => 'again'), 3)
      expect(third.boot.approvals).toEqual({ continued: [], cancelled: [], undelivered: [] })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(third.engine.listRuns(threadId)).toHaveLength(2)
    })

    it('the restart note\'s Continue is a send too: it denies that run\'s requests without a message as the reason', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const adapter = scripted(() => 'continuing')
      const second = boot(adapter)
      await second.orch.send('Continue where you left off.', false, { threadId, clientRequestId: `continue:${runId}`, continuationOfRunId: runId })
      expect(second.engine.listRuns(threadId)).toHaveLength(2)
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', decision: 'reject', feedback: null, continuationRunId: asc(second.engine.listRuns(threadId))[1]!.runId })
      expect(seen(adapter).some((text) => text.includes('The user denied'))).toBe(true)
    })

    it('a partly answered group: A approved, then a message denies B; one run carries both, A\'s grant is scoped to it, nothing is left undelivered', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test'), BASH('git push')])
      let second!: Phase6Daemon
      const asked: boolean[] = []
      const adapter = scripted(async (input) => {
        const before = second.engine.approvals.listPending(input.threadId).length
        const waiting = second.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
        asked.push(second.engine.approvals.listPending(input.threadId).length > before)
        second.questions.dismissAllForThread(input.threadId)
        await waiting.catch(() => undefined)
        return 'ok'
      })
      second = boot(adapter)
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(second.engine.listRuns(threadId)).toHaveLength(1)
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', deliveredAt: null })

      await second.orch.send('Skip the push', false, { threadId, clientRequestId: 'message-1' })
      const runs = asc(second.engine.listRuns(threadId))
      expect(runs).toHaveLength(2)
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ decision: 'allow', continuationRunId: runs[1]!.runId, grantConsumedAt: expect.any(String) })
      expect(second.engine.approvals.get(requestIds[1]!)).toMatchObject({ decision: 'reject', feedback: 'Skip the push', continuationRunId: runs[1]!.runId })
      expect(asked).toEqual([false])
      expect(second.engine.approvals.listUndelivered()).toEqual([])
      const note = seen(adapter).find((text) => text.includes('The user approved'))!
      expect(note).toContain('npm test')
      expect(note).toContain('The user denied')
      await second.crash()
      const third = boot(scripted(() => 'again'), 3)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(third.engine.listRuns(threadId)).toHaveLength(2)
    })

    it('a failure inside the combined operation leaves A answered and B pending with no run', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test'), BASH('git push')])
      const second = boot()
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
      vi.spyOn(second.engine.approvals, 'bindDelivery').mockImplementationOnce(() => { throw new Error('crash before commit') })
      await expect(second.orch.send('Skip the push', false, { threadId, clientRequestId: 'message-1' })).rejects.toBeTruthy()
      expect(second.engine.listRuns(threadId)).toHaveLength(1)
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', decision: 'allow', deliveredAt: null })
      expect(second.engine.approvals.get(requestIds[1]!)).toMatchObject({ status: 'pending', decision: null })
      expect(second.engine.store.getReceipt('message-1')).toBeNull()
    })

    it('a sender that may not answer leaves the group untouched', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      await second.orch.send('Redirect', false, {
        threadId,
        clientRequestId: 'message-1',
        actor: { kind: 'agent', threadId: 'someone-else', runId: 'run-x', permissionMode: 'full' }
      })
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'pending', decision: null })
      expect(second.questions.listPendingForThread(threadId)).toHaveLength(1)
    })
  })

  it('a clean shutdown while a turn waits for the user: the turn is cut off by the restart and the next boot offers the request', async () => {
    let first!: Phase6Daemon
    const adapter = scripted(async (input) => {
      await first.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) }).catch(() => undefined)
      return 'never delivered'
    })
    first = phase6Daemon(home!, [adapter], { pid: 1 })
    const thread = first.store.createThread('Shutdown')
    first.orch.setThreadModelOverride(thread.id, PI)
    const sent = await first.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', awaitMode: 'ack' })
    await waitFor(() => first.questions.listPendingForThread(thread.id).length === 1, 'the turn to ask')
    const requestId = first.questions.listPendingForThread(thread.id)[0]!.requestId
    await first.shutdown()

    const second = boot()
    expect(second.engine.getRun(sent.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart' } })
    expect(second.boot.approvals.continued).toEqual([requestId])
    expect(second.engine.approvals.get(requestId)).toMatchObject({ status: 'pending', answerPath: 'continue', runId: sent.runId })
    expect(second.questions.listPendingForThread(thread.id)[0]).toMatchObject({ requestId, approval: { answerPath: 'continue' } })
  })

  describe('council round 1', () => {
    it.each(['Claude', 'Codex'] as const)('a clean shutdown keeps a request tied to the turn\'s stop handling (%s shaped)', async (shape) => {
      let first!: Phase6Daemon
      const adapter = scripted(async (input) => {
        // Claude's turn dismisses its thread's requests when it is cancelled; Codex binds each request to the run's signal.
        if (shape === 'Claude') input.signal.addEventListener('abort', () => first.questions.dismissAllForThread(input.threadId), { once: true })
        await first.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }), ...(shape === 'Codex' ? { signal: input.signal } : {}) }).catch(() => undefined)
        return 'never delivered'
      })
      first = phase6Daemon(home!, [adapter], { pid: 1 })
      const thread = first.store.createThread('Shutdown')
      first.orch.setThreadModelOverride(thread.id, PI)
      const sent = await first.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', awaitMode: 'ack' })
      await waitFor(() => first.questions.listPendingForThread(thread.id).length === 1, 'the turn to ask')
      const requestId = first.questions.listPendingForThread(thread.id)[0]!.requestId
      await first.shutdown()

      const second = boot()
      // The turn's stop handling ran, and it withdrew nothing.
      expect(second.engine.listEvents(thread.id).some((event) => event.type === 'approval.cancelled')).toBe(false)
      expect(second.engine.getRun(sent.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart' } })
      expect(second.boot.approvals.continued).toEqual([requestId])
      expect(second.engine.approvals.get(requestId)).toMatchObject({ status: 'pending', answerPath: 'continue' })
    })

    it('a provider dismissal after the profile stopped leaves a saved request alone, but a Stop of a running profile still closes it', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      second.questions.shutdown()
      expect(second.questions.dismiss(requestIds[0]!)).toBe(false)
      second.questions.dismissAllForThread(threadId)
      expect(second.engine.approvals.get(requestIds[0]!)!.status).toBe('pending')
    })

    it('a Stop retires an answer nobody delivered and spends its grant: the next boot starts nothing', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // The continuation fails to be admitted: the answer is recorded and undelivered.
      // The attach-time resume has looked at the (still pending) request; now the continuation fails to be admitted.
      await new Promise((resolve) => setTimeout(resolve, 50))
      vi.spyOn(second.engine.approvals, 'bindDelivery').mockImplementationOnce(() => { throw new Error('admission failed') })
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', decision: 'allow', deliveredAt: null })
      expect(second.engine.listRuns(threadId)).toHaveLength(1)

      await second.orch.stopThread(threadId, 'user', { clearQueue: true })
      // The decision stays for audit; nothing is armed any more.
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', decision: 'allow', deliveredAt: expect.any(String), grantConsumedAt: expect.any(String) })
      expect(second.engine.approvals.listUndelivered()).toEqual([])
      expect(second.engine.listEvents(threadId).some((event) => event.type === 'approval.retired')).toBe(true)
      await second.crash()

      const adapter = scripted(() => 'must not run')
      const third = boot(adapter, 3)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(third.engine.listRuns(threadId)).toHaveLength(1)
      expect(adapter.turns).toEqual([])
    })

    it('a scheduled prompt queued behind a recovered approval stays queued through the startup drain, and runs once nothing waits', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const adapter = scripted(() => 'ok')
      const second = boot(adapter)
      const queued = await second.orch.send('check the build', false, { threadId, clientRequestId: 'job-1', source: 'schedule', origin: 'schedule', preemptQuestions: false, queueOrigin: { kind: 'schedule', jobId: 'job', occurrenceKey: 'k1' } })
      expect(queued.queued).toBe(true)

      second.orch.recoverAndDrainPendingQueues()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(adapter.turns).toEqual([])
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'pending', decision: null })
      // Still the same non-preempting item, waiting.
      expect(second.orch.listQueue(threadId)).toEqual([expect.objectContaining({ content: 'check the build', origin: expect.objectContaining({ kind: 'schedule' }) })])

      // The user answers: the continuation runs first, then the scheduled prompt.
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
      await waitFor(() => adapter.turns.some((turn) => turn.prompt === 'check the build'), 'the scheduled prompt to run')
      expect(adapter.turns.map((turn) => turn.prompt)[0]).toBe('Continue where you left off.')
    })

    it('an answer committed before a crash does not continue an uncertain run behind the user\'s back: the thread says so, and Continue delivers it', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm run deploy')], { startedTools: ['Bash'], answerBeforeCrash: true })
      const adapter = scripted(() => 'checked')
      const second = boot(adapter)
      expect(second.boot.uncertain).toEqual([runId])
      expect(second.boot.approvals.undelivered).toEqual(requestIds)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(second.engine.listRuns(threadId)).toHaveLength(1)
      expect(adapter.turns).toEqual([])
      expect(second.orch.getMessages(threadId).some((message) => message.role === 'system' && message.content.includes('may already have run') && message.content.includes('Bash'))).toBe(true)

      await second.orch.send('Continue where you left off.', false, { threadId, clientRequestId: `continue:${runId}`, continuationOfRunId: runId, acknowledgeUncertain: true })
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ continuationRunId: asc(second.engine.listRuns(threadId))[1]!.runId })
      expect(seen(adapter).some((text) => text.includes('The user approved'))).toBe(true)
    })

    it('an unattended run\'s request keeps its timeout across a restart: boot closes it instead of leaving a scheduled thread waiting for ever', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('make')], { origin: 'schedule' })
      const second = boot()
      expect(second.boot.approvals).toEqual({ continued: [], cancelled: requestIds, undelivered: [] })
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'cancelled', cancelReason: 'timed_out' })
      expect(second.questions.listPendingForThread(threadId)).toEqual([])
      // Nothing holds the thread: a scheduled prompt runs.
      const result = await second.orch.send('check the build', false, { threadId, clientRequestId: 'job-1', source: 'schedule', origin: 'schedule', preemptQuestions: false })
      expect(result.queued).toBeUndefined()
    })

    it('an agent\'s answer never starts a restart continuation: that is the user\'s click', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const adapter = scripted(() => 'ok')
      const second = boot(adapter)
      second.engine.delegations.createLineage({ threadId, parentThreadId: 'parent-thread', parentRunId: 'run-parent', relationship: 'subagent' })
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, { kind: 'agent', threadId: 'parent-thread', runId: 'run-parent', permissionMode: 'full' })).toMatchObject({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(second.engine.listRuns(threadId)).toHaveLength(1)
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'answered', answeredBy: { kind: 'agent' }, deliveredAt: null })
      // Nor does a later boot.
      await second.crash()
      const third = boot(adapter, 3)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(third.engine.listRuns(threadId)).toHaveLength(1)
      expect(adapter.turns).toEqual([])
      // The user's Continue delivers the agent's answer.
      await third.orch.send('Continue where you left off.', false, { threadId, clientRequestId: `continue:${runId}`, continuationOfRunId: runId })
      expect(third.engine.approvals.get(requestIds[0]!)!.continuationRunId).toBe(asc(third.engine.listRuns(threadId))[1]!.runId)
    })

    it('the continuation is a run of the user\'s own client, so a subagent\'s parent hears its result', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, { kind: 'user', via: 'cli' })
      await settled(second, threadId, 2)
      expect(asc(second.engine.listRuns(threadId))[1]).toMatchObject({ source: 'cli', clientRequestId: `approval-run:${runId}` })
    })

    it('a continuation that would deliver nothing is refused, not run; a refused one is surfaced', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
      await settled(second, threadId, 2)
      await expect(second.orch.send('Continue where you left off.', false, {
        threadId, clientRequestId: 'approval-run:duplicate', continuationOfRunId: runId, bindDelivery: { requestIds }, source: 'gui'
      })).rejects.toMatchObject({ code: 'approvals_already_delivered' })
      expect(second.engine.listRuns(threadId)).toHaveLength(2)
      expect(second.engine.store.getReceipt('approval-run:duplicate')).toBeNull()
    })

    it('a refusal that leaves an answer with no card and no turn is told to the thread', async () => {
      const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.spyOn(second.orch, 'send').mockRejectedValueOnce(Object.assign(new Error('Cannot continue run'), { code: 'continuation_source_active' }))
      second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)
      await waitFor(() => second.orch.getMessages(threadId).some((message) => message.role === 'system' && message.content.includes('could not continue the thread')), 'the notice')
    })

  })

  it('a Stop closes the requests a restart left, and an answer afterwards learns it', async () => {
    const { threadId, requestIds } = await crashWhileAsking([BASH('npm test')])
    const second = boot()
    await second.orch.stopThread(threadId, 'user')
    expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ status: 'cancelled', cancelReason: 'stopped' })
    expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toEqual({ ok: false, reason: 'cancelled', cancelReason: 'stopped' })
    expect(second.questions.listPendingForThread(threadId)).toEqual([])
    expect(second.engine.listRuns(threadId)).toHaveLength(1)
  })

  describe('crash injection: an answer is never lost', () => {
    it('after the settle transaction and before the live executor: one continuation after the next boot', async () => {
      const first = phase6Daemon(home!, [scripted(() => 'unused')], { pid: 1 })
      const thread = first.store.createThread('Crash')
      first.orch.setThreadModelOverride(thread.id, PI)
      const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      first.engine.markStarting(sent.runId)
      bindRun(first, first.engine.markRunning(sent.runId))
      const waiter = first.questions.requestAnswers(prompt(), thread.id, { approval: tag({ tool: BASH('npm test') }) })
      waiter.catch(() => undefined)
      const requestId = first.questions.listPendingForThread(thread.id)[0]!.requestId
      // The executor never runs: the worker is gone when the answer is committed.
      await first.worker.stop()
      expect(first.questions.settle(requestId, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      expect(first.engine.outbox.listForThread(thread.id).map((effect) => [effect.kind, effect.status])).toEqual([['request.respond', 'pending']])
      await first.crash()
      first.questions.markInterruptedByDaemonRestart()

      let second!: Phase6Daemon
      const adapter = scripted(async (input) => {
        const before = second.engine.approvals.listPending(input.threadId).length
        const waiting = second.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
        const wasAsked = second.engine.approvals.listPending(input.threadId).length > before
        second.questions.dismissAllForThread(input.threadId)
        await waiting.catch(() => undefined)
        return wasAsked ? 'asked' : 'granted'
      })
      second = boot(adapter)
      expect(second.boot.approvals.undelivered).toEqual([requestId])
      await settled(second, thread.id, 2)
      expect(second.engine.listRuns(thread.id)).toHaveLength(2)
      expect(asc(second.engine.listRuns(thread.id))[1]).toMatchObject({ clientRequestId: `approval-run:${sent.runId}`, outcome: { continuationOf: sent.runId } })
      expect(second.engine.approvals.get(requestId)).toMatchObject({ decision: 'allow', grantConsumedAt: expect.any(String), deliveredAt: expect.any(String) })
      expect(second.orch.getMessages(thread.id).some((message) => message.content === 'granted')).toBe(true)

      // A later boot adds nothing: the continuation exists exactly once.
      await second.crash()
      const third = boot(scripted(() => 'again'), 3)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(third.engine.listRuns(thread.id)).toHaveLength(2)
      expect(third.engine.approvals.listUndelivered()).toEqual([])
    })

    it('after the continuation is admitted and before its first ask: the decision survives, one continuation, never a second automatic one', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking([BASH('npm test')])
      const second = boot()
      // The continuation is admitted, but its turn never starts: the daemon dies first.
      await second.worker.stop()
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, USER)).toMatchObject({ ok: true })
      await waitFor(() => second.engine.listRuns(threadId).length === 2, 'the continuation to be admitted')
      const continuation = asc(second.engine.listRuns(threadId))[1]!
      expect(continuation).toMatchObject({ clientRequestId: `approval-run:${runId}`, status: 'queued' })
      expect(second.engine.approvals.get(requestIds[0]!)).toMatchObject({ continuationRunId: continuation.runId, deliveredAt: expect.any(String), grantConsumedAt: null })
      await second.crash()

      let third!: Phase6Daemon
      const adapter = scripted(async (input) => {
        const before = third.engine.approvals.listPending(input.threadId).length
        const waiting = third.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
        const wasAsked = third.engine.approvals.listPending(input.threadId).length > before
        third.questions.dismissAllForThread(input.threadId)
        await waiting.catch(() => undefined)
        return wasAsked ? 'asked' : 'granted'
      })
      third = boot(adapter, 3)
      // The decision is not undelivered (the continuation owns it) and no second continuation is made.
      expect(third.boot.approvals.undelivered).toEqual([])
      expect(third.boot.strandedQueued).toEqual([continuation.runId])
      // The continuation that was already admitted starts again (reconciler rule 5), and its first ask
      // for the approved action is still granted: the decision was not lost.
      const reconciler = new Reconciler({ store: third.engine.store, outbox: third.engine.outbox, tools: third.engine.tools })
      expect(reconciler.runOnce().queuedStarts).toEqual([continuation.runId])
      await waitFor(() => third.engine.getRun(continuation.runId)!.status === 'completed', 'the admitted continuation to run')
      expect(third.orch.getMessages(threadId).some((message) => message.content === 'granted')).toBe(true)
      expect(third.engine.listRuns(threadId)).toHaveLength(2)
      expect(third.engine.approvals.get(requestIds[0]!)).toMatchObject({ decision: 'allow', continuationRunId: continuation.runId, grantConsumedAt: expect.any(String) })
    })
  })

  it('a live approval is answered through the worker: the turn goes on, the effect succeeds and the row is delivered', async () => {
    let daemon!: Phase6Daemon
    const adapter = scripted(async (input) => {
      const answers = await daemon.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
      return answers.permission === 'allow' ? 'ran it' : 'blocked'
    })
    daemon = boot(adapter, 1)
    const thread = daemon.store.createThread('Live')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    const sent = await daemon.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', awaitMode: 'ack' })
    await waitFor(() => daemon.questions.listPendingForThread(thread.id).length === 1, 'the turn to ask')
    const [pending] = daemon.questions.listPendingForThread(thread.id)
    expect(pending!.approval).toMatchObject({ answerPath: 'live' })

    expect(daemon.questions.settle(pending!.requestId, { permission: 'allow' }, { kind: 'user', via: 'bridge' })).toMatchObject({ ok: true })
    await waitFor(() => daemon.engine.getRun(sent.runId!)!.status === 'completed', 'the turn to finish')
    expect(daemon.orch.getMessages(thread.id).some((message) => message.content === 'ran it')).toBe(true)
    await waitFor(() => daemon.engine.outbox.listForThread(thread.id).some((effect) => effect.kind === 'request.respond' && effect.status === 'succeeded'), 'the request.respond effect to succeed')
    expect(daemon.engine.approvals.get(pending!.requestId)).toMatchObject({ status: 'answered', answeredBy: { kind: 'user', via: 'bridge' }, deliveredAt: expect.any(String), continuationRunId: null })
  })

  describe('scheduled runs keep their contract (they ask like any turn, time out, and never answer for the user)', () => {
    /** Runs one turn whose script asks for an approval, and reports whether the question service armed its ten-minute timer. */
    const timerArmed = async (origin: 'schedule' | undefined): Promise<boolean> => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      let daemon!: Phase6Daemon
      const adapter = scripted(async (input) => {
        const waiting = daemon.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) }).catch(() => undefined)
        const armed = setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10 * 60 * 1000)
        daemon.questions.dismissAllForThread(input.threadId)
        await waiting
        return armed ? 'armed' : 'unarmed'
      })
      daemon = boot(adapter, 1)
      const thread = daemon.store.createThread('Timer')
      daemon.orch.setThreadModelOverride(thread.id, PI)
      const response = await daemon.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', ...(origin ? { origin, source: origin } : {}) })
      setTimeoutSpy.mockRestore()
      return response.message === 'armed'
    }

    it('a scheduled turn\'s approval keeps the ten-minute timeout', async () => {
      expect(await timerArmed('schedule')).toBe(true)
    })

    it('a person\'s turn has no timeout', async () => {
      expect(await timerArmed(undefined)).toBe(false)
    })

    it('a scheduled send leaves a waiting approval alone and queues behind it', async () => {
      let daemon!: Phase6Daemon
      const adapter = scripted(async (input) => {
        if (input.prompt !== 'go') return `scheduled: ${input.prompt}`
        const answers = await daemon.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) })
        return answers.permission === 'allow' ? 'ran it' : 'blocked'
      })
      daemon = boot(adapter, 1)
      const thread = daemon.store.createThread('Scheduled')
      daemon.orch.setThreadModelOverride(thread.id, PI)
      await daemon.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', awaitMode: 'ack' })
      await waitFor(() => daemon.questions.listPendingForThread(thread.id).length === 1, 'the turn to ask')
      const requestId = daemon.questions.listPendingForThread(thread.id)[0]!.requestId

      const queued = await daemon.orch.send('check the build', false, { threadId: thread.id, clientRequestId: 'job-1', source: 'schedule', origin: 'schedule', preemptQuestions: false })
      expect(queued.queued).toBe(true)
      expect(daemon.engine.approvals.get(requestId)).toMatchObject({ status: 'pending', decision: null })
      expect(daemon.questions.listPendingForThread(thread.id)).toHaveLength(1)

      // The user answers; the turn ends and the queued scheduled prompt runs after it.
      daemon.questions.settle(requestId, { permission: 'allow' }, USER)
      await waitFor(() => adapter.turns.some((turn) => turn.prompt === 'check the build'), 'the scheduled prompt to run')
    })
  })

  it('a message during a live turn denies the request inside the send, aborts the turn and runs as a fresh turn', async () => {
    let daemon!: Phase6Daemon
    let calls = 0
    const adapter = scripted(async (input) => {
      calls += 1
      if (calls > 1) return `fresh: ${input.prompt}`
      const answers = await Promise.race([
        daemon.questions.requestAnswers(prompt(), input.threadId, { approval: tag({ tool: BASH('npm test') }) }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('never answered')), 20_000))
      ])
      return answers.permission === 'allow' ? 'ran it' : `blocked: ${String(answers.feedback)}`
    })
    daemon = boot(adapter, 1)
    const thread = daemon.store.createThread('Preempt')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    const first = await daemon.orch.send('go', false, { threadId: thread.id, clientRequestId: 'go-1', awaitMode: 'ack' })
    await waitFor(() => daemon.questions.listPendingForThread(thread.id).length === 1, 'the turn to ask')
    const requestId = daemon.questions.listPendingForThread(thread.id)[0]!.requestId

    const second = await daemon.orch.send('Use pnpm', false, { threadId: thread.id, clientRequestId: 'go-2' })
    expect(second.message).toBe('fresh: Use pnpm')
    expect(second.queued).toBeUndefined()
    expect(daemon.engine.approvals.get(requestId)).toMatchObject({ status: 'answered', decision: 'reject', feedback: 'Use pnpm', continuationRunId: second.runId })
    await waitFor(() => ['completed', 'interrupted', 'cancelled', 'failed'].includes(daemon.engine.getRun(first.runId!)!.status), 'the first turn to end')
    expect(daemon.engine.listRuns(thread.id)).toHaveLength(2)
    expect(daemon.questions.listPendingForThread(thread.id)).toEqual([])
  })
})
