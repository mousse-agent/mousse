import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { missedWhileOffline, recordTickerHeartbeat, ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { askText, botRun, buildAutomationIndex, jobEffectiveMay, type AutomationIndexSources } from '../src/mms/automations/AutomationIndex'
import { AgentJobAskStore } from '../src/mms/automations/AgentJobAsks'
import type { BotAutomationFacts } from '../src/mms/bots/chat/BotChatService'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import {
  attentionOf,
  jobActiveRun,
  jobLastEndedRun,
  jobRecordRun,
  occurrenceOutcome,
  tellMeNotifies,
  type ScheduledRunEnded
} from '../src/shared/automations'
import { tellMeOf, type ScheduledJob, type Thread } from '../src/shared/types'

const PAST = '2026-01-01T00:00:00.000Z'

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'j1',
    name: 'Nightly',
    prompt: 'Check CI',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    state: 'scheduled',
    nextRunAt: '2026-11-08T11:00:00.000Z',
    createdAt: PAST,
    updatedAt: PAST,
    ...patch
  }
}

describe('the Run contract', () => {
  it('maps job run records onto end and active states', () => {
    expect(jobRecordRun({ runAt: PAST, status: 'ok' }).state).toBe('done')
    expect(jobRecordRun({ runAt: PAST, status: 'ok', silent: true }).state).toBe('nothing_new')
    expect(jobRecordRun({ runAt: PAST, status: 'error', error: 'npm install exited 1' })).toMatchObject({ state: 'failed', detail: 'npm install exited 1' })
    expect(jobRecordRun({ runAt: PAST, status: 'interrupted' }).state).toBe('failed')
    expect(jobRecordRun({ runAt: PAST, status: 'uncertain' }).state).toBe('failed')
    expect(jobRecordRun({ runAt: PAST, status: 'queued' })).toMatchObject({ state: 'waiting', reason: 'behind' })
    expect(jobRecordRun({ runAt: PAST, status: 'waiting', usageLimitUntil: '2026-01-01T14:00:00.000Z' })).toMatchObject({ state: 'waiting', reason: 'usage_limit', until: '2026-01-01T14:00:00.000Z' })
    // A workflow that stopped at an approval node waits for the person: it ended Incomplete.
    expect(jobRecordRun({ runAt: PAST, status: 'waiting', output: 'Workflow x\nRun: r\nRevision: v\nState: waiting-approval' }).state).toBe('incomplete')
    expect(occurrenceOutcome('waiting')).toBeNull()
  })

  it('reads what a job is doing now: running, waiting behind its thread, queued, or nothing', () => {
    expect(jobActiveRun(job({ liveStatus: 'running', liveThreadId: 't1' }))).toMatchObject({ state: 'running', threadId: 't1' })
    expect(jobActiveRun(job({ pendingOccurrence: { occurrenceKey: 'k', threadId: 't1', runId: 'r', state: 'queued' } }))).toMatchObject({ state: 'waiting', reason: 'behind' })
    expect(jobActiveRun(job({ waitingBehind: { threadId: 't1', since: PAST } }))).toMatchObject({ state: 'waiting', reason: 'behind', threadId: 't1' })
    expect(jobActiveRun(job({ state: 'running' }))?.state).toBe('queued')
    expect(jobActiveRun(job({ runHistory: [{ runAt: PAST, status: 'waiting', usageLimitUntil: '2026-01-02T00:00:00.000Z' }] }))).toMatchObject({ state: 'waiting', reason: 'usage_limit' })
    expect(jobActiveRun(job({ runHistory: [{ runAt: PAST, status: 'ok' }] }))).toBeUndefined()
  })

  it('maps bot activations onto the contract', () => {
    const run = (status: BotAutomationFacts['runs'][number]['status'], endReason?: string) => botRun({ id: 'a', status, at: PAST, ...(endReason ? { endReason } : {}) })
    expect(run('queued').state).toBe('queued')
    expect(run('running').state).toBe('running')
    expect(run('waiting_grant').state).toBe('incomplete')
    expect(run('paused')).toMatchObject({ state: 'waiting', reason: 'usage_limit' })
    expect(run('done').state).toBe('done')
    expect(run('failed', 'provider_error')).toMatchObject({ state: 'failed', detail: 'Provider error' })
  })
})

describe('Needs you', () => {
  it('holds exactly open asks and runs that ended Failed or Incomplete; waiting never counts', () => {
    expect(attentionOf({ ask: { text: 'Wants to run gh pr merge' } })?.kind).toBe('ask')
    expect(attentionOf({ last: { at: PAST, state: 'failed', detail: 'boom' } })).toMatchObject({ kind: 'failed', text: 'boom' })
    expect(attentionOf({ last: { at: PAST, state: 'incomplete' } })?.kind).toBe('incomplete')
    expect(attentionOf({ last: { at: PAST, state: 'done' } })).toBeUndefined()
    expect(attentionOf({ last: { at: PAST, state: 'nothing_new' } })).toBeUndefined()
    expect(attentionOf({})).toBeUndefined()
  })

  it('clears a failure once a later run succeeds, and is not raised by a run that waits', () => {
    const failedThenOk = job({ runHistory: [{ runAt: PAST, status: 'error', error: 'x' }, { runAt: '2026-01-02T00:00:00.000Z', status: 'ok', silent: true }] })
    expect(jobLastEndedRun(failedThenOk)?.state).toBe('nothing_new')
    const okThenWaiting = job({ runHistory: [{ runAt: PAST, status: 'ok' }, { runAt: '2026-01-02T00:00:00.000Z', status: 'waiting', usageLimitUntil: '2026-01-03T00:00:00.000Z' }] })
    expect(jobLastEndedRun(okThenWaiting)?.state).toBe('done')
    const index = buildAutomationIndex(sources({ jobs: [okThenWaiting, job({ id: 'j2', runHistory: [{ runAt: PAST, status: 'error', error: 'x' }] })] }))
    expect(index.items.find((item) => item.id === 'j1')?.attention).toBeUndefined()
    expect(index.items.find((item) => item.id === 'j1')?.active).toMatchObject({ state: 'waiting', reason: 'usage_limit' })
    expect(index.items.find((item) => item.id === 'j2')?.attention).toMatchObject({ kind: 'failed' })
  })
})

describe('Tell me', () => {
  it('notifies every run, only news, or only problems', () => {
    expect(tellMeNotifies('every', 'nothing_new')).toBe(true)
    expect(tellMeNotifies('news', 'nothing_new')).toBe(false)
    expect(tellMeNotifies('news', 'done')).toBe(true)
    expect(tellMeNotifies('news', 'failed')).toBe(true)
    expect(tellMeNotifies('problems', 'done')).toBe(false)
    expect(tellMeNotifies('problems', 'incomplete')).toBe(true)
  })

  it('reads a job saved before Tell me, or with a value it does not know, as Only news', () => {
    expect(tellMeOf({})).toBe('news')
    expect(tellMeOf({ tellMe: 'loud' })).toBe('news')
    expect(tellMeOf({ tellMe: 'problems' })).toBe('problems')
  })

  it('is accepted on create and change, and nothing else is', () => {
    expect(asCreateScheduledJobInput({ name: 'a', prompt: 'b', schedule: { kind: 'manual' }, tellMe: 'every' }).tellMe).toBe('every')
    expect(asScheduledJobPatch({ tellMe: 'problems' }).tellMe).toBe('problems')
    expect(() => asScheduledJobPatch({ tellMe: 'loud' })).toThrow(/every\|news\|problems/)
  })
})

function sources(input: { jobs?: ScheduledJob[]; threads?: Thread[]; bots?: Record<string, BotAutomationFacts>; watch?: AutomationIndexSources['watchStatus'] }): AutomationIndexSources {
  const threads = input.threads ?? []
  return {
    jobs: () => input.jobs ?? [],
    thread: (id) => threads.find((thread) => thread.id === id),
    threads: () => threads,
    projectName: (id) => (id === 'p1' ? 'mousse' : undefined),
    threadMode: (threadId) => (threadId === 't-ask' ? 'ask' : 'accept_edits'),
    ...(input.bots ? { bot: (botId: string) => input.bots![botId] } : {}),
    ...(input.watch ? { watchStatus: input.watch } : {}),
    computerName: 'Desk',
    timeZone: 'Asia/Kolkata',
    now: () => new Date('2026-11-08T10:00:00.000Z')
  }
}

describe('the automation index', () => {
  it('lists jobs, bot schedules and pull request watches in one list, each with what opens it', () => {
    const watching = { id: 't-watch', name: 'Fix CI on #742', projectId: 'p1', pullRequest: { number: 742, watch: 'notify' } } as unknown as Thread
    const unwatched = { id: 't-plain', name: 'Plain', pullRequest: { number: 1 } } as unknown as Thread
    const pip: BotAutomationFacts = {
      botName: 'Pip', look: { colour: 'cream', accessory: 'none' }, paused: false,
      runs: [{ id: 'act_1', status: 'waiting_grant', at: PAST }], ask: { text: 'read files in Notes', activationId: 'act_1', askId: 'esc_1' }
    }
    // A bot's schedule is a job whose Who is the bot: the same record and row as any job.
    const weather = job({ id: 'bot-1--weather', name: 'Weather', prompt: 'Weather\nTell me if it rains', schedule: { kind: 'cron', expr: '0 8 * * *' }, nextRunAt: '2026-11-09T02:30:00.000Z', bot: { botId: 'bot-1', scheduleId: 'weather', createdBy: 'bot' } })
    const index = buildAutomationIndex(sources({
      jobs: [job({ projectId: 'p1', tellMe: 'problems' }), weather],
      threads: [watching, unwatched],
      bots: { 'bot-1': pip },
      watch: () => ({ state: 'watching', nextCheckAt: '2026-11-08T10:05:00.000Z' })
    }))
    expect(index.computer).toEqual({ name: 'Desk', timeZone: 'Asia/Kolkata' })
    expect(index.items.map((item) => item.key)).toEqual(['job:j1', 'job:bot-1--weather', 'watch:t-watch'])
    const [jobItem, botItem, watchItem] = index.items
    expect(jobItem).toMatchObject({ trigger: 'time', where: { projectId: 'p1', name: 'mousse' }, tellMe: 'problems', may: 'accept_edits', next: { timeZone: 'Asia/Kolkata' }, link: { kind: 'job', jobId: 'j1' } })
    // The Incomplete run and the ask that stopped it are one Needs you item, answered in place with the bot's method.
    expect(botItem).toMatchObject({
      kind: 'job', name: 'Weather', schedule: { kind: 'cron', expr: '0 8 * * *' }, who: { kind: 'bot', name: 'Pip' }, mayIsGrant: true, tellMe: 'news',
      next: { at: '2026-11-09T02:30:00.000Z' },
      attention: { kind: 'ask', text: 'Wants to read files in Notes', answer: { kind: 'bot_ask', botId: 'bot-1', askId: 'esc_1' } },
      link: { kind: 'job', jobId: 'bot-1--weather', botId: 'bot-1' }
    })
    expect(botItem!.may).toBeUndefined()
    expect(watchItem).toMatchObject({ trigger: 'thread_event', notifyOnly: true, whenText: 'PR #742', link: { kind: 'thread', threadId: 't-watch' } })
  })

  it('names a saved agent as Who, with its May its own grants, and a gone one as Removed agent', () => {
    const index = buildAutomationIndex({
      ...sources({ jobs: [job({ agent: { definitionId: 'agent-1' }, permissionMode: 'full', permissionCeiling: 'full' }), job({ id: 'j2', agent: { definitionId: 'gone' } })] }),
      savedAgentName: (id) => (id === 'agent-1' ? 'PR reviewer' : undefined)
    })
    expect(index.items[0]).toMatchObject({ who: { kind: 'saved_agent', name: 'PR reviewer', definitionId: 'agent-1' }, mayIsGrant: true })
    expect(index.items[0]!.may).toBeUndefined()
    expect(index.items[1]!.who).toMatchObject({ kind: 'saved_agent', name: 'Removed agent' })
  })

  it('names a source it cannot read instead of showing it empty', () => {
    const botJob = job({ id: 'b--s', bot: { botId: 'b', scheduleId: 's', createdBy: 'owner' } })
    const index = buildAutomationIndex({ ...sources({ jobs: [job({}), botJob] }), bot: () => { throw new Error('bots.db is locked') } })
    expect(index.unavailable).toEqual(['bots'])
    expect(index.items.map((item) => item.key)).toEqual(['job:j1'])
  })

  it('a bot paused by itself shows its rows paused, resumed from the bot; a deleted bot takes its rows away', () => {
    const botJob = job({ id: 'b--s', bot: { botId: 'b', scheduleId: 's', createdBy: 'owner' } })
    const paused: BotAutomationFacts = { botName: 'Pip', look: { colour: 'cream', accessory: 'none' }, paused: true, pausedText: 'Paused until 14:00', runs: [] }
    expect(buildAutomationIndex(sources({ jobs: [botJob], bots: { b: paused } })).items[0]).toMatchObject({ paused: true, pausedBy: 'bot', pausedReason: 'Paused until 14:00' })
    expect(buildAutomationIndex(sources({ jobs: [botJob], bots: {} })).items).toEqual([])
  })

  it('shows the effective May: the strictest of the job, its ceiling and its thread, for a workflow too (#338)', () => {
    expect(jobEffectiveMay(job({ permissionMode: 'full', permissionCeiling: 'auto' }), 'accept_edits')).toBe('accept_edits')
    expect(jobEffectiveMay(job({ permissionCeiling: 'ask' }), 'full')).toBe('ask')
    expect(jobEffectiveMay(job({}), 'auto')).toBe('auto')
    expect(jobEffectiveMay(job({ prompt: '/release-notes', permissionCeiling: 'ask' }), 'auto')).toBe('ask')
  })

  it('gives a request automation its URL and delivery log, and Resend only where a stored payload ran', () => {
    const delivered = job({
      schedule: { kind: 'manual' },
      nextRunAt: null,
      trigger: { webhook: { scheme: 'mousse', secretRef: 'scheduled-webhook-j1', createdAt: PAST } },
      runHistory: [{ runAt: PAST, status: 'ok', occurrenceKey: 'webhook:occ-1' }, { runAt: PAST, status: 'ok', occurrenceKey: 'webhook:occ-0' }]
    })
    const index = buildAutomationIndex({
      ...sources({ jobs: [delivered] }),
      requestUrl: (id) => `http://127.0.0.1:18790/hooks/${id}`,
      deliveries: () => [
        { occurrenceId: 'occ-1', receivedAt: '2026-11-08T09:00:00.000Z', outcome: 'completed', bodyBytes: 12, missingPlaceholders: ['body.pr'] },
        { receivedAt: '2026-11-08T08:59:00.000Z', outcome: 'rejected_signature', bodyBytes: 3 },
        { occurrenceId: 'occ-0', receivedAt: '2026-11-08T08:00:00.000Z', outcome: 'completed', bodyBytes: 2, resentFrom: 'occ-x' }
      ],
      payloadKept: (_job, occurrenceId) => occurrenceId === 'occ-1'
    })
    const [row] = index.items
    expect(row).toMatchObject({ trigger: 'request', request: { url: 'http://127.0.0.1:18790/hooks/j1' } })
    expect(row!.request!.deliveries).toEqual([
      { at: '2026-11-08T09:00:00.000Z', outcome: 'completed', bytes: 12, missing: ['body.pr'], occurrenceId: 'occ-1', resendable: true },
      { at: '2026-11-08T08:59:00.000Z', outcome: 'rejected_signature', bytes: 3 },
      { at: '2026-11-08T08:00:00.000Z', outcome: 'completed', bytes: 2, occurrenceId: 'occ-0', resent: true }
    ])
    expect(row!.runs.map((run) => run.request)).toEqual([{ occurrenceId: 'occ-0' }, { occurrenceId: 'occ-1', resendable: true }])
    // An agent-added one before Keep cannot be resent.
    const unkept = buildAutomationIndex({ ...sources({ jobs: [{ ...delivered, createdBy: { threadId: 't' }, expiresAt: '2026-11-15T00:00:00.000Z' }] }), requestUrl: () => 'u', deliveries: () => [{ occurrenceId: 'occ-1', receivedAt: PAST, outcome: 'completed', bodyBytes: 1 }], payloadKept: () => true })
    expect(unkept.items[0]!.request!.deliveries[0]!.resendable).toBeUndefined()
  })

  it('marks a paused job with the time it resumes, and gives it no next run', () => {
    const index = buildAutomationIndex(sources({ jobs: [job({ state: 'paused', enabled: false, resumeAt: '2026-11-10T03:30:00.000Z' })] }))
    expect(index.items[0]).toMatchObject({ paused: true, pausedUntil: '2026-11-10T03:30:00.000Z' })
    expect(index.items[0]?.next).toBeUndefined()
  })
})

describe('the scheduler', () => {
  let home: string
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env.MOUSSE_HOME
    home = mkdtempSync(join(tmpdir(), 'mousse-automations-'))
    process.env.MOUSSE_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const tick = (service: ScheduledJobService) => (service as unknown as { tickOwned: () => Promise<void> }).tickOwned()
  const settle = async (service: ScheduledJobService) => {
    await Promise.all([...(service as unknown as { inFlight: Map<string, Promise<void>> }).inFlight.values()])
  }
  const start = (service: ScheduledJobService) => { (service as unknown as { stopped: boolean }).stopped = false }

  it('keeps Tell me through a reload, and writes nothing for a job that never chose one', () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const chosen = store.createJob({ name: 'Loud', prompt: 'x', schedule: { kind: 'manual' }, tellMe: 'every' })
    const plain = store.createJob({ name: 'Plain', prompt: 'x', schedule: { kind: 'manual' } })
    const reloaded = new ScheduledJobStore(MousseConfigStore.load(home))
    expect(reloaded.getJob(chosen.id)?.tellMe).toBe('every')
    expect(reloaded.getJob(plain.id)?.tellMe).toBeUndefined()
    expect(MousseConfigStore.load(home).getScheduledSection().jobs.find((entry) => entry.id === plain.id)).not.toHaveProperty('tellMe')
  })

  it('pauses until a time, then resumes on its own once that time has come', () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const created = store.createJob({ name: 'Vacation', prompt: 'x', schedule: { kind: 'interval', minutes: 60 } })
    const until = new Date(Date.now() + 60_000).toISOString()
    store.pauseJob(created.id, undefined, until)
    expect(store.getJob(created.id)).toMatchObject({ state: 'paused', resumeAt: until })
    store.claimDueJobs(new Date())
    expect(store.getJob(created.id)?.state).toBe('paused')
    store.claimDueJobs(new Date(Date.now() + 120_000))
    expect(store.getJob(created.id)).toMatchObject({ state: 'scheduled', enabled: true })
    expect(store.getJob(created.id)?.resumeAt).toBeUndefined()
    // A pause without an end clears an earlier one; Resume clears it too.
    store.pauseJob(created.id, undefined, until)
    store.pauseJob(created.id)
    expect(store.getJob(created.id)?.resumeAt).toBeUndefined()
  })

  it('keeps an occurrence whose thread is busy due, with its repeat, and runs it on a later tick (#404)', async () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    let busy = true
    const calls: string[] = []
    const service = new ScheduledJobService({
      runIsolated: async (prompt, ingress) => {
        calls.push(prompt)
        return busy ? { text: '', silent: false, status: 'busy', threadId: ingress?.threadId } : { text: 'Done it.', silent: false }
      }
    }, store)
    start(service)
    const created = store.createJob({ name: 'Workflow', prompt: '/report', schedule: { kind: 'interval', minutes: 60 }, threadId: 't-shared', repeat: { times: 2 } })
    store.updateJob(created.id, { nextRunAt: PAST, state: 'scheduled' })

    await tick(service)
    await settle(service)
    expect(store.getJob(created.id)).toMatchObject({ state: 'scheduled', nextRunAt: PAST, repeat: { times: 2, completed: 0 }, waitingBehind: { threadId: 't-shared' } })
    expect(store.getJob(created.id)?.runHistory).toEqual([])
    expect(store.getJob(created.id)?.runClaim).toBeUndefined()

    busy = false
    await tick(service)
    await settle(service)
    const after = store.getJob(created.id)!
    expect(calls).toHaveLength(2)
    expect(after.runHistory).toEqual([expect.objectContaining({ status: 'ok' })])
    expect(after.repeat).toMatchObject({ completed: 1 })
    expect(after.waitingBehind).toBeUndefined()
    service.stop()
  })

  it('collapses the repeats missed while the computer was off into one run, marked, that runs once', async () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const prompts: string[] = []
    const service = new ScheduledJobService({ runIsolated: async (prompt) => { prompts.push(prompt); return { text: 'Bumped.', silent: false } } }, store)
    start(service)
    const daily = store.createJob({ name: 'Deps bump', prompt: 'bump', schedule: { kind: 'cron', expr: '0 3 * * *' } })
    const onTime = store.createJob({ name: 'On time', prompt: 'look', schedule: { kind: 'interval', minutes: 60 } })
    // Off for three days and a bit: the 03:00 four days ago was the one due when it stopped.
    const now = new Date()
    const firstMissed = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4, 3, 0)
    store.updateJob(daily.id, { nextRunAt: firstMissed.toISOString(), state: 'scheduled' })
    store.updateJob(onTime.id, { nextRunAt: new Date(now.getTime() - 60_000).toISOString(), state: 'scheduled' })
    // Its last tick before it stopped, persisted then.
    recordTickerHeartbeat(true, home, new Date(firstMissed.getTime() - 30_000))
    await tick(service)
    await settle(service)
    expect(prompts.filter((prompt) => prompt.includes('bump'))).toHaveLength(1)
    const after = store.getJob(daily.id)!
    expect(after.runHistory).toHaveLength(1)
    const missed = after.runHistory![0]!.missed!
    expect(missed.since).toBe(firstMissed.toISOString())
    expect(missed.count).toBeGreaterThanOrEqual(4)
    expect(missed.count).toBeLessThanOrEqual(5)
    expect(jobRecordRun(after.runHistory![0]!)).toMatchObject({ state: 'done', missed: { count: missed.count } })
    // The next run is the first after now: nothing of the backlog is left to run.
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.now())
    // A run a minute late was not missed.
    expect(store.getJob(onTime.id)!.runHistory![0]!.missed).toBeUndefined()
    service.stop()
  })

  it('never marks a run a busy scheduler delayed as missed while offline, however late', async () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const prompts: string[] = []
    const service = new ScheduledJobService({ runIsolated: async (prompt) => { prompts.push(prompt); return { text: 'Done.', silent: false } } }, store)
    start(service)
    const late = store.createJob({ name: 'Late', prompt: 'late', schedule: { kind: 'interval', minutes: 60 } })
    // Due 40 minutes ago, while the scheduler kept ticking (its last tick a minute ago): busy, not offline.
    const now = Date.now()
    store.updateJob(late.id, { nextRunAt: new Date(now - 40 * 60_000).toISOString(), state: 'scheduled' })
    recordTickerHeartbeat(true, home, new Date(now - 60_000))
    await tick(service)
    await settle(service)
    expect(prompts).toEqual(['late'])
    expect(store.getJob(late.id)!.runHistory![0]!.missed).toBeUndefined()
    service.stop()
  })

  it('counts the missed repeats of an interval and a cron, and never a job that runs on demand', () => {
    const now = new Date('2026-11-09T12:00:00.000Z')
    const down = { from: '2026-10-31T00:00:00.000Z', to: now.toISOString() }
    expect(missedWhileOffline({ schedule: { kind: 'interval', minutes: 60 } }, '2026-11-09T09:00:00.000Z', now, down)).toEqual({ count: 4, since: '2026-11-09T09:00:00.000Z' })
    expect(missedWhileOffline({ schedule: { kind: 'interval', minutes: 60 } }, '2026-11-09T11:58:00.000Z', now, down)).toBeUndefined()
    expect(missedWhileOffline({ schedule: { kind: 'manual' } }, '2026-11-01T00:00:00.000Z', now, down)).toBeUndefined()
    expect(missedWhileOffline({ schedule: { kind: 'once', runAt: '2026-11-08T00:00:00.000Z' } }, '2026-11-08T00:00:00.000Z', now, down)).toMatchObject({ count: 1 })
    // An every-minute repeat after a long time off stops counting at 1000.
    expect(missedWhileOffline({ schedule: { kind: 'cron', expr: '* * * * *' } }, '2026-11-01T00:00:00.000Z', now, down)?.count).toBe(1000)
    // Late but due while the scheduler was ticking (before the gap, or with no gap at all): never missed.
    expect(missedWhileOffline({ schedule: { kind: 'interval', minutes: 60 } }, '2026-11-09T09:00:00.000Z', now)).toBeUndefined()
    expect(missedWhileOffline({ schedule: { kind: 'interval', minutes: 60 } }, '2026-11-09T09:00:00.000Z', now, { from: '2026-11-09T10:00:00.000Z', to: now.toISOString() })).toBeUndefined()
  })

  it('announces how each run ended once, with whether its Tell me lets it notify', async () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const replies = ['[SILENT]', 'Two new comments.']
    const service = new ScheduledJobService({ runIsolated: async () => ({ text: replies.shift()!, silent: false }) }, store)
    start(service)
    const ended: ScheduledRunEnded[] = []
    service.on('runEnded', (event: ScheduledRunEnded) => ended.push(event))
    const created = store.createJob({ name: 'News', prompt: 'look', schedule: { kind: 'interval', minutes: 60 } })
    for (const due of [PAST, '2026-01-01T01:00:00.000Z']) {
      store.updateJob(created.id, { nextRunAt: due, state: 'scheduled' })
      await tick(service)
      await settle(service)
    }
    expect(ended.map((event) => [event.outcome, event.notify])).toEqual([['nothing_new', false], ['done', true]])
    expect(store.getJob(created.id)?.runHistory?.map((record) => jobRecordRun(record).state)).toEqual(['nothing_new', 'done'])
    service.stop()
  })
})

describe('the first-creation ask', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mousse-agent-asks-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })
  const job = { name: 'Check PR #42', prompt: 'Check PR #42 for new review comments', schedule: { kind: 'interval' as const, minutes: 30 }, createdBy: { threadId: 't1', requestId: 'k1' } }

  it('is durable, asked once per call, and Allow makes the automation and lets the thread add more', () => {
    const store = new AgentJobAskStore(home)
    const ask = store.ask({ threadId: 't1', requestKey: 'k1', job })
    expect(store.ask({ threadId: 't1', requestKey: 'k1', job }).id).toBe(ask.id)
    // Another store over the same folder (a daemon restart) still has it.
    const again = new AgentJobAskStore(home)
    expect(again.open().map((entry) => entry.id)).toEqual([ask.id])
    expect(again.threadAllowed('t1')).toBe(false)
    const created: string[] = []
    const answered = again.answer(ask.id, 'allow', (entry) => { created.push(entry.input.name); return { id: 'job-1' } })
    expect(answered).toMatchObject({ state: 'allowed', jobId: 'job-1' })
    expect(created).toEqual(['Check PR #42'])
    expect(again.threadAllowed('t1')).toBe(true)
    expect(again.open()).toEqual([])
    expect(() => again.answer(ask.id, 'allow', () => ({ id: 'x' }))).toThrow(/already answered/)
  })

  it('Not now closes it and allows nothing; a refused Allow (a limit) leaves it open', () => {
    const store = new AgentJobAskStore(home)
    const ask = store.ask({ threadId: 't1', requestKey: 'k1', job })
    expect(() => store.answer(ask.id, 'allow', () => { throw new Error('Agents already have 10 active automations') })).toThrow(/10 active/)
    expect(store.open()).toHaveLength(1)
    expect(store.answer(ask.id, 'not_now', () => { throw new Error('not called') })).toMatchObject({ state: 'declined' })
    expect(store.threadAllowed('t1')).toBe(false)
  })

  it('is one Needs you item that says who wants what, and when', () => {
    const store = new AgentJobAskStore(home)
    store.ask({ threadId: 't1', requestKey: 'k1', job })
    const reviewer = { id: 't1', name: 'Reviewer' } as unknown as Thread
    const index = buildAutomationIndex({ ...sources({ threads: [reviewer] }), asks: () => store.open() })
    expect(index.items).toHaveLength(1)
    expect(index.items[0]).toMatchObject({ kind: 'ask', name: 'Check PR #42', attention: { kind: 'ask', threadId: 't1' }, link: { kind: 'ask', threadId: 't1' } })
    expect(index.items[0]!.attention!.text).toBe(askText(store.open()[0]!, 'Reviewer', new Date('2026-11-08T10:00:00.000Z')))
    expect(index.items[0]!.attention!.text).toMatch(/^Reviewer wants to check PR #42 for new review comments every 30 min$/i)
  })
})
