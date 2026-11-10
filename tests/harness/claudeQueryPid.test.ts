/**
 * Stop ends a stopped Claude Code process with everything it started (`reapClosed`), which needs the process: its pid,
 * when it was started (so a pid given to another program since is never killed) and whether it exited. The Agent SDK
 * wraps the process without its pid, so Mousse keeps the pid the SDK reports when it starts the process, with that time,
 * and reads the exit from the SDK's process object.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The SDK's wrapper of the process, as it is: no pid, its exit status and kill through getters. */
const wrapped = { exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(() => true) }
const started: Array<{ options: { onProcessSpawned?: (pid: number) => void } }> = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: { onProcessSpawned?: (pid: number) => void } }) => {
    started.push(args)
    return { transport: { process: wrapped } }
  }
}))

import { claudeQueryPid, claudeQueryProcess, noteClaudeQuerySpawn } from '../../src/mms/harness/vendors/claude/liveSession'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

describe('the Claude Code process of a query', () => {
  let home: string | undefined
  afterEach(() => {
    started.length = 0
    wrapped.exitCode = null
    wrapped.signalCode = null
    wrapped.kill.mockClear()
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  it('is read from the transport when the SDK exposes the pid there', () => {
    expect(claudeQueryPid({ transport: { process: { pid: 31, exitCode: null, signalCode: null } } })).toBe(31)
  })

  it('is the pid and time the SDK reported at spawn when the transport wraps the process without its pid', () => {
    let reported: { pid: number; spawnedAt: number } | undefined
    const query = { transport: { process: { exitCode: null, signalCode: null, kill: () => true } } }
    noteClaudeQuerySpawn(query, () => reported)
    expect(claudeQueryProcess(query)).toBeUndefined()
    reported = { pid: 4242, spawnedAt: 1_000 }
    expect(claudeQueryProcess(query)).toMatchObject({ pid: 4242, root: { spawnedAt: 1_000 } })
  })

  it('tells from the SDK\'s process object whether the process exited, and kills it through that object', () => {
    const handle = { exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(() => true) }
    const query = { transport: { process: handle } }
    noteClaudeQuerySpawn(query, () => ({ pid: 77, spawnedAt: 5 }))
    const target = claudeQueryProcess(query)!
    expect(target.root.exited!()).toBe(false)
    target.root.kill!()
    expect(handle.kill).toHaveBeenCalledWith('SIGKILL')
    handle.exitCode = 0
    expect(target.root.exited!()).toBe(true)
    // A process object without exit status cannot tell: the kill then relies on the creation time alone.
    const bare = { transport: { process: {} } }
    noteClaudeQuerySpawn(bare, () => ({ pid: 78, spawnedAt: 5 }))
    expect(claudeQueryProcess(bare)!.root.exited!()).toBeUndefined()
  })

  it('is recorded with its spawn time for every query Mousse starts, and the caller\'s own spawn callback still runs', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-claude-pid-'))
    const questions = new UserQuestionService()
    const service = new ClaudeSubscriptionProviderService(home, questions, {})
    const own = vi.fn()
    const query = await (service as unknown as { createQuery(prompt: string, options: object): Promise<unknown> }).createQuery('hello', { onProcessSpawned: own })
    expect(claudeQueryPid(query)).toBeUndefined()
    const before = Date.now()
    started[0]!.options.onProcessSpawned!(5150)
    const target = claudeQueryProcess(query)!
    expect(target.pid).toBe(5150)
    expect(target.root.spawnedAt).toBeGreaterThanOrEqual(before)
    expect(target.root.spawnedAt).toBeLessThanOrEqual(Date.now())
    expect(target.root.exited!()).toBe(false)
    expect(own).toHaveBeenCalledWith(5150)
    questions.shutdown()
  })
})
