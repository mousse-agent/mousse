/**
 * Thread goals (issue #1207): `/goal` keeps a thread working turn after turn until the agent reports the goal met, it
 * is blocked, a limit is reached or the person stops it. A real `OrchestratorService`, Run Engine and effect worker over
 * a temporary profile; the providers are scripted (hand-authored: they prove Mousse's side only). The agent reports the
 * way the real one does, through the `goal_update` app tool's handler over the orchestrator's tool host.
 *
 * What ends a goal turn, as rows: met, blocked, no report twice, the turn limit, a failed turn, a question waiting,
 * Stop, a restart. What runs between goal turns: the person's queued message.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { goalTools } from '../../src/mms/run/mcp/appTools/goal'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools'
import { CONTINUE_TEXT } from '../../src/mms/run/pauseText'
import type { TurnInput } from '../../src/mms/harness/types'
import type { RunSettings } from '../../src/shared/settings'
import { newGoal } from '../../src/shared/threadGoal'
import { CLAUDE, PI, claudeAdapter, phase6Daemon, piAdapter, waitFor, type Phase6Daemon, type ScriptedAdapter } from './phase6Fixture'

vi.setConfig({ testTimeout: 30_000 })

type Report = { status: 'met' | 'continue' | 'blocked'; reason: string } | null

describe('a thread goal', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-goal-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    return home
  }

  const boot = (home: string, adapter: ScriptedAdapter, runs: Partial<RunSettings> = {}, orchestratorBoot = false, pid = 1): Phase6Daemon => {
    const daemon = phase6Daemon(home, [adapter], { runs, orchestratorBoot, pid })
    daemons.push(daemon)
    return daemon
  }

  /** What the agent's `goal_update` call does: the registered tool's handler, over the orchestrator's host. */
  const report = (d: Phase6Daemon, input: Pick<TurnInput, 'threadId' | 'runId'>, args: Record<string, unknown>) => {
    const tool = goalTools(d.orch.mcpToolHost())[0]!
    return tool.handler(args, { caller: { threadId: input.threadId, runId: input.runId, provider: 'test', accessLevel: 'manage' }, transport: 'mcp' } as unknown as ToolCallContext)
  }

  /** An agent that reports `reports[i]` in its turn i (null: no report) and replies. */
  const agent = (reports: Report[], d: () => Phase6Daemon, adapter = piAdapter) => {
    let turn = 0
    return adapter(async (input: TurnInput) => {
      const next = reports[turn++]
      if (next) await report(d(), input, next)
      return `turn ${turn}`
    })
  }

  const goalOf = (d: Phase6Daemon, threadId: string) => d.store.getThread(threadId)?.goal
  const visibleUserTexts = (d: Phase6Daemon, threadId: string) => d.orch.getMessages(threadId).filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)
  const idle = (d: Phase6Daemon, threadId: string) => !d.engine.getActiveRun(threadId) && readDurableQueue(d.store, threadId).length === 0
  /** Lets a decision that would queue another turn happen, if it was going to. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

  const thread = (d: Phase6Daemon, model = PI) => {
    const created = d.store.createThread('Goal')
    d.orch.setThreadModelOverride(created.id, model)
    return created
  }

  it.each([
    { name: 'Pi', adapter: piAdapter, model: PI },
    { name: 'Claude', adapter: claudeAdapter, model: CLAUDE as typeof PI }
  ])('$name: keeps starting turns until the agent reports the goal met, with one visible message and the goal in every prompt', async ({ adapter, model }) => {
    let d!: Phase6Daemon
    const scripted = agent([
      { status: 'continue', reason: 'Fixed two of five tests.' },
      { status: 'continue', reason: 'Fixed four of five.' },
      { status: 'met', reason: 'All five tests pass.' }
    ], () => d, adapter)
    d = boot(newHome(), scripted)
    const { id } = thread(d, model)

    d.orch.threadGoal(id, 'set', 'Make the five failing tests pass')

    await waitFor(() => goalOf(d, id)?.state === 'met' && idle(d, id), 'the goal met')
    await settle()
    expect(scripted.turns).toHaveLength(3)
    for (const seen of scripted.turns) {
      expect(seen.prompt).toContain('<mousse_goal>')
      expect(seen.prompt).toContain('Done looks like: Make the five failing tests pass')
    }
    expect(scripted.turns[1]!.prompt).toContain(CONTINUE_TEXT)
    // The goal is the person's one message; the continue turns add no bubble.
    expect(visibleUserTexts(d, id)).toEqual(['Make the five failing tests pass'])
    expect(goalOf(d, id)).toMatchObject({ state: 'met', turns: 3, lastReport: { status: 'met', reason: 'All five tests pass.' } })
  })

  it('stops at its turn limit, and Continue allows as many turns again', async () => {
    let d!: Phase6Daemon
    const scripted = agent(Array.from({ length: 10 }, () => ({ status: 'continue' as const, reason: 'More to do.' })), () => d)
    d = boot(newHome(), scripted, { goalTurnLimit: 2 })
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Finish the migration')
    await waitFor(() => goalOf(d, id)?.state === 'stopped' && idle(d, id), 'the goal stopped at its limit')
    await settle()
    expect(scripted.turns).toHaveLength(2)
    expect(goalOf(d, id)).toMatchObject({ state: 'stopped', stoppedBy: 'turn_limit', turns: 2 })

    d.orch.threadGoal(id, 'continue')
    await waitFor(() => scripted.turns.length === 4 && goalOf(d, id)?.state === 'stopped' && idle(d, id), 'two more turns')
    await settle()
    expect(scripted.turns).toHaveLength(4)
    expect(visibleUserTexts(d, id)).toEqual(['Finish the migration'])
  })

  it.each([
    { name: 'blocked: stuck with the agent\'s reason', reports: [{ status: 'blocked' as const, reason: 'Need the staging password.' }], turns: 1, goal: { state: 'stuck', lastReport: { reason: 'Need the staging password.' } } },
    { name: 'no report twice: stuck', reports: [null, null, null], turns: 2, goal: { state: 'stuck', lastReport: { reason: 'The agent stopped reporting progress.' } } }
  ])('$name', async ({ reports, turns, goal }) => {
    let d!: Phase6Daemon
    const scripted = agent(reports, () => d)
    d = boot(newHome(), scripted)
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Ship it')
    await waitFor(() => goalOf(d, id)?.state !== 'working' && idle(d, id), 'the goal ended')
    await settle()
    expect(scripted.turns).toHaveLength(turns)
    expect(goalOf(d, id)).toMatchObject(goal)
  })

  it('stops when a turn fails', async () => {
    const scripted = piAdapter(() => 'unused')
    const d = boot(newHome(), scripted)
    const { id } = thread(d)
    scripted.failNext = new Error('provider exploded')

    d.orch.threadGoal(id, 'set', 'Ship it')
    await waitFor(() => goalOf(d, id)?.state === 'stopped' && idle(d, id), 'the goal stopped')
    await settle()
    expect(scripted.turns).toHaveLength(1)
    expect(goalOf(d, id)).toMatchObject({ state: 'stopped', stoppedBy: 'error' })
  })

  it('stops while a question waits for the person', async () => {
    let d!: Phase6Daemon
    const scripted = piAdapter(async (input) => {
      await report(d, input, { status: 'continue', reason: 'Asked which database to use.' })
      void d.questions.requestAnswers([{ id: 'q', prompt: 'Which database?', options: [{ id: 'a', label: 'Postgres' }, { id: 'b', label: 'SQLite' }] }], input.threadId, {}).catch(() => undefined)
      return 'asked'
    })
    d = boot(newHome(), scripted)
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Set up the database')
    await waitFor(() => goalOf(d, id)?.state === 'stopped' && idle(d, id), 'the goal stopped')
    await settle()
    expect(scripted.turns).toHaveLength(1)
    expect(goalOf(d, id)).toMatchObject({ state: 'stopped', stoppedBy: 'waiting' })
  })

  it('Stop ends the goal: the running turn stops and no next turn runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let d!: Phase6Daemon
    const scripted = piAdapter(async (input) => {
      await report(d, input, { status: 'continue', reason: 'Working.' })
      await gate
      return 'done'
    })
    d = boot(newHome(), scripted)
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Ship it')
    await waitFor(() => scripted.turns.length === 1, 'the first turn')
    await d.orch.stopThread(id, 'user')
    release()
    await waitFor(() => idle(d, id), 'the thread idle')
    await settle()
    expect(scripted.turns).toHaveLength(1)
    expect(goalOf(d, id)).toMatchObject({ state: 'stopped', stoppedBy: 'user' })
  })

  it('a message the person sends mid-goal runs next, and the goal carries on after it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let d!: Phase6Daemon
    let turn = 0
    const scripted = piAdapter(async (input) => {
      turn += 1
      if (turn === 1) {
        await report(d, input, { status: 'continue', reason: 'Started.' })
        await gate
      } else if (turn === 3) await report(d, input, { status: 'met', reason: 'Done, the README too.' })
      else await report(d, input, { status: 'continue', reason: 'Updated the README.' })
      return `turn ${turn}`
    })
    d = boot(newHome(), scripted)
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Ship it')
    await waitFor(() => scripted.turns.length === 1, 'the first turn')
    d.orch.enqueueAndDrain(id, { content: 'Also update the README', mode: 'agent' }, 'gui')
    release()
    await waitFor(() => goalOf(d, id)?.state === 'met' && idle(d, id), 'the goal met')
    await settle()
    expect(scripted.turns.map((seen) => seen.prompt.split('\n\n').at(-1))).toEqual(['Ship it', 'Also update the README', CONTINUE_TEXT])
    // The person's turn is not a goal turn: the goal counts its own two.
    expect(goalOf(d, id)).toMatchObject({ state: 'met', turns: 2 })
  })

  it('survives a restart as stopped, and the goal turn left in the queue never runs', async () => {
    const home = newHome()
    const first = piAdapter(() => 'unused')
    const d = boot(home, first)
    const { id } = thread(d)
    // What a daemon that died mid-goal leaves: the goal working, and its next turn queued on disk.
    d.store.updateThreadMeta(id, { goal: newGoal('Ship it', 20, new Date().toISOString(), 'goal-before-restart') }, { touch: false })
    d.orch.enqueueForThread(id, { content: CONTINUE_TEXT, mode: 'agent' }, { source: 'goal', internal: true })
    // The thread list writes its entry changes within a second (`STANDALONE_INDEX_WRITE_MS`); a goal that has been
    // working longer than that is in the list a restart reads.
    d.store.flushStandaloneIndex()
    await d.crash()

    const second = piAdapter(() => 'continued')
    const again = boot(home, second, {}, true, 2)
    again.orch.scheduleStartupQueueRecovery()
    await settle()
    await settle()
    expect(goalOf(again, id)).toMatchObject({ state: 'stopped', stoppedBy: 'restart', text: 'Ship it' })
    expect(readDurableQueue(again.store, id).filter((item) => item.source === 'goal')).toEqual([])
    expect(second.turns).toHaveLength(0)

    again.orch.threadGoal(id, 'continue')
    await waitFor(() => second.turns.length >= 1, 'Continue runs a goal turn')
    expect(second.turns[0]!.prompt).toContain('<mousse_goal>')
    expect(second.turns[0]!.prompt).toContain(CONTINUE_TEXT)
  })

  it('a goal set while another goal\'s turn runs is not ended by that turn\'s report or its failure', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let d!: Phase6Daemon
    let turn = 0
    const scripted = piAdapter(async (input) => {
      turn += 1
      if (turn === 1) {
        await firstGate
        // Goal A's turn reports met after goal B replaced it, then fails.
        const answer = await report(d, input, { status: 'met', reason: 'A is done.' })
        expect(answer.text).toMatch(/changes nothing/)
        throw new Error('turn of goal A failed')
      }
      await report(d, input, { status: 'met', reason: 'B is done.' })
      return 'done'
    })
    d = boot(newHome(), scripted)
    const { id } = thread(d)

    d.orch.threadGoal(id, 'set', 'Goal A')
    await waitFor(() => scripted.turns.length === 1, 'goal A\'s turn')
    d.orch.threadGoal(id, 'set', 'Goal B')
    releaseFirst()
    await waitFor(() => goalOf(d, id)?.state === 'met' && idle(d, id), 'goal B met')
    await settle()
    expect(scripted.turns).toHaveLength(2)
    expect(scripted.turns[1]!.prompt).toContain('Done looks like: Goal B')
    expect(goalOf(d, id)).toMatchObject({ text: 'Goal B', state: 'met', lastReport: { reason: 'B is done.' } })
  })

  it('a new chat\'s goal is set before its first message, so that turn runs under it, and a Stop of it ends the goal', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const scripted = piAdapter(async () => { await gate; return 'stopped meanwhile' })
    const d = boot(newHome(), scripted)
    const { id } = thread(d)

    // What the window does for `/goal <text>` on a new chat: adopt, then send the text as the first message.
    d.orch.threadGoal(id, 'adopt', 'Ship it')
    expect(readDurableQueue(d.store, id)).toEqual([])
    void d.orch.send('Ship it', false, { threadId: id, clientRequestId: 'first' }).catch(() => undefined)
    await waitFor(() => scripted.turns.length === 1, 'the first turn')
    expect(scripted.turns[0]!.prompt).toContain('Done looks like: Ship it')
    await d.orch.stopThread(id, 'user')
    release()
    await waitFor(() => idle(d, id), 'the thread idle')
    await settle()
    expect(scripted.turns).toHaveLength(1)
    expect(goalOf(d, id)).toMatchObject({ state: 'stopped', stoppedBy: 'user' })
  })

  it('goal_update is refused on a thread without a working goal', async () => {
    const d = boot(newHome(), piAdapter(() => 'reply'))
    const { id } = thread(d)
    const tool = goalTools(d.orch.mcpToolHost())[0]!
    const turn = { threadId: id, subagent: false } as never
    expect(tool.available!(turn)).toMatch(/no goal/)
    const outcome = await report(d, { threadId: id, runId: 'run:none' }, { status: 'met', reason: 'Done.' })
    expect(outcome).toMatchObject({ isError: true })
  })
})
