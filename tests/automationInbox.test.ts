import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { AutomationRuns } from '../src/mms/automations/AutomationRuns'
import { AutomationDrafts } from '../src/mms/automations/AutomationDrafts'
import { automationTools, type AutomationToolHost } from '../src/mms/run/mcp/appTools/automations'
import type { AppToolHost } from '../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../src/mms/run/mcp/appTools/types'
import { levelNotifies, openForBot, openForPerson, resolvedRun, runReportNotice } from '../src/shared/automationInbox'
import { tellMeNotifies, type ScheduledRunEnded } from '../src/shared/automations'
import { parseTellMe, tellMeOf, type Thread } from '../src/shared/types'

let home: string
let previousHome: string | undefined
let runs: AutomationRuns

beforeEach(() => {
  previousHome = process.env.MOUSSE_HOME
  home = mkdtempSync(join(tmpdir(), 'mousse-inbox-'))
  process.env.MOUSSE_HOME = home
  runs = new AutomationRuns({ profileHome: home })
})
afterEach(() => {
  runs.close()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const begin = (jobId: string, key: string, extra: Partial<Parameters<AutomationRuns['begin']>[0]> = {}) =>
  runs.begin({ jobId, jobName: `Job ${jobId}`, occurrenceKey: key, projectId: 'p1', ...extra })

describe('run_report and the run record', () => {
  it('stores one report per run (a second call replaces it), and a run that ends without one shows No report, never quiet', () => {
    const first = begin('j1', '2026-11-09T09:00:00Z')
    runs.update('j1', '2026-11-09T09:00:00Z', { threadId: 't1', engineRunId: 'engine-1' })
    expect(first).toMatchObject({ number: 1, state: 'running', items: [] })
    runs.report({ threadId: 't1', runId: 'engine-1' }, 'fyi', 'Merged 3 patch updates')
    const replaced = runs.report({ threadId: 't1' }, 'look', 'checkout.spec failed 3 of 20 reruns\nmore detail is ignored')
    expect(replaced).toMatchObject({ level: 'look', summary: 'checkout.spec failed 3 of 20 reruns' })
    expect(runs.finish({ jobId: 'j1', occurrenceKey: '2026-11-09T09:00:00Z', failed: false })).toMatchObject({ state: 'done', level: 'look' })

    begin('j1', '2026-11-09T10:00:00Z', { threadId: 't2' })
    const none = runs.finish({ jobId: 'j1', occurrenceKey: '2026-11-09T10:00:00Z', failed: false })
    expect(none.number).toBe(2)
    expect(none.level).toBeUndefined()
    expect(none.items).toEqual([])
    // [SILENT] with no report stays internal and reads as quiet.
    begin('j1', '2026-11-09T11:00:00Z')
    expect(runs.finish({ jobId: 'j1', occurrenceKey: '2026-11-09T11:00:00Z', failed: false, silent: true }).level).toBe('quiet')
  })

  it('refuses a report outside a live run, and a level or summary it cannot read', () => {
    expect(() => runs.report({ threadId: 'nowhere' }, 'fyi', 'x')).toThrow(/no automation run going/)
    begin('j1', 'k1', { threadId: 't1' })
    expect(() => runs.report({ threadId: 't1' }, 'urgent', 'x')).toThrow(/quiet, fyi, look or needs_you/)
    expect(() => runs.report({ threadId: 't1' }, 'fyi', '  ')).toThrow(/summary/)
    runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    // The person's reply later in the thread is not the run.
    expect(() => runs.report({ threadId: 't1' }, 'fyi', 'late')).toThrow(/no automation run going/)
  })

  it('keeps a run held by a usage limit as the same run when it starts again', () => {
    begin('j1', 'k1')
    runs.update('j1', 'k1', { state: 'paused_usage', until: '2026-11-09T14:00:00Z' })
    expect(runs.list().runs[0]).toMatchObject({ state: 'paused_usage', until: '2026-11-09T14:00:00Z' })
    const resumed = begin('j1', 'k2')
    expect(resumed).toMatchObject({ number: 1, state: 'running' })
    expect(resumed.until).toBeUndefined()
    expect(runs.list().runs).toHaveLength(1)
  })
})

describe('the Needs you queue', () => {
  it('holds needs_you reports and failed runs until Resolve; opening or listing a run never resolves it; Undo reopens', () => {
    begin('j1', 'k1', { threadId: 't1' })
    runs.report({ threadId: 't1' }, 'needs_you', 'lodash 5 breaks 2 tests: pin or patch?')
    // A live run joins the queue when it ends.
    expect(openForPerson(runs.list().runs[0]!)).toBe(false)
    const asked = runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    expect(asked.items).toMatchObject([{ kind: 'needs_you', assignee: { kind: 'person' } }])
    const failed = runs.finish({ jobId: 'j2', jobName: 'Release notes', occurrenceKey: 'k1', failed: true, error: 'No access to mousse-plus' })
    expect(failed).toMatchObject({ state: 'failed', error: 'No access to mousse-plus', items: [{ kind: 'failed' }] })

    // Reading the run (opening it) changes nothing.
    runs.get(asked.id)
    runs.list()
    expect(runs.list().runs.filter(openForPerson)).toHaveLength(2)

    expect(runs.resolve(asked.id)).toBe(1)
    expect(runs.resolve(asked.id)).toBe(0)
    expect(resolvedRun(runs.get(asked.id)!)).toBe(true)
    expect(runs.list().undo).toEqual({ runId: asked.id, jobName: 'Job j1' })
    runs.resolve(failed.id)
    expect(runs.undo()).toBe(failed.id)
    expect(openForPerson(runs.get(failed.id)!)).toBe(true)
    expect(runs.undo()).toBe(asked.id)
    expect(openForPerson(runs.get(asked.id)!)).toBe(true)
    expect(runs.undo()).toBeUndefined()
  })

  it('queues only the report the run ended with: needs_you then fyi is not an item', () => {
    begin('j1', 'k1', { threadId: 't1' })
    runs.report({ threadId: 't1' }, 'needs_you', 'Pin or patch?')
    runs.report({ threadId: 't1' }, 'fyi', 'Patched both call sites myself')
    const run = runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    expect(run).toMatchObject({ level: 'fyi', items: [] })
  })

  it('assigns a bot automation\'s items to its bot ("Assigned to bots"), and the person\'s to the person', () => {
    begin('bot-job', 'k1', { botId: 'bot_1', activationId: 'act_1' })
    runs.syncBotRuns('bot-job', [{ id: 'act_1', status: 'running', at: '2026-11-09T08:00:00Z', threadId: 'bt1' }])
    runs.report({ threadId: 'bt1', activationId: 'act_1' }, 'needs_you', 'Calendar clash at 10:00')
    runs.syncBotRuns('bot-job', [{ id: 'act_1', status: 'done', at: '2026-11-09T08:00:00Z', endedAt: '2026-11-09T08:01:00Z', threadId: 'bt1' }])
    const run = runs.list().runs[0]!
    expect(run).toMatchObject({ state: 'done', level: 'needs_you', botId: 'bot_1', threadId: 'bt1' })
    expect(run.items[0]!.assignee).toEqual({ kind: 'bot', botId: 'bot_1' })
    expect(openForBot(run)).toBe(true)
    expect(openForPerson(run)).toBe(false)
    // The dot counts only the person's.
    expect(runs.counts().total).toBe(0)
  })

  it('makes an approval or a question on a run\'s thread an item until it is answered where it was asked', () => {
    begin('j1', 'k1', { threadId: 't1' })
    expect(runs.openAsk('not-a-run', 'q0', 'ask')).toBe(false)
    expect(runs.openAsk('t1', 'q1', 'approval')).toBe(true)
    runs.openAsk('t1', 'q2', 'ask')
    expect(runs.list().runs[0]!.items.map((item) => item.kind)).toEqual(['approval', 'ask'])
    expect(runs.closeAsk('q1')).toBe(true)
    const items = runs.list().runs[0]!.items
    expect(items.find((item) => item.kind === 'approval')).toMatchObject({ resolvedBy: 'answered' })
    expect(items.find((item) => item.kind === 'ask')?.resolvedAt).toBeUndefined()
    // Answering is not the person's Resolve: Undo does not reopen it.
    expect(runs.undo()).toBeUndefined()
  })

  it('counts the runs that need the person, per project, for the project dot', () => {
    runs.finish({ jobId: 'a', occurrenceKey: 'k', failed: true, projectId: 'p1' })
    runs.finish({ jobId: 'b', occurrenceKey: 'k', failed: true, projectId: 'p1' })
    runs.finish({ jobId: 'c', occurrenceKey: 'k', failed: true, projectId: 'p2' })
    begin('d', 'k', { projectId: 'p2', threadId: 'td' })
    runs.openAsk('td', 'q', 'approval')
    runs.openAsk('td', 'q2', 'ask')
    expect(runs.counts()).toEqual({ byProject: { p1: 2, p2: 2 }, total: 4 })
    runs.resolve(runs.list().runs.find((run) => run.jobId === 'c')!.id)
    expect(runs.counts().byProject.p2).toBe(1)
  })
})

describe('Tuning notes', () => {
  it('writes a dated note on the automation, puts the newest five in the next run\'s first message, and forgets a removed one', () => {
    begin('j1', 'k1', { threadId: 't1' })
    runs.report({ threadId: 't1' }, 'fyi', 'Main is green again')
    const run = runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    const note = runs.calibrate(run.id, 'noisy')!
    expect(note).toMatchObject({ jobId: 'j1', kind: 'noisy', runNumber: 1 })
    expect(note.text).toMatch(/Too noisy: “Main is green again” was reported as FYI/)
    expect(runs.notice('j1', 'CI health')).toContain(note.text)
    expect(runs.notice('j1')).toMatch(/run_report/)
    expect(runs.notice('j1')).toMatch(/needs_you/)

    // Given again on the same run, it is taken back.
    expect(runs.calibrate(run.id, 'noisy')).toBeUndefined()
    expect(runs.tuning('j1')).toEqual([])
    const missed = runs.calibrate(run.id, 'missed')!
    expect(runs.removeTuning(missed.id)).toBe(true)
    expect(runs.notice('j1')).not.toContain('Should have told me')
  })

  it('keeps only the newest five notes in the first message, and the chat\'s context', () => {
    const notes = Array.from({ length: 7 }, (_, index) => ({ kind: 'noisy' as const, text: `note ${index}`, createdAt: `2026-11-0${index + 1}T00:00:00Z`, runNumber: index + 1 }))
    const text = runReportNotice({ name: 'Nightly', context: 'Rerun checkout.spec 20 times on main.', tuning: notes })
    expect(text).toContain('Rerun checkout.spec 20 times on main.')
    expect(text).toContain('note 6')
    expect(text).toContain('note 2')
    expect(text).not.toContain('note 1')
    expect(text).not.toContain('note 0')
  })

  it('drops a deleted automation\'s notes and meta, and keeps its runs', () => {
    const run = runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    runs.calibrate(run.id, 'missed')
    runs.setMeta('j1', { originThreadId: 't-chat', context: 'this test' })
    runs.forgetAutomation('j1')
    expect(runs.tuning('j1')).toEqual([])
    expect(runs.meta('j1')).toBeUndefined()
    expect(runs.list().runs).toHaveLength(1)
  })
})

describe('usage', () => {
  it('adds each request to its model\'s line on the run, with the cost only when it is known, and sums this month', () => {
    begin('j1', 'k1', { threadId: 't1' })
    runs.update('j1', 'k1', { engineRunId: 'engine-1' })
    expect(runs.addUsage({ threadId: 't1', runId: 'engine-1' }, { model: 'claude-x', provider: 'anthropic', input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 })).toBe(true)
    runs.addUsage({ threadId: 't1' }, { model: 'claude-x', provider: 'anthropic', input: 50, output: 5, cacheRead: 10, cacheWrite: 0, costUsd: 0.005 })
    runs.addUsage({ threadId: 't1' }, { model: 'gpt-y', provider: 'codex', input: 30, output: 3, cacheRead: 0, cacheWrite: 0 })
    runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    // A thread with no live run (the person's reply later) is not counted.
    expect(runs.addUsage({ threadId: 't1' }, { model: 'claude-x', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBe(false)
    const inbox = runs.list()
    expect(inbox.runs[0]!.usage).toEqual([
      { model: 'claude-x', provider: 'anthropic', input: 150, output: 25, cacheRead: 10, cacheWrite: 0, costUsd: 0.015 },
      { model: 'gpt-y', provider: 'codex', input: 30, output: 3, cacheRead: 0, cacheWrite: 0 }
    ])
    expect(inbox.month.byJob.j1!.tokens).toBe(208)
    expect(inbox.month.byJob.j1!.costUsd).toBeCloseTo(0.015)
    expect(inbox.month.label).toMatch(/^API keys · /)
  })
})

describe('notifications follow the level', () => {
  it('notifies needs_you and failures by default, and look; a filter can lower or raise it; legacy Tell me reads as a level', () => {
    expect(tellMeOf({})).toBe('look')
    expect(parseTellMe('news')).toBe('look')
    expect(parseTellMe('problems')).toBe('needs_you')
    expect(levelNotifies('look', { failed: false, level: 'needs_you' })).toBe(true)
    expect(levelNotifies('look', { failed: false, level: 'look' })).toBe(true)
    // No report counts as worth a look, never quiet.
    expect(levelNotifies('look', { failed: false })).toBe(true)
    expect(levelNotifies('look', { failed: false, level: 'fyi' })).toBe(false)
    expect(levelNotifies('needs_you', { failed: false, level: 'look' })).toBe(false)
    expect(levelNotifies('needs_you', { failed: true, level: 'quiet' })).toBe(true)
    expect(levelNotifies('fyi', { failed: false, level: 'fyi' })).toBe(true)
    expect(levelNotifies('every', { failed: false, level: 'quiet' })).toBe(true)
    expect(tellMeNotifies('look', 'nothing_new')).toBe(false)
  })
})

describe('the scheduler records each run', () => {
  function service() {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const events: ScheduledRunEnded[] = []
    let onRun: (prompt: string) => void = () => undefined
    const scheduler = new ScheduledJobService({
      runIsolated: async (prompt, ingress) => {
        ingress?.onThreadChosen?.('run-thread')
        ingress?.onAdmitted?.('engine-run')
        onRun(prompt)
        return { text: 'Done.', silent: false, threadId: 'run-thread', runId: 'engine-run' }
      }
    }, store)
    ;(scheduler as unknown as { stopped: boolean }).stopped = false
    scheduler.setRunLedger(runs)
    scheduler.on('runEnded', (event: ScheduledRunEnded) => events.push(event))
    const runNow = async (id: string) => {
      scheduler.triggerJob(id)
      await (scheduler as unknown as { tickOwned: () => Promise<void> }).tickOwned()
      await Promise.all([...(scheduler as unknown as { inFlight: Map<string, Promise<void>> }).inFlight.values()])
    }
    return { scheduler, events, runNow, setOnRun: (fn: (prompt: string) => void) => { onRun = fn } }
  }

  it('records the thread and engine run before the turn, takes the report, and notifies as the level says', async () => {
    const { scheduler, events, runNow, setOnRun } = service()
    const job = scheduler.createJob({ name: 'Deps bump', prompt: 'Bump deps', schedule: { kind: 'manual' }, projectId: 'p1', tellMe: 'needs_you' })
    // The run's agent reports during its turn, through the tool's path.
    setOnRun(() => { runs.report({ threadId: 'run-thread', runId: 'engine-run' }, 'fyi', '3 patch updates merged') })
    await runNow(job.id)
    expect(runs.list().runs[0]).toMatchObject({ jobId: job.id, threadId: 'run-thread', state: 'done', level: 'fyi', summary: '3 patch updates merged', projectId: 'p1' })
    expect(events.at(-1)).toMatchObject({ jobId: job.id, outcome: 'done', level: 'fyi', summary: '3 patch updates merged', notify: false })

    setOnRun(() => { runs.report({ threadId: 'run-thread', runId: 'engine-run' }, 'needs_you', 'lodash 5 breaks 2 tests') })
    await runNow(job.id)
    expect(events.at(-1)).toMatchObject({ level: 'needs_you', notify: true })
    expect(runs.counts().byProject.p1).toBe(1)
  })
})

describe('the draft tool in an ordinary chat', () => {
  function drafts() {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const scheduler = new ScheduledJobService({ runIsolated: async () => ({ text: 'Done.', silent: false }) }, store)
    const threads = new Map<string, Thread>([['chat', { id: 'chat', name: 'Fix flaky checkout test', projectId: 'p1' } as Thread]])
    return new AutomationDrafts({
      get: (id) => scheduler.getJob(id),
      list: () => scheduler.listJobs(),
      create: (input) => scheduler.createJob(input),
      update: (id, patch) => scheduler.updateJob(id, patch),
      remove: (id) => scheduler.deleteJob(id),
      pause: (id, reason, until) => scheduler.pauseJob(id, reason, until),
      projects: () => [{ id: 'p1', name: 'mousse' }],
      thread: (id) => threads.get(id),
      personCeiling: () => 'accept_edits',
      reuseThread: (jobId) => ({ id: `thread-for-${jobId}` }),
      meta: { get: (jobId) => runs.meta(jobId), set: (jobId, meta) => runs.setMeta(jobId, meta), move: (from, to) => runs.moveMeta(from, to) }
    })
  }
  const ctx = (threadId: string) => ({ caller: { threadId, runId: 'r1' }, turn: { threadId }, toolCallId: 'c1' }) as unknown as ToolCallContext
  const CHECK = {
    name: 'Flaky checkout check',
    trigger: { kind: 'time', schedule: { kind: 'cron', expr: '0 9 * * *' } },
    prompt: 'Rerun checkout.spec 20 times on main; report only failures.',
    project: 'mousse',
    context: 'Rerun checkout.spec 20× on main; report only failures, with the failing seed and log.'
  }

  it('is offered to a person\'s chat, keeps what "this" meant and where it was made, and only that chat changes its draft', async () => {
    const service = drafts()
    const host: AutomationToolHost = {
      drafts: service,
      isManagerThread: (id) => id === 'manager',
      botOf: () => undefined,
      ordinaryThread: (id) => id === 'chat' || id === 'other-chat'
    }
    const list = automationTools({ automations: () => host } as unknown as AppToolHost)
    const save = list.find((tool) => tool.name === 'automation_draft_save')!
    expect(save.listed!({ threadId: 'chat', readOnly: false, modeCeiling: 'default' } as never)).toBe(true)
    expect(save.listed!({ threadId: 'run-thread', readOnly: false, modeCeiling: 'default' } as never)).toBe(false)
    // The manager's other tools stay the manager's.
    expect(list.find((tool) => tool.name === 'automation_list')!.listed!({ threadId: 'chat', readOnly: false, modeCeiling: 'default' } as never)).toBe(false)

    const result = JSON.parse((await save.handler(CHECK, ctx('chat'))).text) as { draftId: string; problems: string[] }
    expect(result.problems).toEqual([])
    const contract = service.list().find((entry) => entry.id === result.draftId)!
    expect(contract).toMatchObject({ draft: true, context: CHECK.context, createdFrom: { threadId: 'chat' } })
    expect(runs.meta(result.draftId)).toEqual({ originThreadId: 'chat', context: CHECK.context })
    // Another chat cannot change it.
    expect((await save.handler({ ...CHECK, draftId: result.draftId }, ctx('other-chat'))).isError).toBe(true)
    // Turn on keeps where it came from; its runs never post into that chat (a new thread each run).
    const job = service.turnOn(result.draftId)
    expect(job).toMatchObject({ enabled: true, createThread: true })
    expect(job.threadId).toBeUndefined()
    expect(service.contract(job)).toMatchObject({ createdFrom: { threadId: 'chat' }, context: CHECK.context })
  })

  it('offers run_report only while the caller\'s automation run is going', async () => {
    begin('j1', 'k1', { threadId: 'run-thread' })
    runs.update('j1', 'k1', { engineRunId: 'engine-1' })
    const host: AutomationToolHost = {
      drafts: drafts(),
      isManagerThread: () => false,
      botOf: () => undefined,
      runs: { liveRunFor: (caller) => runs.liveRunFor(caller), report: (caller, level, summary) => runs.report(caller, level, summary) }
    }
    const report = automationTools({ automations: () => host } as unknown as AppToolHost).find((tool) => tool.name === 'run_report')!
    expect(report.listed!({ threadId: 'run-thread', readOnly: false, modeCeiling: 'default' } as never)).toBe(true)
    expect(report.listed!({ threadId: 'chat', readOnly: false, modeCeiling: 'default' } as never)).toBe(false)
    const call = { caller: { threadId: 'run-thread', runId: 'engine-1' }, turn: { threadId: 'run-thread' }, toolCallId: 'c' } as unknown as ToolCallContext
    expect(JSON.parse((await report.handler({ level: 'look', summary: 'Two flaky tests' }, call)).text)).toMatchObject({ level: 'look' })
    expect((await report.handler({ level: 'loud', summary: 'x' }, call)).isError).toBe(true)
    runs.finish({ jobId: 'j1', occurrenceKey: 'k1', failed: false })
    expect(report.available!({ threadId: 'run-thread', runId: 'engine-2' } as never)).toMatch(/Only an automation/)
  })
})
