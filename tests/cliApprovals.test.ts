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

/** A daemon that answers like the real one: the first answer wins, the second learns who did. */
function fakeDaemon(pending: PendingApproval[]) {
  const settled = new Map<string, { decision: string; via: string }>()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
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
  it('approves the latest request waiting on the thread, once', async () => {
    const daemon = fakeDaemon([request('req-1'), request('req-2')])
    await expect(handleApprovalCommand('/approve', daemon.client, 'thread-1234567890')).resolves.toBe('Answered: allow')
    // The latest request, by the decision its option declares.
    expect(daemon.calls.at(-1)!.params).toEqual({ requestId: 'req-2', answers: { permission: 'allow' } })
    expect([...daemon.settled.keys()]).toEqual(['req-2'])
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
