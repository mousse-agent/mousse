/**
 * SPEC §16.2 thread fork: forkable source statuses, receipt replay, the lazy `fork` transfer, and the
 * fork's first message resolving it — portable `full_summary` with the fork's own worktree seeded
 * from the source's checkpoint, and a native-capable adapter whose `forkSession` stub falls back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import type { RunTerminalStatus } from '../../src/mms/run/RunEngine'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { gitFoundationFixture } from '../fixtures/gitFoundation'
import { PI, phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

describe('thread fork (SPEC §16.2)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  let foundation: ReturnType<typeof gitFoundationFixture> | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    foundation?.dispose()
    foundation = undefined
    if (home) {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
    home = undefined
  })

  const plainHome = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-fork-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    return home
  }

  /** A run on `threadId` left in `status` without a provider turn. */
  const runIn = async (d: Phase6Daemon, threadId: string, status: RunTerminalStatus | 'running') => {
    const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: `seed:${Math.random()}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.markStarting(sent.runId)
    d.engine.markRunning(sent.runId)
    return status === 'running' ? d.engine.getRun(sent.runId)! : d.engine.markTerminal(sent.runId, status)
  }

  const reason = (error: unknown) => (error instanceof CommandRejection ? error.reason : error)

  it('forks after completed, failed, interrupted or cancelled runs, never running or uncertain, and replays by clientRequestId', async () => {
    const d = (daemon = phase6Daemon(plainHome(), [piAdapter(() => 'unused')]))
    const source = d.store.createThread('Source')
    for (const status of ['completed', 'failed', 'interrupted', 'cancelled', 'uncertain'] as const) await runIn(d, source.id, status)
    await runIn(d, source.id, 'running')

    for (const ordinal of [1, 2, 3, 4]) {
      const forked = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: ordinal, clientRequestId: `fork-${ordinal}` })
      expect(d.engine.delegations.getLineage(forked.threadId)).toMatchObject({ parentThreadId: source.id, relationship: 'fork', parentRunId: forked.sourceRunId })
    }
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 5, clientRequestId: 'fork-5' }).catch((e) => e))).toBe('run_not_forkable')
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 6, clientRequestId: 'fork-6' }).catch((e) => e))).toBe('run_not_forkable')
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 9, clientRequestId: 'fork-9' }).catch((e) => e))).toBe('run_not_found')

    // latest_stable skips the running and uncertain runs.
    const latest = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 'latest_stable', title: 'Try B', clientRequestId: 'fork-latest' })
    expect(d.engine.getRun(latest.sourceRunId)!.ordinal).toBe(4)
    expect(d.store.getThread(latest.threadId)?.name).toBe('Try B')
    const again = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 'latest_stable', title: 'Try B', clientRequestId: 'fork-latest' })
    expect(again).toEqual({ ...latest, replayed: true })

    const empty = d.store.createThread('Empty')
    expect(reason(await d.engine.forkThread({ sourceThreadId: empty.id, clientRequestId: 'fork-empty' }).catch((e) => e))).toBe('no_forkable_run')
  })

  it('is lazy: the fork transfer waits pending and nothing reaches a provider', async () => {
    const pi = piAdapter((input) => `reply to ${input.prompt}`)
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Plan the feature', false, { threadId: source.id, clientRequestId: 's-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'lazy' })
    expect(pi.turns).toHaveLength(1)
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({
      type: 'fork', status: 'pending', sourceThreadId: source.id, targetThreadId: forked.threadId, sourceRunOrdinal: 1, payload: { sourceRunOrdinal: 1 }
    })
    expect(d.engine.listRuns(forked.threadId)).toEqual([])
    expect(d.orch.getThreadModelOverride(forked.threadId)).toEqual(PI)
  })

  it('resolves portably on the first message, in the fork\'s own worktree seeded from the source checkpoint', async () => {
    foundation = gitFoundationFixture()
    const f = foundation
    const pi = piAdapter((input) => {
      if (input.cwd && input.prompt.startsWith('Write ')) writeFileSync(join(input.cwd, 'value.txt'), `${input.prompt.slice(6)}\n`)
      return `done: ${input.prompt}`
    })
    const d = (daemon = phase6Daemon(f.home, [pi]))
    const project = d.projects.openProject(f.repo)
    const source = d.store.createThread('Source', project.id)
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send({ content: 'Write one', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-1' })
    await d.orch.send({ content: 'Write two', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-2' })
    const sourceWorktree = new ThreadWorkspaceManager(d.store.getThreadDir(source.id)).load()!.worktreePath
    expect(f.read(sourceWorktree)).toBe('two\n')

    const forked = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 1, clientRequestId: 'fork-at-1' })
    const response = await d.orch.send({ content: 'What is in value.txt?', mode: 'agent' }, false, { threadId: forked.threadId, clientRequestId: 'fork-first' })
    expect(response.message).toBe('done: What is in value.txt?')

    const turn = pi.turns.at(-1)!
    expect(turn.threadId).toBe(forked.threadId)
    expect(turn.messages).toHaveLength(3)
    expect(String(turn.messages[0].content)).toContain('[Context handoff: strategy=full_summary, covered=1.]')
    expect(String(turn.messages[0].content)).toContain('Write one')
    expect(turn.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done: Write one' }] })
    expect(turn.messages[2]).toMatchObject({ role: 'user', content: 'What is in value.txt?' })
    expect(JSON.stringify(turn.messages)).not.toContain('Write two')

    const forkWorkspace = new ThreadWorkspaceManager(d.store.getThreadDir(forked.threadId)).load()!
    expect(forkWorkspace.worktreePath).not.toBe(sourceWorktree)
    expect(turn.cwd?.startsWith(forkWorkspace.worktreePath)).toBe(true)
    expect(readFileSync(join(forkWorkspace.worktreePath, 'value.txt'), 'utf8')).toBe('one\n')
    expect(f.read(sourceWorktree)).toBe('two\n')

    const transfer = d.engine.transfers.get(forked.transferId)!
    expect(transfer).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'portable', strategy: 'full_summary', seed: { kind: 'checkpoint' } } })
    expect(d.engine.handoffs.listForThread(forked.threadId)).toMatchObject([{ strategy: 'full_summary', status: 'delivered', coveredFromOrdinal: 1, coveredToOrdinal: 1 }])
    // The seeded context stays in the fork's own transcript for its next turns.
    expect(d.orch.getNativeContext(forked.threadId).messages).toHaveLength(4)
    expect(d.orch.getMessages(forked.threadId).find((message) => message.kind === 'context_handoff')?.contextHandoff).toMatchObject({ transfer: 'fork', strategy: 'full_summary' })
  }, 60_000)

  it('a native-fork-capable adapter whose forkSession returns null falls back to the portable handoff', async () => {
    const pi = piAdapter((input) => `reply to ${input.prompt}`, { fork: 'native' }, 'session-1')
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Start', false, { threadId: source.id, clientRequestId: 'n-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'native-fork' })
    await d.orch.send('Continue in the fork', false, { threadId: forked.threadId, clientRequestId: 'n-2' })
    expect(pi.forkCalls).toEqual([{ ref: { provider: 'openai', model: 'gpt-replay', sessionId: 'session-1' }, atTurnOrdinal: 1 }])
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'portable', strategy: 'full_summary' } })
    expect(String(pi.turns.at(-1)!.messages[0].content)).toContain('Start')
  })
})
