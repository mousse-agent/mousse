/**
 * Stop ends a stopped Claude Code process with everything it started (`reapClosed`), which needs the process's pid.
 * The Agent SDK wraps the process without it, so Mousse keeps the pid the SDK reports when it starts the process.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const started: Array<{ options: { onProcessSpawned?: (pid: number) => void } }> = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // As the SDK does: the transport's process has no pid, and the pid is reported to `onProcessSpawned`.
  query: (args: { options: { onProcessSpawned?: (pid: number) => void } }) => {
    started.push(args)
    return { transport: { process: { stdin: null, stdout: null, kill: () => true } } }
  }
}))

import { claudeQueryPid, noteClaudeQueryPid } from '../../src/mms/harness/vendors/claude/liveSession'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

describe('the pid of a query\'s Claude Code', () => {
  let home: string | undefined
  afterEach(() => {
    started.length = 0
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  it('is read from the transport when the SDK exposes it there', () => {
    expect(claudeQueryPid({ transport: { process: { pid: 31 } } })).toBe(31)
  })

  it('is the pid the SDK reported at spawn when the transport wraps the process without it', () => {
    let reported: number | undefined
    const query = { transport: { process: { kill: () => true } } }
    noteClaudeQueryPid(query, () => reported)
    expect(claudeQueryPid(query)).toBeUndefined()
    reported = 4242
    expect(claudeQueryPid(query)).toBe(4242)
  })

  it('is recorded for every query Mousse starts, and the caller\'s own spawn callback still runs', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-claude-pid-'))
    const questions = new UserQuestionService()
    const service = new ClaudeSubscriptionProviderService(home, questions, {})
    const own = vi.fn()
    const query = await (service as unknown as { createQuery(prompt: string, options: object): Promise<unknown> }).createQuery('hello', { onProcessSpawned: own })
    expect(claudeQueryPid(query)).toBeUndefined()
    started[0]!.options.onProcessSpawned!(5150)
    expect(claudeQueryPid(query)).toBe(5150)
    expect(own).toHaveBeenCalledWith(5150)
    questions.shutdown()
  })
})
