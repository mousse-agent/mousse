import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isIdempotentTool } from '../../src/mms/run/tools/idempotency'

const NOW = '2026-10-12T00:00:00.000Z'
const LATER = '2026-10-12T00:00:05.000Z'

describe('isIdempotentTool', () => {
  it('classifies the SPEC §12.6 lists', () => {
    for (const name of ['read_file', 'list_dir', 'ls', 'git_status', 'git_diff', 'web_search',
      'web_fetch', 'browser_observe', 'browser_find', 'browser_extract', 'browser_screenshot',
      'task_list', 'list_subagents', 'list_delegations', 'integrate_delegation', 'integrate_subagent'])
      expect(isIdempotentTool(name), name).toBe(true)
    for (const name of ['bash', 'run_command', 'write_file', 'edit_file', 'browser_act',
      'browser_open', 'task_create', 'task_update', 'create_subagent', 'create_subagents',
      'recall_subagent', 'delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel',
      'ask_user'])
      expect(isIdempotentTool(name), name).toBe(false)
  })

  it('treats MCP and unknown tools as non-idempotent unless annotated readOnlyHint', () => {
    expect(isIdempotentTool('mcp__github__get_issue')).toBe(false)
    expect(isIdempotentTool('mcp__github__get_issue', {})).toBe(false)
    expect(isIdempotentTool('mcp__github__get_issue', { readOnlyHint: false })).toBe(false)
    expect(isIdempotentTool('mcp__github__get_issue', { readOnlyHint: true })).toBe(true)
    // A registered side-effecting tool cannot be relabelled by an annotation.
    expect(isIdempotentTool('bash', { readOnlyHint: true })).toBe(false)
  })

  it.each([
    [{ operation: 'list' }, true],
    [{}, true],
    [{ operation: 'new', url: 'https://example.test/' }, false],
    [{ operation: 'switch', tabId: 'tab_1' }, false],
    [{ operation: 'close', tabId: 'tab_1' }, false],
    [undefined, false]
  ])('browser_tabs with %j is idempotent: %s (only listing reads)', (args, idempotent) => {
    expect(isIdempotentTool('browser_tabs', undefined, args)).toBe(idempotent)
  })

  it('a bot\'s consult and escalate are idempotent: their effects are other rows, or bots.db only', () => {
    expect(isIdempotentTool('consult')).toBe(true)
    expect(isIdempotentTool('escalate')).toBe(true)
  })
})

describe('ToolInvocations', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const open = () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-tools-'))
    db = new ProfileDatabase({ profileHome })
    const store = new RunStore(db)
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    return { store, tools: new ToolInvocations(store), run, attempt }
  }

  it('leaves a browser_tabs call that opens a tab unknown after a crash, and one that only lists tabs not', () => {
    const { tools, run, attempt } = open()
    const start = (invocationId: string, args: unknown) => tools.start({ invocationId, runId: run.runId, attemptId: attempt.attemptId, tool: 'browser_tabs', argsDigest: 'sha256:' + invocationId, now: NOW, args })
    expect(start('list', { operation: 'list' }).idempotent).toBe(true)
    expect(start('new', { operation: 'new', url: 'https://example.test/' }).idempotent).toBe(false)
    // A crash now: only the new tab makes the run uncertain on restart.
    expect(tools.listStartedNonIdempotentForRuns([run.runId]).map((row) => row.invocationId)).toEqual(['new'])
  })

  it('records started, committed and failed with tool.status events on the run thread', () => {
    const { store, tools, run, attempt } = open()
    const started = tools.start({
      invocationId: 'call-1',
      runId: run.runId,
      attemptId: attempt.attemptId,
      tool: 'bash',
      argsDigest: 'sha256:abc',
      now: NOW
    })
    expect(started).toEqual({
      invocationId: 'call-1',
      runId: run.runId,
      attemptId: attempt.attemptId,
      tool: 'bash',
      idempotent: false,
      status: 'started',
      argsDigest: 'sha256:abc',
      startedAt: NOW,
      completedAt: null
    })
    const read = tools.start({
      invocationId: 'call-2',
      runId: run.runId,
      attemptId: attempt.attemptId,
      tool: 'read_file',
      argsDigest: 'sha256:def',
      now: NOW
    })
    expect(read.idempotent).toBe(true)
    expect(tools.listStarted(run.runId).map((row) => row.invocationId)).toEqual(['call-1', 'call-2'])
    expect(tools.listStartedNonIdempotentForRuns([run.runId]).map((row) => row.tool)).toEqual(['bash'])
    expect(tools.listStartedNonIdempotentForRuns([])).toEqual([])

    expect(tools.commit('call-1', LATER)).toMatchObject({ status: 'committed', completedAt: LATER })
    expect(tools.commit('call-1', LATER)).toBeNull()
    expect(tools.failed('call-2', LATER)).toMatchObject({ status: 'failed' })
    expect(tools.markOutcomeUnknown('call-2', LATER)).toBeNull()
    expect(tools.markOutcomeUnknown('missing', LATER)).toBeNull()
    expect(tools.listStarted(run.runId)).toEqual([])

    const events = store.listEvents('t').filter((event) => event.type === 'tool.status')
    expect(events.map((event) => [event.runId, (event.payload as { status: string }).status])).toEqual([
      [run.runId, 'started'],
      [run.runId, 'started'],
      [run.runId, 'committed'],
      [run.runId, 'failed']
    ])
    expect(tools.get('call-1')!.status).toBe('committed')
  })

  it('marks a started invocation outcome_unknown', () => {
    const { tools, run, attempt } = open()
    tools.start({
      invocationId: 'call-1',
      runId: run.runId,
      attemptId: attempt.attemptId,
      tool: 'mcp__fs__write',
      argsDigest: 'd',
      now: NOW
    })
    expect(tools.markOutcomeUnknown('call-1', LATER)).toMatchObject({
      status: 'outcome_unknown',
      idempotent: false,
      completedAt: LATER
    })
    expect(tools.listForRun(run.runId)).toHaveLength(1)
  })

  it('rejects an unknown run and a duplicate invocation id', () => {
    const { tools, run, attempt } = open()
    const input = {
      invocationId: 'call-1',
      runId: run.runId,
      attemptId: attempt.attemptId,
      tool: 'bash',
      argsDigest: 'd',
      now: NOW
    }
    tools.start(input)
    const codeOf = (work: () => unknown) => {
      try {
        work()
      } catch (error) {
        return error instanceof RunStoreError ? error.code : 'other'
      }
      return undefined
    }
    expect(codeOf(() => tools.start(input))).toBe('conflict')
    expect(codeOf(() => tools.start({ ...input, invocationId: 'x', runId: 'run:none' }))).toBe('bad_request')
  })
})
