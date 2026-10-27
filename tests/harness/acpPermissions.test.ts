/**
 * Permission requests of ACP agents: options keep their identity and scope, only the agent's
 * once-only options are shown (a native "always" would outlive the thread's mode), a stopped turn
 * answers `cancelled`, and the thread's permission mode decides what is answered without asking.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import {
  answerPermission,
  classifyGenericOption,
  keepOption,
  questionsPrompter,
  writeWorkspaceFile,
  type AcpRequestScope,
  type PermissionPrompter
} from '../../src/mms/harness/acp/permissions'

const options: RequestPermissionRequest['options'] = [
  { optionId: 'once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
]
const request = (kind?: NonNullable<RequestPermissionRequest['toolCall']['kind']>): RequestPermissionRequest => ({
  sessionId: 's',
  toolCall: { toolCallId: 'c', title: 'Run npm test', ...(kind ? { kind } : {}) },
  options
})

function scope(permissionMode: PermissionMode | undefined = 'ask', aborted = false, cwd = '/w'): AcpRequestScope {
  return { threadId: 'thread', cwd, permissionMode, aborted: () => aborted, throwIfAborted: () => {} }
}

function prompter(answer: string | undefined): PermissionPrompter & { choose: ReturnType<typeof vi.fn> } {
  return { choose: vi.fn(async () => answer) }
}

const classify = { label: 'Agent', classify: classifyGenericOption }
const cancelled = { outcome: { outcome: 'cancelled' } }
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } })

describe('ACP permission options', () => {
  it('classifies scopes and says that "always" may outlive the session', () => {
    expect(options.map(classifyGenericOption)).toEqual([
      { optionId: 'once', kind: 'allow_once', label: 'Allow', scope: 'once' },
      { optionId: 'always', kind: 'allow_always', label: 'Always allow (the agent may remember this beyond this session)', scope: 'persistent' },
      { optionId: 'no', kind: 'reject_once', label: 'Reject', scope: 'once' },
      { optionId: 'never', kind: 'reject_always', label: 'Always reject', scope: 'persistent' }
    ])
    expect(keepOption(options[1]!).label).toBe('Always allow')
  })

  it('shows only the once-only options: a native "always" or "session" option is never offered', async () => {
    const ask = prompter('once')
    expect(await answerPermission(ask, scope(), request(), classify)).toEqual(selected('once'))
    expect(ask.choose.mock.calls[0][0]).toMatchObject({ threadId: 'thread', title: 'Run npm test' })
    expect(ask.choose.mock.calls[0][0].options.map((option: { optionId: string }) => option.optionId)).toEqual(['once', 'no'])
    // A preset that keeps the agent's own labels hides them too.
    const kept = prompter('once')
    await answerPermission(kept, scope(), request(), { label: 'Agent', classify: keepOption })
    expect(kept.choose.mock.calls[0][0].options.map((option: { optionId: string }) => option.optionId)).toEqual(['once', 'no'])
  })

  it('cancels an answer outside the shown options, a stopped turn, and an agent that offers only "always"', async () => {
    expect(await answerPermission(prompter('always'), scope(), request(), classify)).toEqual(cancelled)
    const ask = prompter('once')
    expect(await answerPermission(ask, scope('ask', true), request(), classify)).toEqual(cancelled)
    expect(ask.choose).not.toHaveBeenCalled()
    const alwaysOnly = { ...request(), options: options.filter((option) => option.kind.endsWith('always')) }
    expect(await answerPermission(ask, scope('full'), alwaysOnly, classify)).toEqual(cancelled)
  })

  it('answers cancelled when the turn stops while the user decides', async () => {
    let stopped = false
    const ask: PermissionPrompter = { choose: async () => { stopped = true; return 'once' } }
    const live: AcpRequestScope = { ...scope(), aborted: () => stopped }
    expect(await answerPermission(ask, live, request(), classify)).toEqual(cancelled)
  })
})

describe('ACP permission requests under a permission mode', () => {
  it('asks for everything under Ask', async () => {
    for (const kind of ['edit', 'execute', 'read'] as const) {
      const ask = prompter('no')
      expect(await answerPermission(ask, scope('ask'), request(kind), classify)).toEqual(selected('no'))
      expect(ask.choose).toHaveBeenCalledTimes(1)
    }
  })

  it('answers a file change with the once-only allow under Auto-accept edits, and asks for anything else', async () => {
    for (const kind of ['edit', 'delete', 'move'] as const) {
      const ask = prompter('no')
      expect(await answerPermission(ask, scope('accept_edits'), request(kind), classify)).toEqual(selected('once'))
      expect(ask.choose).not.toHaveBeenCalled()
    }
    const ask = prompter('no')
    expect(await answerPermission(ask, scope('accept_edits'), request('execute'), classify)).toEqual(selected('no'))
    expect(ask.choose).toHaveBeenCalledTimes(1)
  })

  it('answers every request with the once-only allow under Full access, without a prompt, turn after turn', async () => {
    const ask = prompter('no')
    for (const kind of ['execute', 'edit', 'fetch', undefined] as const) {
      expect(await answerPermission(ask, scope('full'), request(kind), classify)).toEqual(selected('once'))
    }
    expect(ask.choose).not.toHaveBeenCalled()
  })

  it('asks when a request arrives outside a turn', async () => {
    const ask = prompter('no')
    expect(await answerPermission(ask, scope(undefined), request('edit'), classify)).toEqual(selected('no'))
    expect(ask.choose).toHaveBeenCalledTimes(1)
  })

  it('tells the prompter what kind of action is asked about, so who may answer is decided by the rule', async () => {
    const ask = prompter('once')
    await answerPermission(ask, scope('ask'), request('execute'), classify)
    // The agent's own description of the call travels with it: it is what a saved request is fingerprinted by.
    expect(ask.choose.mock.calls[0][0].approval).toMatchObject({ action: 'command', permissionKey: 'acp:execute', tool: { name: 'execute' } })
    const questions = new UserQuestionService()
    questions.setLineageSource(() => null)
    const waiter = questionsPrompter(questions).choose({ threadId: 'thread', title: 'Edit?', options: options.map(classifyGenericOption).filter((option) => option.scope === 'once'), approval: { action: 'edit', permissionKey: 'acp:edit' } })
    const requestId = questions.listPendingForThread('thread')[0]!.requestId
    // The agent's own option ids are mapped to what they mean.
    expect(questions.settle(requestId, { permission: 'once' }, { kind: 'user' })).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toBe('once')
  })
})

describe('ACP "Always for this thread" is Mousse\'s own rule, never the agent\'s', () => {
  const homes: string[] = []
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

  /** A question service bound to a Run Engine that runs each of `threads`; `state.permissionMode` is what their runs are bound to. */
  async function bound(threads: string[] = ['thread']) {
    const profileHome = mkdtempSync(join(tmpdir(), 'mousse-acp-always-'))
    homes.push(profileHome)
    const db = new ProfileDatabase({ profileHome })
    const store = new RunStore(db)
    const engine = new RunEngine({ store, pid: 1, outbox: new EffectOutbox(store) })
    engine.reconcileOnBoot()
    const state: { permissionMode: PermissionMode } = { permissionMode: 'ask' }
    const questions = new UserQuestionService()
    questions.setApprovalStore({
      store: engine.approvals,
      context: (threadId) => {
        const run = engine.getActiveRun(threadId)
        return run ? { runId: run.runId, instanceId: 'acp:agent', provider: 'acp', origin: 'interactive', permissionMode: state.permissionMode, approvals: 'ask' } : null
      },
      effectDelivery: () => false,
      continuationDue: () => undefined
    })
    for (const threadId of threads) {
      const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId: `run-${threadId}`, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      engine.markStarting(sent.runId)
      engine.markRunning(sent.runId)
    }
    const asked: Array<{ threadId: string; options: string[] }> = []
    let answer = (_options: string[]): string => 'allow_always'
    questions.on('pending', (event: { requestId: string; threadId: string; questions: Array<{ options: Array<{ id: string }> }> }) => {
      const ids = event.questions[0]!.options.map((option) => option.id)
      asked.push({ threadId: event.threadId, options: ids })
      questions.submitAnswers(event.requestId, { permission: answer(ids) }, { kind: 'user' })
    })
    return { engine, questions, state, asked, db, answerWith: (next: (options: string[]) => string) => { answer = next } }
  }
  const execute = (rawInput?: unknown): RequestPermissionRequest => ({
    sessionId: 's',
    toolCall: { toolCallId: 'c', title: 'Run a command', kind: 'execute', ...(rawInput === undefined ? {} : { rawInput }) },
    options
  })
  const forThread = (threadId: string, permissionMode: PermissionMode = 'ask'): AcpRequestScope => ({ ...scope(permissionMode), threadId })

  it('answers the agent with its own once-only option, records the rule, and answers the same request later without a prompt', async () => {
    const { questions, asked, engine, db } = await bound()
    try {
      const prompter = questionsPrompter(questions)
      const first = await answerPermission(prompter, forThread('thread'), execute({ command: 'npm test' }), classify)
      // The agent only ever hears its own once-only allow.
      expect(first).toEqual(selected('once'))
      // The card showed the agent's once-only options and Mousse's own "always"; the agent's native always/never are not there.
      expect(asked).toEqual([{ threadId: 'thread', options: ['once', 'allow_always', 'no'] }])
      expect(engine.approvals.listRules('thread')).toEqual([expect.objectContaining({ permissionKey: 'acp:execute', action: 'command', grantedUnder: 'ask' })])

      expect(await answerPermission(prompter, forThread('thread'), execute({ command: 'npm test' }), classify)).toEqual(selected('once'))
      expect(asked).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('never widens to another command, another argument, or an agent that gives no description of the call', async () => {
    const { questions, asked, db } = await bound()
    try {
      const prompter = questionsPrompter(questions)
      await answerPermission(prompter, forThread('thread'), execute({ command: 'npm test' }), classify)
      expect(asked).toHaveLength(1)
      // Declining from here on, so each of these is seen to be asked.
      questions.removeAllListeners('pending')
      const seen: string[][] = []
      questions.on('pending', (event: { requestId: string; questions: Array<{ options: Array<{ id: string }> }> }) => {
        seen.push(event.questions[0]!.options.map((option) => option.id))
        questions.submitAnswers(event.requestId, { permission: 'no' }, { kind: 'user' })
      })
      for (const rawInput of [{ command: 'npm test --watch' }, { command: 'npm test', cwd: '/elsewhere' }, { command: 'npm  test' }, { cmd: 'npm test' }])
        expect(await answerPermission(prompter, forThread('thread'), execute(rawInput), classify), JSON.stringify(rawInput)).toEqual(selected('no'))
      expect(seen).toHaveLength(4)
      // No description of the call, no fingerprint: asked every time and "always" is not offered.
      for (let times = 0; times < 2; times += 1) await answerPermission(prompter, forThread('thread'), execute(), classify)
      expect(seen.slice(4)).toEqual([['once', 'no'], ['once', 'no']])
    } finally {
      db.close()
    }
  })

  it('does not carry over to another thread on the same agent, and stops answering once the thread asks about more', async () => {
    const { questions, asked, state, engine, db } = await bound(['thread', 'other'])
    try {
      const prompter = questionsPrompter(questions)
      state.permissionMode = 'accept_edits'
      await answerPermission(prompter, forThread('thread', 'accept_edits'), execute({ command: 'npm test' }), classify)
      expect(engine.approvals.listRules('thread')[0]!.grantedUnder).toBe('accept_edits')
      expect(asked).toHaveLength(1)
      // The same agent in another thread asks.
      await answerPermission(prompter, forThread('other', 'accept_edits'), execute({ command: 'npm test' }), classify)
      expect(asked.map((entry) => entry.threadId)).toEqual(['thread', 'other'])
      // Same thread, same request: answered by the rule.
      await answerPermission(prompter, forThread('thread', 'accept_edits'), execute({ command: 'npm test' }), classify)
      expect(asked).toHaveLength(2)
      // The thread now asks about more than when it was granted: the next request asks.
      state.permissionMode = 'ask'
      await answerPermission(prompter, forThread('thread', 'ask'), execute({ command: 'npm test' }), classify)
      expect(asked.map((entry) => entry.threadId)).toEqual(['thread', 'other', 'thread'])
    } finally {
      db.close()
    }
  })

  it('a simulated agent that remembers a native "allow always" is never offered one', async () => {
    const { questions, asked, db, answerWith } = await bound()
    try {
      // The user would take any "always" they are offered: only Mousse's own is there.
      answerWith((offered) => offered.find((id) => /always/i.test(id)) ?? 'no')
      const nativeAlways = { ...execute({ command: 'ls' }), options: [...options, { optionId: 'allow_always_session', name: 'Allow for the session', kind: 'allow_always' as const }] }
      const result = await answerPermission(questionsPrompter(questions), forThread('thread'), nativeAlways, classify)
      expect(result).toEqual(selected('once'))
      expect(asked[0]!.options).toEqual(['once', 'allow_always', 'no'])
    } finally {
      db.close()
    }
  })
})

describe('ACP client file writes', () => {
  const writeFrom = (mode: PermissionMode | undefined, answer?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-acp-write-'))
    const questions = new UserQuestionService()
    const asked: string[] = []
    questions.on('pending', (event: { requestId: string; questions: Array<{ prompt: string }> }) => {
      asked.push(event.questions[0]!.prompt)
      if (answer) questions.submitAnswers(event.requestId, { write: answer }, { kind: 'user' })
    })
    const done = writeWorkspaceFile(questions, scope(mode, false, dir), { sessionId: 's', path: join(dir, 'a.txt'), content: 'hello' }, 'Agent')
    return { dir, asked, done }
  }

  it('skips the prompt under Auto-accept edits and Full access', async () => {
    for (const mode of ['accept_edits', 'full'] as const) {
      const { dir, asked, done } = writeFrom(mode)
      await done
      expect(asked).toEqual([])
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks under Ask, and writes only when the user allows it', async () => {
    const allowed = writeFrom('ask', 'allow')
    await allowed.done
    expect(allowed.asked).toHaveLength(1)
    expect(readFileSync(join(allowed.dir, 'a.txt'), 'utf8')).toBe('hello')
    const rejected = writeFrom('ask', 'reject')
    await expect(rejected.done).rejects.toThrow('rejected')
    rmSync(allowed.dir, { recursive: true, force: true })
    rmSync(rejected.dir, { recursive: true, force: true })
  })
})
