import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandHelp, ROOT_HELP } from '../src/cli/help'
import { parseArgs } from '../src/cli/parseArgs'
import {
  answerApproval,
  describeAnswerResult,
  describeApproval,
  handleApprovalCommand,
  listPendingApprovals,
  type AnswerResult,
  type PendingApproval
} from '../src/cli/interactive/approvals'
import { APPROVALS_HELP, runApprovals } from '../src/cli/commands/approvals'
import { openMms } from '../src/cli/mmsContext'

vi.mock('../src/cli/mmsContext', () => ({ openMms: vi.fn(), closeMmsContext: vi.fn(async () => undefined) }))

const options = [
  { id: 'allow', label: 'Allow once', decision: 'allow' as const, scope: 'once' as const },
  { id: 'reject', label: 'Reject', decision: 'reject' as const }
]
const request = (requestId: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId,
  threadId: 'thread-1234567890',
  questions: [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test', options }],
  approval: { answerPath: 'live' },
  ...extra
})

const withAlways = [
  options[0]!,
  { id: 'allow_always', label: 'Always for this thread', decision: 'allow' as const, scope: 'always' as const },
  options[1]!
]
const alwaysRequest = (requestId: string, extra: Partial<PendingApproval> = {}): PendingApproval =>
  request(requestId, { questions: [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test', options: withAlways }], ...extra })
const rule = (id: string, extra: Record<string, unknown> = {}) => ({ id, permissionKey: 'claude:command', action: 'command', summary: 'Allow Claude Code to run a command (Bash)? {"command":"npm test"}', grantedUnder: 'accept_edits', active: true, createdAt: '2026-10-27T00:00:00.000Z', ...extra })

/** A daemon that answers like the real one: the first answer wins, the second learns who did. */
function fakeDaemon(pending: PendingApproval[], rules: Array<ReturnType<typeof rule>> = []) {
  const settled = new Map<string, { decision: string; via: string }>()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      if (method === 'threads.approvalRules') return { threadId: params.threadId, rules } as T
      if (method === 'threads.clearApprovalRules') {
        const gone = rules.filter((entry) => params.ruleId === undefined || entry.id === params.ruleId)
        for (const entry of gone) rules.splice(rules.indexOf(entry), 1)
        return { threadId: params.threadId, removed: gone.length, rules } as T
      }
      if (method === 'orchestrator.pendingQuestions')
        return { pending: pending.filter((entry) => !settled.has(entry.requestId) && (!params.threadId || entry.threadId === params.threadId)) } as T
      if (method === 'orchestrator.answerQuestions') {
        const requestId = String(params.requestId)
        const prior = settled.get(requestId)
        if (prior) return { ok: false, reason: 'already_answered', decision: prior.decision, answeredBy: { kind: 'user', via: prior.via } } as T
        const entry = pending.find((candidate) => candidate.requestId === requestId)
        if (!entry) return { ok: false } as T
        const chosen = (params.answers as Record<string, string>)[entry.questions[0]!.id]
        settled.set(requestId, { decision: entry.questions[0]!.options.find((option) => option.id === chosen)?.decision ?? 'reject', via: 'cli' })
        return { ok: true } as T
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  return { client, calls, settled, anotherClientAnswers: (requestId: string, decision: string) => settled.set(requestId, { decision, via: 'gui' }) }
}

describe('describing approval requests', () => {
  it('shows what is asked, the option ids, and why', () => {
    const lines = describeApproval(request('req-1', { approval: { answerPath: 'live', reason: 'Claude Code asks even in Full access: its own safety check.' } }))
    expect(lines[0]).toBe('Approval req-1 (thread thread-1)')
    expect(lines).toContain('  Allow Claude Code to run a command (Bash)?')
    expect(lines).toContain('  npm test')
    expect(lines).toContain('  Options: allow (Allow once), reject (Reject)')
    expect(lines).toContain('  Why: Claude Code asks even in Full access: its own safety check.')
    expect(lines.join('\n')).not.toContain('continues the thread')
  })

  it('says what answering does after a restart, which tools may have run, and how far through the group the user is', () => {
    const lines = describeApproval(request('req-2', { approval: { answerPath: 'continue', uncertain: true, uncertainTools: ['Bash'], answered: 1, total: 3 } })).join('\n')
    expect(lines).toContain('Bash may already have run. Answering continues the thread.')
    expect(lines).toContain('1 of 3 answered')
    expect(lines).toContain('Sending a message denies the pending approvals')
  })
})

describe('mousse approvals', () => {
  let out = ''
  let err = ''
  beforeEach(() => {
    out = ''
    err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  const run = async (daemon: ReturnType<typeof fakeDaemon>, argv: string[]) => {
    vi.mocked(openMms).mockResolvedValue({ homeDir: '', client: daemon.client as never })
    await runApprovals(parseArgs(argv))
  }

  it('is a command with its own help', () => {
    const parsed = parseArgs(['approvals', 'answer', 'req-1', 'allow', '--feedback', 'ok'])
    expect(parsed).toMatchObject({ command: 'approvals', subcommand: 'answer', positional: ['req-1', 'allow'] })
    expect(parsed.flags.get('feedback')).toBe('ok')
    expect(commandHelp('approvals')).toBe(APPROVALS_HELP)
    expect(ROOT_HELP).toContain('mousse-cli approvals')
    expect(ROOT_HELP).toContain('/approve')
  })

  it('lists the saved requests that wait, with option ids, and leaves plain questions out', async () => {
    const plain: PendingApproval = { requestId: 'plain', threadId: 'thread-1234567890', questions: [{ id: 'q', prompt: 'Which database?', options: [] }] }
    const daemon = fakeDaemon([request('req-1'), plain, request('req-other', { threadId: 'other' })])
    await run(daemon, ['approvals', '--thread', 'thread-1234567890'])
    expect(out).toContain('Approval req-1')
    expect(out).toContain('Options: allow (Allow once), reject (Reject)')
    expect(out).not.toContain('Which database')
    expect(out).not.toContain('req-other')
    expect(daemon.calls[0]).toEqual({ method: 'orchestrator.pendingQuestions', params: { threadId: 'thread-1234567890' } })

    out = ''
    await run(daemon, ['--mode', 'json', 'approvals'])
    expect(JSON.parse(out.trim().split('\n')[0]!)).toMatchObject({ requestId: 'req-1', approval: { answerPath: 'live' } })
    out = ''
    await run(fakeDaemon([]), ['approvals'])
    expect(out).toBe('No approvals are waiting.\n')
  })

  it('answers a request by option id, with the reason when given', async () => {
    const daemon = fakeDaemon([request('req-1'), request('req-2')])
    await run(daemon, ['approvals', 'answer', 'req-1', 'allow'])
    expect(out).toBe('Answered: allow\n')
    expect(daemon.calls.at(-1)).toEqual({ method: 'orchestrator.answerQuestions', params: { requestId: 'req-1', answers: { permission: 'allow' } } })
    await run(daemon, ['approvals', 'answer', 'req-2', 'reject', '--feedback', 'use pnpm'])
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-2', answers: { permission: 'reject', feedback: 'use pnpm' } })
  })

  it('answers with allow_always by its id, lists the option and what it means, and describes the thread\'s rules', async () => {
    const daemon = fakeDaemon([alwaysRequest('req-1')])
    await run(daemon, ['approvals'])
    expect(out).toContain('Options: allow (Allow once), allow_always (Always for this thread), reject (Reject)')
    expect(out).toContain('allows this exact request again, in this thread')
    await run(daemon, ['approvals', 'answer', 'req-1', 'allow_always'])
    expect(daemon.calls.at(-1)).toEqual({ method: 'orchestrator.answerQuestions', params: { requestId: 'req-1', answers: { permission: 'allow_always' } } })
    expect(out).toContain('Answered: allow_always')
  })

  it('lists a thread\'s rules and revokes one by the start of its id, or all of them', async () => {
    const one = 'a'.repeat(64)
    const two = 'a'.repeat(20) + 'b'.repeat(44)
    const three = 'c'.repeat(64)
    const daemon = fakeDaemon([], [rule(one), rule(two, { active: false }), rule(three, { grantedUnder: 'ask' })])
    await run(daemon, ['approvals', 'rules', 'thread-1'])
    expect(daemon.calls.at(-1)).toEqual({ method: 'threads.approvalRules', params: { threadId: 'thread-1' } })
    expect(out).toContain(`${'a'.repeat(12)}  Allow Claude Code to run a command (Bash)?`)
    expect(out).toContain('paused while this thread is stricter')
    await run(fakeDaemon([], []), ['approvals', 'rules', 'thread-1'])
    expect(out).toContain('No "always" rules on this thread.')

    out = ''
    // Too short, or fitting two rules: nothing is revoked.
    await expect(run(daemon, ['approvals', 'reset', 'thread-1', 'aaaa'])).rejects.toThrow('exit 1')
    expect(err).toContain('at least eight characters')
    await expect(run(daemon, ['approvals', 'reset', 'thread-1', 'a'.repeat(10)])).rejects.toThrow('exit 1')
    expect(err).toContain('More than one rule starts with')
    expect(daemon.calls.some((call) => call.method === 'threads.clearApprovalRules')).toBe(false)
    // One rule, by its id prefix: the daemon gets the whole id.
    await run(daemon, ['approvals', 'reset', 'thread-1', 'c'.repeat(8)])
    expect(daemon.calls.at(-1)).toEqual({ method: 'threads.clearApprovalRules', params: { threadId: 'thread-1', ruleId: three } })
    expect(out).toContain('Revoked 1 rule.')
    await run(daemon, ['approvals', 'reset', 'thread-1'])
    expect(daemon.calls.at(-1)).toEqual({ method: 'threads.clearApprovalRules', params: { threadId: 'thread-1' } })
    expect(out).toContain('Revoked 2 rules.')
    await expect(run(daemon, ['approvals', 'reset'])).rejects.toThrow('exit 1')
    expect(err).toContain('requires a thread id')
  })

  it('says who answered first when another client was quicker, and exits non-zero', async () => {
    const daemon = fakeDaemon([request('req-1')])
    daemon.anotherClientAnswers('req-1', 'allow')
    await expect(run(daemon, ['approvals', 'answer', 'req-1', 'reject'])).rejects.toThrow('exit 1')
    expect(err).toContain('Already answered: allow from gui.')
  })

  it('refuses an option the request does not have, and asks for both ids', async () => {
    const daemon = fakeDaemon([request('req-1')])
    await expect(run(daemon, ['approvals', 'answer', 'req-1', 'maybe'])).rejects.toThrow('exit 1')
    expect(err).toContain('not one of the request')
    expect(daemon.calls.some((call) => call.method === 'orchestrator.answerQuestions')).toBe(false)
    await expect(run(daemon, ['approvals', 'answer', 'req-1'])).rejects.toThrow('exit 1')
    expect(err).toContain('requires a request id and an option id')
  })
})

describe('interactive /approve and /deny', () => {
  it('approves the one request waiting on the thread, once, by the decision its option declares', async () => {
    const daemon = fakeDaemon([request('req-1')])
    await expect(handleApprovalCommand('/approve', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow')
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-1', answers: { permission: 'allow' } })
  })

  it('with several waiting, answers only the one named by its id, never "the latest"', async () => {
    const daemon = fakeDaemon([request('req-1'), request('req-2')])
    const reply = await handleApprovalCommand('/approve', daemon.client, 'thread-1234567890')
    expect(reply).toContain('2 approvals are waiting')
    expect(reply).toContain('req-1')
    expect(reply).toContain('req-2')
    expect(daemon.calls.some((call) => call.method === 'orchestrator.answerQuestions')).toBe(false)
    // A short or unknown id answers nothing either.
    await expect(handleApprovalCommand('/approve rq', daemon.client, 'thread-1234567890')).resolves.toContain('2 approvals are waiting')
    // The id picks the request; the rest of a denial is the reason.
    await expect(handleApprovalCommand('/approve req-2', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow')
    expect([...daemon.settled.keys()]).toEqual(['req-2'])
    await expect(handleApprovalCommand('/deny req-1 use pnpm', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: reject')
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-1', answers: { permission: 'reject', feedback: 'use pnpm' } })
  })

  it('/approve always allows the request for the thread by the option that declares it, and plain /approve still allows once', async () => {
    const daemon = fakeDaemon([alwaysRequest('req-1')])
    await expect(handleApprovalCommand('/approve always', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow_always')
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-1', answers: { permission: 'allow_always' } })
    expect(daemon.settled.get('req-1')).toMatchObject({ decision: 'allow' })

    const plain = fakeDaemon([alwaysRequest('req-2')])
    await expect(handleApprovalCommand('/approve', plain.client, 'thread-1234567890')).resolves.toBe('Answered: allow')
    expect(plain.calls.at(-1)!.params).toEqual({ requestId: 'req-2', answers: { permission: 'allow' } })
  })

  it('/approve always names its request like /approve does, and never answers "the latest"', async () => {
    const daemon = fakeDaemon([alwaysRequest('req-1'), alwaysRequest('req-2')])
    await expect(handleApprovalCommand('/approve always', daemon.client, 'thread-1234567890')).resolves.toContain('2 approvals are waiting')
    expect(daemon.settled.size).toBe(0)
    await expect(handleApprovalCommand('/approve always req-2', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow_always')
    expect([...daemon.settled.keys()]).toEqual(['req-2'])
  })

  it('/approve always on a request that does not offer it says so and answers nothing', async () => {
    const daemon = fakeDaemon([request('req-1')])
    await expect(handleApprovalCommand('/approve always', daemon.client, 'thread-1234567890')).resolves.toContain('no "always" option')
    expect(daemon.calls.some((call) => call.method === 'orchestrator.answerQuestions')).toBe(false)
    // A reason that merely starts with the word is not the keyword.
    await expect(handleApprovalCommand('/approve alwaysnot', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow')
    // "always" is not a way to deny.
    const denying = fakeDaemon([alwaysRequest('req-2')])
    await expect(handleApprovalCommand('/deny always', denying.client, 'thread-1234567890')).resolves.toBe('Answered: reject')
    expect(denying.calls.at(-1)!.params).toEqual({ requestId: 'req-2', answers: { permission: 'reject', feedback: 'always' } })
  })

  it('a prefix that fits more than one request is refused', async () => {
    const daemon = fakeDaemon([request('abcd-1'), request('abcd-2')])
    await expect(handleApprovalCommand('/approve abcd', daemon.client, 'thread-1234567890')).resolves.toContain('More than one')
    expect(daemon.settled.size).toBe(0)
  })

  it('denies with a reason for the agent', async () => {
    const daemon = fakeDaemon([request('req-1')])
    await expect(handleApprovalCommand('/deny use pnpm instead', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: reject')
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-1', answers: { permission: 'reject', feedback: 'use pnpm instead' } })
  })

  it('does not approve with an option that is no "allow once", and finds a reject by name when none is declared', async () => {
    const onlyAlways = request('req-1', { questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'always', label: 'Always', decision: 'allow', scope: 'always' }, { id: 'no', label: 'No thanks' }] }] })
    const daemon = fakeDaemon([onlyAlways])
    await expect(handleApprovalCommand('/approve', daemon.client, 'thread-1234567890')).resolves.toBe('This request has no option that allows it once.')
    await expect(handleApprovalCommand('/deny', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: no')
  })

  it('says so when nothing waits, or when another client answered first, and ignores other input', async () => {
    const empty = fakeDaemon([])
    await expect(handleApprovalCommand('/approve', empty.client, 'thread-1234567890')).resolves.toBe('No approval is waiting on this thread.')
    const raced = fakeDaemon([request('req-1')])
    // The request listing still shows it (the other client answers between the list and the answer).
    const listing = raced.client.request.bind(raced.client)
    raced.client.request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const result = await listing<T>(method, params)
      if (method === 'orchestrator.pendingQuestions') raced.anotherClientAnswers('req-1', 'reject')
      return result
    }
    await expect(handleApprovalCommand('/approve', raced.client, 'thread-1234567890')).resolves.toBe('Already answered: reject from gui.')
    await expect(handleApprovalCommand('/approver', raced.client, 'thread-1234567890')).resolves.toBeNull()
    await expect(handleApprovalCommand('hello', raced.client, 'thread-1234567890')).resolves.toBeNull()
  })

  it('answers over the same protocol every client uses', async () => {
    const daemon = fakeDaemon([request('req-1')])
    expect(await listPendingApprovals(daemon.client)).toHaveLength(1)
    const result: AnswerResult = await answerApproval(daemon.client, 'req-1', 'allow')
    expect(result).toEqual({ ok: true })
    expect(describeAnswerResult({ ok: false, reason: 'cancelled', cancelReason: 'turn_ended' })).toBe('Closed without an answer (turn_ended).')
    expect(describeAnswerResult({ ok: false, reason: 'already_answered', decision: 'allow', answeredBy: { kind: 'agent' } })).toBe('Already answered: allow from an agent.')
  })
})
