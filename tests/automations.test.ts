import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { botRun, buildAutomationIndex, jobEffectiveMay, type AutomationIndexSources } from '../src/mms/automations/AutomationIndex'
import type { BotAutomationSchedule } from '../src/mms/bots/chat/BotChatService'
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
    const run = (status: BotAutomationSchedule['runs'][number]['status'], endReason?: string) => botRun({ id: 'a', status, at: PAST, ...(endReason ? { endReason } : {}) })
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

function sources(input: { jobs?: ScheduledJob[]; threads?: Thread[]; bots?: BotAutomationSchedule[]; watch?: AutomationIndexSources['watchStatus'] }): AutomationIndexSources {
  const threads = input.threads ?? []
  return {
    jobs: () => input.jobs ?? [],
    thread: (id) => threads.find((thread) => thread.id === id),
    threads: () => threads,
    projectName: (id) => (id === 'p1' ? 'mousse' : undefined),
    threadMode: (threadId) => (threadId === 't-ask' ? 'ask' : 'accept_edits'),
    ...(input.bots ? { bots: () => input.bots! } : {}),
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
    const bot: BotAutomationSchedule = {
      botId: 'bot-1', botName: 'Pip', look: { colour: 'cream', accessory: 'none' }, paused: false, scheduleId: 'weather', label: 'every day · 08:00',
      prompt: 'Weather\nTell me if it rains', createdBy: 'bot', nextAt: '2026-11-09T02:30:00.000Z',
      runs: [{ id: 'act_1', status: 'waiting_grant', at: PAST }], ask: { text: 'read files in Notes', activationId: 'act_1' }
    }
    const index = buildAutomationIndex(sources({
      jobs: [job({ projectId: 'p1', tellMe: 'problems' })],
      threads: [watching, unwatched],
      bots: [bot],
      watch: () => ({ state: 'watching', nextCheckAt: '2026-11-08T10:05:00.000Z' })
    }))
    expect(index.computer).toEqual({ name: 'Desk', timeZone: 'Asia/Kolkata' })
    expect(index.items.map((item) => item.key)).toEqual(['job:j1', 'bot:bot-1:weather', 'watch:t-watch'])
    const [jobItem, botItem, watchItem] = index.items
    expect(jobItem).toMatchObject({ trigger: 'time', where: { projectId: 'p1', name: 'mousse' }, tellMe: 'problems', may: 'accept_edits', next: { timeZone: 'Asia/Kolkata' }, link: { kind: 'job', jobId: 'j1' } })
    // The Incomplete run and the ask that stopped it are one Needs you item.
    // A bot row is named by its schedule's short label, as the bot's own Runs list names it.
    expect(botItem).toMatchObject({ name: 'every day · 08:00', who: { kind: 'bot', name: 'Pip' }, mayIsGrant: true, attention: { kind: 'ask', text: 'Wants to read files in Notes' }, link: { kind: 'bot', botId: 'bot-1' } })
    expect(watchItem).toMatchObject({ trigger: 'thread_event', notifyOnly: true, whenText: 'PR #742', link: { kind: 'thread', threadId: 't-watch' } })
  })

  it('names a source it cannot read instead of showing it empty', () => {
    const index = buildAutomationIndex({ ...sources({}), bots: () => { throw new Error('bots.db is locked') } })
    expect(index.unavailable).toEqual(['bots'])
  })

  it('shows the effective May: the strictest of the job, its ceiling and its thread, and none for a workflow', () => {
    expect(jobEffectiveMay(job({ permissionMode: 'full', permissionCeiling: 'auto' }), 'accept_edits')).toBe('accept_edits')
    expect(jobEffectiveMay(job({ permissionCeiling: 'ask' }), 'full')).toBe('ask')
    expect(jobEffectiveMay(job({}), 'auto')).toBe('auto')
    expect(jobEffectiveMay(job({ prompt: '/release-notes' }), 'auto')).toBeUndefined()
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
