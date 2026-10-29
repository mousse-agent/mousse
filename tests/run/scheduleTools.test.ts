/**
 * `schedule_list`, `schedule_create`, `schedule_update`, `schedule_pause` and `schedule_run` through the registry's
 * central check (docs/run-engine/SPEC.md §15.1), over a real scheduled-job store: the `manage` agent access level and
 * the `scheduled.agentJobs` setting, that only a turn a person started may create or start jobs, that an agent sees and
 * changes only the jobs its own thread made, what a job records of its creator, that an agent can never raise a job's
 * limits, the total cap, the lifetime and the cadence floor, Run now's refusals, and that every change is recorded.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { McpToolError, type AgentScheduleHost, type McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { AGENT_JOB_LIMIT_DEFAULTS } from '../../src/mms/scheduled/agentJobLimits'
import { ScheduledJobStore } from '../../src/mms/scheduled/ScheduledJobStore'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { AgentAccessLevel, AgentAccessSettings } from '../../src/shared/settings'
import type { ScheduledJob, Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-27T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
const profile = (patch: Partial<AgentAccessSettings> = {}): AgentAccessSettings => ({ level: 'manage', projectIds: [], answerApprovals: false, ...patch })
const TOOLS = ['schedule_create', 'schedule_list', 'schedule_pause', 'schedule_run', 'schedule_update']
/** What the profile allows until a person changes it. */
const { maxActive: MAX_ACTIVE, minIntervalMinutes: MIN_INTERVAL, lifetimeDays: LIFETIME_DAYS } = AGENT_JOB_LIMIT_DEFAULTS
const CREATE = { name: 'Nightly report', prompt: 'Write the nightly report', schedule: { kind: 'interval', minutes: 30 } }

describe('the schedule tools (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  let home: string | undefined
  let previousHome: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /**
   * `caller` holds a live run in project p1. `state` is what the profile says now (setting, limits, whether a person
   * started the run): read at every call. The jobs live in a real store, so what a call changes is what a reload would find.
   */
  const world = async (initial: Partial<AgentAccessSettings> = {}) => {
    fx = delegationFixture()
    home = mkdtempSync(join(tmpdir(), 'mousse-schedule-tools-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const callerRun = await fx.runningRun('caller')
    const jobs = new ScheduledJobStore(MousseConfigStore.load(home))
    const state = {
      profile: profile(initial),
      enabled: true,
      /** Whether a person started the calling run (`startedByPerson`); the real rule is tested against a daemon. */
      person: true,
      limits: { accessCap: 'manage' as AgentAccessLevel, permissionCeiling: 'full' as PermissionMode },
      /** The limits on agent jobs a person set (`scheduled.agentJob*`): read at every call. */
      jobLimits: { ...AGENT_JOB_LIMIT_DEFAULTS }
    }
    const threads = new Map<string, Thread>([
      ['caller', thread('caller')],
      ['second', thread('second')],
      ['elsewhere', thread('elsewhere', { projectId: 'p2' })]
    ])
    const botThreads = new Set<string>()
    const readOnly = new Set<string>()
    const woke = vi.fn()
    const schedules = {
      enabled: vi.fn(() => state.enabled),
      jobLimits: vi.fn(() => ({ ...state.jobLimits })),
      list: vi.fn(() => jobs.listJobs()),
      get: vi.fn((id: string) => jobs.getJob(id)),
      validate: vi.fn((): { selection?: never; threadId?: string } => ({})),
      startedByPerson: vi.fn(() => state.person),
      limits: vi.fn(() => state.limits),
      create: vi.fn((input: Parameters<ScheduledJobStore['createJob']>[0]) => jobs.createJob(input)),
      update: vi.fn((id: string, patch: Partial<ScheduledJob>) => jobs.updateJob(id, patch)),
      pause: vi.fn((id: string, reason?: string) => jobs.pauseJob(id, reason)),
      trigger: vi.fn((id: string) => jobs.triggerJob(id)),
      wake: woke
    } satisfies AgentScheduleHost
    const recordAgentAction = vi.fn()
    const fake = fakeAppToolHost({
      agentAccess: () => state.profile,
      threadMeta: (id) => threads.get(id),
      botRole: (id) => (botThreads.has(id) ? 'activation' : undefined),
      readOnlyThread: (id) => readOnly.has(id),
      recordAgentAction,
      schedules
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const as = (granted: AgentAccessLevel, extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: callerRun.runId, accessLevel: granted, ...extra })
    const call = (name: string, args: Record<string, unknown> = {}, granted: AgentAccessLevel = 'manage', extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call(name, args, as(granted, extra))
    const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text)
    /** A job made by a call of `caller`, as stored. */
    const create = async (extra: Record<string, unknown> = {}, granted: AgentAccessLevel = 'manage') => (await result(call('schedule_create', { ...CREATE, ...extra }, granted))).job as { id: string }
    const stored = (id: string): ScheduledJob => jobs.getJob(id)!
    /** A job a person made (no creator). */
    const personJob = (extra: Partial<Parameters<ScheduledJobStore['createJob']>[0]> = {}) => jobs.createJob({ name: 'By a person', prompt: 'Do it', schedule: { kind: 'manual' }, ...extra })
    /** A job another thread's agent made. */
    const otherJob = (extra: Partial<Parameters<ScheduledJobStore['createJob']>[0]> = {}) =>
      jobs.createJob({ name: 'By another agent', prompt: 'Do it', schedule: { kind: 'manual' }, createdBy: { threadId: 'someone-else', runId: 'r' }, ...extra })
    return { fx, jobs, state, threads, botThreads, readOnly, schedules, woke, recordAgentAction, registry, request, turns, callerRun, call, as, denied, result, create, stored, personJob, otherJob, ...fake }
  }

  describe('the access level and the setting', () => {
    it.each(['lineage', 'read'] as const)('a credential granted %s is refused all five tools before anything runs', async (level) => {
      const { call, denied, schedules, jobs } = await world()
      for (const name of TOOLS) {
        const error = await denied(call(name, { ...CREATE, jobId: 'x' }, level))
        expect(error, name).toBeInstanceOf(McpToolError)
        expect(error!.code, name).toBe('mousse_scope_denied')
        expect(error!.message, name).toMatch(new RegExp(`needs the "manage" agent access level \\(yours is "${level}"\\)`))
      }
      expect(schedules.create).not.toHaveBeenCalled()
      expect(jobs.listJobs()).toEqual([])
    })

    it('a manage credential under a profile that was lowered is refused at once', async () => {
      const { call, denied, state, create } = await world()
      await create()
      state.profile = profile({ level: 'read' })
      for (const name of TOOLS) expect((await denied(call(name, { ...CREATE, jobId: 'x' })))!.code, name).toBe('mousse_scope_denied')
    })

    it('with "Agents may create jobs" off every tool says so, does nothing and is not listed', async () => {
      const { call, registry, state, jobs, schedules } = await world()
      state.enabled = false
      expect(registry.listForThread('caller', 'default', 'manage').map((tool) => tool.name).filter((name) => name.startsWith('schedule_'))).toEqual([])
      for (const name of TOOLS) {
        const outcome = await call(name, { ...CREATE, jobId: 'x' })
        expect(outcome, name).toMatchObject({ isError: true, text: expect.stringContaining('Agents may create jobs') })
      }
      expect(schedules.create).not.toHaveBeenCalled()
      expect(jobs.listJobs()).toEqual([])
    })

    it('lists the five tools for a manage credential when the setting is on, and none below manage', async () => {
      const { registry, state } = await world()
      const names = (granted: AgentAccessLevel) => registry.listForThread('caller', 'default', granted).map((tool) => tool.name).filter((name) => name.startsWith('schedule_')).sort()
      expect(names('manage')).toEqual(TOOLS)
      expect(names('read')).toEqual([])
      expect(names('lineage')).toEqual([])
      state.enabled = false
      expect(names('manage')).toEqual([])
    })

    it('turning the setting off after a job was made refuses updates, runs, pauses and listing', async () => {
      const { call, create, state } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      state.enabled = false
      for (const [name, args] of [
        ['schedule_list', {}],
        ['schedule_update', { jobId: job.id, name: 'Renamed' }],
        ['schedule_pause', { jobId: job.id }],
        ['schedule_run', { jobId: job.id }]
      ] as const)
        expect((await call(name, { ...args })).isError, name).toBe(true)
    })

    it('the tools are only for a host that has scheduled jobs', async () => {
      fx = delegationFixture()
      const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      expect(registry.list().filter((tool) => tool.name.startsWith('schedule_'))).toEqual([])
    })
  })

  describe('only a turn a person started may create or start jobs', () => {
    it.each([
      ['schedule_create', () => ({ ...CREATE })],
      ['schedule_run', (id: string) => ({ jobId: id })],
      ['schedule_update of the prompt', (id: string) => ({ jobId: id, prompt: 'Something else' })],
      ['schedule_update of the schedule', (id: string) => ({ jobId: id, schedule: { kind: 'interval', minutes: 60 } })],
      ['schedule_update of the mode', (id: string) => ({ jobId: id, mode: 'plan' })],
      ['schedule_update of the workspace', (id: string) => ({ jobId: id, workspace: { kind: 'newWorktree' } })],
      ['schedule_update of the thread', (id: string) => ({ jobId: id, threadId: 'caller' })],
      ['schedule_update of the model', (id: string) => ({ jobId: id, selection: { instanceId: 'claude', model: 'sonnet' } })]
    ])('%s is refused for any other run, and changes nothing', async (label, args) => {
      const { call, denied, create, state, stored, schedules, jobs, woke } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      const before = stored(job.id)
      const writes = jobs.listJobs().length
      state.person = false
      const name = label.split(' ')[0]
      const error = await denied(call(name, args(job.id)))
      expect(error, label).toBeInstanceOf(McpToolError)
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/only for a turn a person started/)
      expect(stored(job.id)).toEqual(before)
      expect(jobs.listJobs()).toHaveLength(writes)
      expect(schedules.update).not.toHaveBeenCalled()
      expect(schedules.trigger).not.toHaveBeenCalled()
      expect(woke).not.toHaveBeenCalled()
    })

    it('asks the owner who started the run, with the caller as it is', async () => {
      const { call, create, schedules, callerRun } = await world()
      await create()
      expect(schedules.startedByPerson).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'caller', runId: callerRun.runId }))
    })

    it('refuses when the owner cannot say, and when it throws', async () => {
      const { call, denied, schedules, jobs } = await world()
      schedules.startedByPerson.mockImplementation(() => { throw new Error('the run engine is closed') })
      expect((await denied(call('schedule_create', CREATE)))!.code).toBe('mousse_scope_denied')
      expect(jobs.listJobs()).toEqual([])
    })

    it('a run that is not a person\'s may still list, rename and pause its own thread\'s jobs, and nothing else', async () => {
      const { call, create, result, state, stored } = await world()
      const job = await create()
      state.person = false
      expect((await result(call('schedule_list'))).jobs.map((entry: { id: string }) => entry.id)).toEqual([job.id])
      expect((await call('schedule_update', { jobId: job.id, name: 'Renamed' })).isError).toBeUndefined()
      expect((await call('schedule_pause', { jobId: job.id })).isError).toBeUndefined()
      expect(stored(job.id)).toMatchObject({ name: 'Renamed', state: 'paused' })
    })

    it('two manual jobs cannot start each other: a run that a job made starts nothing', async () => {
      const { call, create, state, jobs, woke, result } = await world()
      // A person's turn makes A and B, each told to start the other when it is done.
      const a = await create({ name: 'A', prompt: 'work, then run B', schedule: { kind: 'manual' } })
      const b = await create({ name: 'B', prompt: 'work, then run A', schedule: { kind: 'manual' } })
      expect((await call('schedule_run', { jobId: a.id })).isError).toBeUndefined()
      expect(woke).toHaveBeenCalledTimes(1)
      // A's run (source schedule: not a person's) tries to start B, and B's run would try A.
      state.person = false
      for (const target of [b.id, a.id]) {
        await expect(call('schedule_run', { jobId: target })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      }
      expect(woke).toHaveBeenCalledTimes(1)
      expect(jobs.getJob(b.id)?.nextRunAt).toBeNull()
      expect((await result(call('schedule_list'))).jobs).toHaveLength(2)
    })

    it('a job\'s run cannot create jobs, so nothing grows from one', async () => {
      const { call, state, jobs, create } = await world()
      await create({ schedule: { kind: 'manual' } })
      state.person = false
      for (let attempt = 0; attempt < 3; attempt += 1) await expect(call('schedule_create', { ...CREATE, name: `Child ${attempt}` })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      expect(jobs.listJobs()).toHaveLength(1)
    })
  })

  describe('schedule_create', () => {
    it('makes a job in the caller\'s project and records who made it, labelled as an agent\'s', async () => {
      const { call, result, schedules, stored, callerRun } = await world()
      const { job } = await result(call('schedule_create', { ...CREATE, mode: 'plan' }, 'manage', { toolCallId: 'mcp:c1' }))
      expect(job).toMatchObject({ name: 'Nightly report', prompt: 'Write the nightly report', schedule: { kind: 'interval', minutes: 30 }, projectId: 'p1', threadId: null, mode: 'plan', createdByAgent: true, createdByYou: true })
      expect(stored(job.id)).toMatchObject({
        projectId: 'p1',
        mode: 'plan',
        createdBy: { threadId: 'caller', runId: callerRun.runId, requestId: 'schedule_create:caller:mcp:c1' }
      })
      expect(stored(job.id).trigger).toBeUndefined()
      expect(schedules.validate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', mode: 'plan' }))
    })

    it('records the caller\'s limits on the job, asking the owner who is calling', async () => {
      const { call, result, schedules, stored, state, callerRun } = await world()
      state.limits = { accessCap: 'read', permissionCeiling: 'accept_edits' }
      const { job } = await result(call('schedule_create', CREATE, 'manage'))
      expect(schedules.limits).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'caller', runId: callerRun.runId, accessLevel: 'manage' }))
      expect(stored(job.id)).toMatchObject({ accessCap: 'read', permissionCeiling: 'accept_edits' })
      expect(job).toMatchObject({ accessCap: 'read', permissionCeiling: 'accept_edits' })
    })

    it('survives a reload with its creator, key, limits and end', async () => {
      const { create, stored, callerRun } = await world()
      const job = await create()
      const reloaded = new ScheduledJobStore(MousseConfigStore.load(home!))
      expect(reloaded.getJob(job.id)).toMatchObject({ createdBy: { threadId: 'caller', runId: callerRun.runId }, accessCap: 'manage', permissionCeiling: 'full', expiresAt: stored(job.id).expiresAt })
      expect(stored(job.id).createdBy?.requestId).toMatch(/^schedule_create:caller:/)
    })

    it.each([
      ['a webhook trigger', { trigger: { webhook: {} } }, /webhook/],
      ['a webhook field', { webhook: true }, /webhook/],
      ['an access cap', { accessCap: 'manage' }, /access/],
      ['a permission ceiling', { permissionCeiling: 'full' }, /permission mode/],
      ['a permission mode', { permissionMode: 'full' }, /permission mode/],
      ['a creator', { createdBy: { threadId: 'someone-else' } }, /createdBy/],
      ['an end', { expiresAt: '2099-01-01T00:00:00.000Z' }, /ends is set by Mousse|When a job ends/],
      ['another project', { projectId: 'p2' }, /project/],
      ['createThread', { createThread: true }, /createThread/]
    ])('refuses %s, and makes nothing', async (_name, extra, message) => {
      const { call, jobs, schedules } = await world()
      const outcome = await call('schedule_create', { ...CREATE, ...extra })
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toMatch(message)
      expect(jobs.listJobs()).toEqual([])
      expect(schedules.create).not.toHaveBeenCalled()
    })

    it('refuses a key it does not know', async () => {
      const { call, jobs } = await world()
      expect((await call('schedule_create', { ...CREATE, secretSauce: 1 })).isError).toBe(true)
      expect(jobs.listJobs()).toEqual([])
    })

    it.each([
      ['a prompt that starts with a slash', { prompt: '/workflow run ship' }, /workflows/],
      ['a prompt that starts with a slash after whitespace', { prompt: '  \n /workflow run ship' }, /workflows/],
      ['an interval of one minute', { schedule: { kind: 'interval', minutes: 1 } }, new RegExp(`less than ${MIN_INTERVAL} minutes`)],
      ['an interval of fourteen minutes', { schedule: { kind: 'interval', minutes: 14 } }, new RegExp(`less than ${MIN_INTERVAL} minutes`)],
      ['every minute in cron', { schedule: { kind: 'cron', expr: '* * * * *' } }, /fixed list of minutes/],
      ['a cron step in the minute field', { schedule: { kind: 'cron', expr: '*/15 * * * *' } }, /fixed list of minutes/],
      ['a cron range in the minute field', { schedule: { kind: 'cron', expr: '0-30 * * * *' } }, /fixed list of minutes/],
      ['cron minutes closer than the floor', { schedule: { kind: 'cron', expr: '0,10 * * * *' } }, new RegExp(`at least ${MIN_INTERVAL} apart`)],
      ['cron minutes that wrap closer than the floor', { schedule: { kind: 'cron', expr: '5,55 * * * *' } }, new RegExp(`at least ${MIN_INTERVAL} apart`)],
      ['a cron minute past 59', { schedule: { kind: 'cron', expr: '75 * * * *' } }, /cron field is invalid/],
      ['a cron expression with six fields', { schedule: { kind: 'cron', expr: '0 0 9 * * *' } }, /five fields/],
      ['an existing worktree', { workspace: { kind: 'worktree', path: '/work/wt' } }, /existing worktree/]
    ])('refuses %s', async (_name, extra, message) => {
      const { call, jobs } = await world()
      const outcome = await call('schedule_create', { ...CREATE, ...extra })
      expect(outcome).toMatchObject({ isError: true, text: expect.stringMatching(message) })
      expect(jobs.listJobs()).toEqual([])
    })

    it.each([
      ['an interval at the floor', { kind: 'interval', minutes: MIN_INTERVAL }],
      ['a daily cron', { kind: 'cron', expr: '0 9 * * 1-5' }],
      ['a list of minutes at the floor', { kind: 'cron', expr: '0,15,30,45 * * * *' }],
      ['a manual job', { kind: 'manual' }],
      ['a one-time job', { kind: 'once', runAt: '2030-01-01T00:00:00.000Z' }]
    ])('accepts %s', async (_name, schedule) => {
      const { call, jobs } = await world()
      expect((await call('schedule_create', { ...CREATE, schedule })).isError).toBeUndefined()
      expect(jobs.listJobs()).toHaveLength(1)
    })

    it('binds a job to the caller\'s own thread or to one of its lineage, and to no other', async () => {
      const { call, result, callerRun, fx: f, threads, denied, stored } = await world()
      const child = await f.delegate(callerRun.runId, 'call-a')
      threads.set(child.childThreadId, thread(child.childThreadId, { projectId: 'p1' }))
      const own = (await result(call('schedule_create', { ...CREATE, threadId: 'caller' }))).job
      expect(stored(own.id)).toMatchObject({ threadId: 'caller', projectId: 'p1' })
      const below = (await result(call('schedule_create', { ...CREATE, threadId: child.childThreadId }))).job
      expect(stored(below.id)).toMatchObject({ threadId: child.childThreadId })
      expect((await denied(call('schedule_create', { ...CREATE, threadId: 'elsewhere' })))!.code).toBe('mousse_scope_denied')
    })

    it('refuses an archived thread, a bot\'s thread and one that does not exist, though they are in its lineage', async () => {
      const { call, denied, jobs, fx: f, callerRun, threads, botThreads } = await world()
      const archived = await f.delegate(callerRun.runId, 'call-a')
      const bot = await f.delegate(callerRun.runId, 'call-b')
      const missing = await f.delegate(callerRun.runId, 'call-c')
      threads.set(archived.childThreadId, thread(archived.childThreadId, { settledAt: NOW }))
      threads.set(bot.childThreadId, thread(bot.childThreadId))
      botThreads.add(bot.childThreadId)
      expect(await call('schedule_create', { ...CREATE, threadId: archived.childThreadId })).toMatchObject({ isError: true, text: expect.stringContaining('archived') })
      expect((await denied(call('schedule_create', { ...CREATE, threadId: bot.childThreadId })))!.message).toMatch(/belongs to a bot/)
      expect(await call('schedule_create', { ...CREATE, threadId: missing.childThreadId })).toMatchObject({ isError: true, text: expect.stringContaining('was not found') })
      expect(jobs.listJobs()).toEqual([])
    })

    it('a plan ceiling makes plan jobs only, and defaults to plan', async () => {
      const { call, denied, result, stored } = await world()
      expect((await denied(call('schedule_create', { ...CREATE, mode: 'agent' }, 'manage', { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      const { job } = await result(call('schedule_create', CREATE, 'manage', { modeCeiling: 'plan' }))
      expect(stored(job.id).mode).toBe('plan')
    })

    it('a refusal from the profile\'s checks reaches the agent and makes nothing', async () => {
      const { call, schedules, jobs } = await world()
      schedules.validate.mockImplementation(() => { throw new Error('The model is hidden') })
      expect(await call('schedule_create', CREATE)).toMatchObject({ isError: true, text: 'The model is hidden' })
      expect(jobs.listJobs()).toEqual([])
    })

    it('uses the model the profile resolved', async () => {
      const { call, schedules, result, stored } = await world()
      schedules.validate.mockImplementation(() => ({ selection: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' } as never }))
      const { job } = await result(call('schedule_create', { ...CREATE, selection: { instanceId: 'claude', model: 'sonnet' } }))
      expect(stored(job.id).selection).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    })
  })

  describe('bounds on cost and lifetime', () => {
    it('the defaults are ten active jobs, fifteen minutes and seven days', () => {
      expect(AGENT_JOB_LIMIT_DEFAULTS).toEqual({ maxActive: 10, minIntervalMinutes: 15, lifetimeDays: 7 })
    })

    it('a job ends after the default lifetime unless a person extends it', async () => {
      const { create, stored } = await world()
      const before = Date.now()
      const job = await create()
      const ends = Date.parse(stored(job.id).expiresAt!)
      expect(ends).toBeGreaterThanOrEqual(before + LIFETIME_DAYS * DAY)
      expect(ends).toBeLessThanOrEqual(Date.now() + LIFETIME_DAYS * DAY)
    })

    it('refuses the eleventh active job of the profile, however many runs, threads and restarts made them', async () => {
      const { call, create, otherJob, jobs } = await world()
      // Jobs other threads' agents made count too; a person's do not.
      for (let made = 0; made < 4; made += 1) otherJob({ name: `Other ${made}` })
      jobs.createJob({ name: 'A person\'s', prompt: 'x', schedule: { kind: 'manual' } })
      for (let made = 0; made < MAX_ACTIVE - 4; made += 1) await create({ name: `Mine ${made}` })
      const refused = await call('schedule_create', { ...CREATE, name: 'One too many' })
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(`the limit is ${MAX_ACTIVE}`) })
      expect(jobs.listJobs().filter((job) => job.createdBy)).toHaveLength(MAX_ACTIVE)
      // A restart (a new store over the same files) and a new run change nothing: the count is the saved jobs.
      const reopened = new ScheduledJobStore(MousseConfigStore.load(home!))
      expect(reopened.listJobs().filter((job) => job.createdBy)).toHaveLength(MAX_ACTIVE)
      expect((await call('schedule_create', { ...CREATE, name: 'Still too many' })).isError).toBe(true)
    })

    it('paused and ended jobs do not count, so pausing one makes room', async () => {
      const { call, create, jobs } = await world()
      const ids: string[] = []
      for (let made = 0; made < MAX_ACTIVE; made += 1) ids.push((await create({ name: `Job ${made}` })).id)
      expect((await call('schedule_create', { ...CREATE, name: 'Over' })).isError).toBe(true)
      await call('schedule_pause', { jobId: ids[0] })
      jobs.updateJob(ids[1], { state: 'completed', nextRunAt: null })
      expect((await call('schedule_create', { ...CREATE, name: 'Room 1' })).isError).toBeUndefined()
      expect((await call('schedule_create', { ...CREATE, name: 'Room 2' })).isError).toBeUndefined()
      expect((await call('schedule_create', { ...CREATE, name: 'Over again' })).isError).toBe(true)
    })

    it('a retry with the same clientRequestId returns the first job, makes no other, even at the cap', async () => {
      const { call, create, jobs, result } = await world()
      const first = (await result(call('schedule_create', { ...CREATE, clientRequestId: 'req-1' }))).job
      for (let made = 1; made < MAX_ACTIVE; made += 1) await create({ name: `Job ${made}` })
      expect((await call('schedule_create', { ...CREATE, name: 'Over' })).isError).toBe(true)
      const retry = await result(call('schedule_create', { ...CREATE, clientRequestId: 'req-1' }))
      expect(retry).toMatchObject({ replayed: true, job: { id: first.id } })
      expect(jobs.listJobs()).toHaveLength(MAX_ACTIVE)
    })

    it('a key is the caller thread\'s own: another thread\'s same key makes its own job', async () => {
      const { call, jobs, result, create } = await world()
      const mine = await create({ clientRequestId: 'same' })
      const other = jobs.createJob({ name: 'Other', prompt: 'x', schedule: { kind: 'manual' }, createdBy: { threadId: 'other-thread', runId: 'r', requestId: 'schedule_create:other-thread:same' } })
      const again = (await result(call('schedule_create', { ...CREATE, clientRequestId: 'same' }))).job
      expect(again.id).toBe(mine.id)
      expect(again.id).not.toBe(other.id)
    })

    it('an agent can only shorten a job\'s number of runs, never remove or lengthen them, and cannot touch its end', async () => {
      const { call, create, stored } = await world()
      const job = await create({ repeat: { times: 5 } })
      expect(await call('schedule_update', { jobId: job.id, repeat: null })).toMatchObject({ isError: true, text: expect.stringContaining('only be shortened') })
      expect(await call('schedule_update', { jobId: job.id, repeat: { times: 9 } })).toMatchObject({ isError: true, text: expect.stringContaining('only be shortened') })
      expect(await call('schedule_update', { jobId: job.id, expiresAt: '2099-01-01T00:00:00.000Z' })).toMatchObject({ isError: true })
      expect(stored(job.id).repeat?.times).toBe(5)
      expect((await call('schedule_update', { jobId: job.id, repeat: { times: 2 } })).isError).toBeUndefined()
      expect(stored(job.id).repeat?.times).toBe(2)
    })
  })

  describe('the limits are settings a person changes', () => {
    const toolOf = (registry: Awaited<ReturnType<typeof world>>['registry'], name: string) => registry.listForThread('caller', 'default', 'manage').find((tool) => tool.name === name)!
    const scheduleOf = (tool: { inputSchema: unknown }) => (tool.inputSchema as { properties: { schedule: { properties: { minutes: { minimum: number } }; description: string } } }).properties.schedule

    it('enforces a changed number of active jobs at the next create, without a restart', async () => {
      const { call, create, state, jobs } = await world()
      state.jobLimits.maxActive = 2
      await create({ name: 'One' })
      await create({ name: 'Two' })
      expect(await call('schedule_create', { ...CREATE, name: 'Three' })).toMatchObject({ isError: true, text: expect.stringContaining('the limit is 2') })
      state.jobLimits.maxActive = 3
      expect((await call('schedule_create', { ...CREATE, name: 'Three' })).isError).toBeUndefined()
      // A lower limit leaves the jobs that exist alone (none paused or removed) and only refuses the next one.
      state.jobLimits.maxActive = 1
      expect(jobs.listJobs()).toHaveLength(3)
      expect(jobs.listJobs().every((job) => job.enabled && job.state !== 'paused')).toBe(true)
      expect(await call('schedule_create', { ...CREATE, name: 'Four' })).toMatchObject({ isError: true, text: expect.stringContaining('the limit is 1') })
      expect(jobs.listJobs()).toHaveLength(3)
    })

    it('enforces a changed shortest interval on creates and on schedule changes, and the tool text follows it', async () => {
      const { call, create, state, registry, stored } = await world()
      state.jobLimits.minIntervalMinutes = 60
      expect(await call('schedule_create', { ...CREATE, schedule: { kind: 'interval', minutes: 30 } })).toMatchObject({ isError: true, text: expect.stringContaining('less than 60 minutes') })
      expect(await call('schedule_create', { ...CREATE, schedule: { kind: 'cron', expr: '0,30 * * * *' } })).toMatchObject({ isError: true, text: expect.stringContaining('at least 60 apart') })
      expect(toolOf(registry, 'schedule_create').description).toContain('an interval under 60 minutes')
      expect(scheduleOf(toolOf(registry, 'schedule_create')).properties.minutes.minimum).toBe(60)
      expect(scheduleOf(toolOf(registry, 'schedule_update')).properties.minutes.minimum).toBe(60)
      const job = await create({ schedule: { kind: 'interval', minutes: 60 } })
      expect(await call('schedule_update', { jobId: job.id, schedule: { kind: 'interval', minutes: 45 } })).toMatchObject({ isError: true, text: expect.stringContaining('less than 60 minutes') })
      expect(stored(job.id).schedule).toEqual({ kind: 'interval', minutes: 60 })
      // Lower, and the same call is allowed.
      state.jobLimits.minIntervalMinutes = 5
      expect((await call('schedule_update', { jobId: job.id, schedule: { kind: 'interval', minutes: 5 } })).isError).toBeUndefined()
      expect(toolOf(registry, 'schedule_create').description).toContain('an interval under 5 minutes')
    })

    it('above an hour, a cron expression must keep its runs that far apart by its hours too', async () => {
      const { call, state } = await world()
      state.jobLimits.minIntervalMinutes = 120
      expect(await call('schedule_create', { ...CREATE, schedule: { kind: 'cron', expr: '0 * * * *' } })).toMatchObject({ isError: true, text: expect.stringContaining('every 60') })
      expect(await call('schedule_create', { ...CREATE, schedule: { kind: 'cron', expr: '0 8,9 * * *' } })).toMatchObject({ isError: true, text: expect.stringContaining('every 60') })
      expect((await call('schedule_create', { ...CREATE, schedule: { kind: 'cron', expr: '0 */2 * * *' } })).isError).toBeUndefined()
      expect((await call('schedule_create', { ...CREATE, schedule: { kind: 'cron', expr: '30 9 * * 1-5' } })).isError).toBeUndefined()
    })

    it('gives a new job the changed lifetime, and leaves the end of a job that exists alone', async () => {
      const { create, state, stored, jobs } = await world()
      const first = await create({ name: 'Before' })
      const firstEnds = stored(first.id).expiresAt
      state.jobLimits.lifetimeDays = 30
      const before = Date.now()
      const second = await create({ name: 'After' })
      const ends = Date.parse(stored(second.id).expiresAt!)
      expect(ends).toBeGreaterThanOrEqual(before + 30 * DAY)
      expect(ends).toBeLessThanOrEqual(Date.now() + 30 * DAY)
      expect(stored(first.id).expiresAt).toBe(firstEnds)
      expect(jobs.getJob(first.id)!.expiresAt).toBe(firstEnds)
    })

    it('the description of schedule_create states the limits as they are now', async () => {
      const { registry, state } = await world()
      const text = () => toolOf(registry, 'schedule_create').description
      expect(text()).toContain(`${MAX_ACTIVE} active jobs`)
      expect(text()).toContain(`${LIFETIME_DAYS} days after it is made`)
      state.jobLimits = { maxActive: 3, minIntervalMinutes: 90, lifetimeDays: 14 }
      expect(text()).toContain('3 active jobs')
      expect(text()).toContain('14 days after it is made')
      expect(text()).toContain('an interval under 90 minutes')
    })

    it('an agent cannot change them: no tool takes them, and a call that names one is refused and changes nothing', async () => {
      const { call, create, state, registry, schedules } = await world()
      const job = await create()
      const before = { ...state.jobLimits }
      for (const key of ['agentJobMaxActive', 'agentJobMinIntervalMinutes', 'agentJobLifetimeDays', 'maxActive', 'minIntervalMinutes', 'lifetimeDays', 'limits', 'scheduled']) {
        expect((await call('schedule_create', { ...CREATE, name: `Sneaky ${key}`, [key]: 1000 })).isError, key).toBe(true)
        expect((await call('schedule_update', { jobId: job.id, [key]: 1000 })).isError, key).toBe(true)
      }
      expect(state.jobLimits).toEqual(before)
      // The host's limits are read only, and no registered tool has a field for them.
      expect(schedules.jobLimits).toHaveBeenCalled()
      const names = registry.list().map((tool) => tool.name)
      expect(names.filter((name) => /setting|config/i.test(name))).toEqual([])
      const fields = JSON.stringify(registry.list().map((tool) => tool.inputSchema))
      expect(fields).not.toMatch(/agentJob(MaxActive|MinIntervalMinutes|LifetimeDays)/)
    })
  })

  describe('an agent sees and changes only the jobs its own thread made', () => {
    it('lists them and no others: not a person\'s, not another thread\'s, whatever the project list says', async () => {
      const { call, result, personJob, otherJob, create, state } = await world({ projectIds: [] })
      const mine = await create()
      personJob({ name: 'In p1', projectId: 'p1' })
      personJob({ name: 'Nowhere' })
      otherJob({ name: 'Other agent, p1', projectId: 'p1' })
      const ids = async () => (await result(call('schedule_list'))).jobs.map((job: { id: string }) => job.id)
      expect(await ids()).toEqual([mine.id])
      state.profile = profile({ projectIds: ['p1'] })
      expect(await ids()).toEqual([mine.id])
    })

    it('shows when a job ends and why it is paused, and never a webhook', async () => {
      const { call, result, create, jobs } = await world()
      const job = await create()
      await call('schedule_pause', { jobId: job.id, reason: 'not needed' })
      jobs.updateJob(job.id, { runHistory: [1, 2, 3, 4].map((n) => ({ runAt: `2026-10-27T0${n}:00:00.000Z`, status: 'ok' as const, output: 'long output' })) })
      const { jobs: listed } = await result(call('schedule_list'))
      expect(listed[0]).toMatchObject({ createdByAgent: true, createdByYou: true, expiresAt: expect.any(String), pausedReason: 'Paused by an agent: not needed' })
      expect(listed[0].recentRuns.map((run: { runAt: string }) => run.runAt)).toEqual(['2026-10-27T04:00:00.000Z', '2026-10-27T03:00:00.000Z', '2026-10-27T02:00:00.000Z'])
      expect(JSON.stringify(listed)).not.toContain('long output')
      expect(listed[0].hasWebhook).toBeUndefined()
    })

    it.each([
      ['schedule_update', { name: 'Renamed' }],
      ['schedule_update', { prompt: 'Rewritten' }],
      ['schedule_pause', {}],
      ['schedule_run', {}]
    ])('%s of a person\'s job is refused the same way as one that does not exist, and changes nothing', async (name, args) => {
      const { call, denied, personJob, schedules, stored } = await world({ projectIds: [] })
      const theirs = personJob({ name: 'In p1', projectId: 'p1' })
      const before = stored(theirs.id)
      const real = await denied(call(name, { jobId: theirs.id, ...args }))
      const missing = await denied(call(name, { jobId: 'no-such-job', ...args }))
      expect(real).toBeInstanceOf(McpToolError)
      expect(real!.code).toBe('mousse_scope_denied')
      expect(real!.message.replace(theirs.id, 'X')).toBe(missing!.message.replace('no-such-job', 'X'))
      expect(schedules.update).not.toHaveBeenCalled()
      expect(schedules.pause).not.toHaveBeenCalled()
      expect(schedules.trigger).not.toHaveBeenCalled()
      expect(stored(theirs.id)).toEqual(before)
    })

    it('another agent\'s job is refused too, and so is a person\'s job with a webhook or a workflow prompt', async () => {
      const { call, denied, otherJob, personJob, jobs, stored } = await world()
      const other = otherJob({ projectId: 'p1' })
      const hooked = personJob({ projectId: 'p1' })
      jobs.updateJob(hooked.id, { trigger: { webhook: { scheme: 'mousse', secretRef: 'ref', createdAt: NOW } } })
      const flow = personJob({ name: 'Deploy', prompt: '/deploy production', projectId: 'p1', schedule: { kind: 'interval', minutes: 1440 } })
      for (const job of [other, hooked, flow]) {
        for (const [name, args] of [['schedule_update', { prompt: 'x' }], ['schedule_update', { schedule: { kind: 'interval', minutes: 15 } }], ['schedule_pause', {}], ['schedule_run', {}]] as const)
          expect((await denied(call(name, { jobId: job.id, ...args })))!.code, `${name} ${job.name}`).toBe('mousse_scope_denied')
      }
      expect(stored(flow.id).schedule).toEqual({ kind: 'interval', minutes: 1440 })
      expect(stored(hooked.id).trigger).toBeDefined()
    })

    it('a job its own thread made stays its own after the project list changes', async () => {
      const { call, create, state, result } = await world()
      const mine = await create()
      state.profile = profile({ projectIds: ['p2'] })
      expect((await result(call('schedule_list'))).jobs.map((job: { id: string }) => job.id)).toEqual([mine.id])
      expect((await call('schedule_pause', { jobId: mine.id })).isError).toBeUndefined()
    })

    it('another thread made job under the same caller project is not reachable by a different thread of the same person', async () => {
      const { create, registry, request, turns, fx: f, denied } = await world()
      const job = await create()
      const second = await f.runningRun('second')
      turns.register(appTurn({ threadId: 'second', runId: second.runId }))
      const as = request({ threadId: 'second', runId: second.runId, accessLevel: 'manage' })
      expect((await denied(registry.call('schedule_pause', { jobId: job.id }, as)))!.code).toBe('mousse_scope_denied')
      expect(JSON.parse((await registry.call('schedule_list', {}, as)).text).jobs).toEqual([])
    })
  })

  describe('every change an agent makes is recorded', () => {
    it('records a creation, a change, a pause and a run as agent actions on the caller\'s thread, with the call as the actor', async () => {
      const { call, create, recordAgentAction, callerRun } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      await call('schedule_update', { jobId: job.id, prompt: 'Better' }, 'manage', { toolCallId: 'mcp:u1' })
      await call('schedule_run', { jobId: job.id })
      await call('schedule_pause', { jobId: job.id })
      expect(recordAgentAction.mock.calls.map((entry) => entry[2])).toEqual(['scheduled_job_created', 'scheduled_job_updated', 'scheduled_job_run', 'scheduled_job_paused'])
      expect(recordAgentAction).toHaveBeenNthCalledWith(2, { threadId: 'caller', runId: callerRun.runId }, expect.objectContaining({ kind: 'agent', threadId: 'caller', runId: callerRun.runId, toolCallId: 'mcp:u1' }), 'scheduled_job_updated', expect.objectContaining({ jobId: job.id, summary: expect.stringContaining('prompt') }))
    })

    it('records nothing for a call that was refused', async () => {
      const { call, create, recordAgentAction, state } = await world()
      const job = await create()
      recordAgentAction.mockClear()
      state.person = false
      await call('schedule_run', { jobId: job.id }).catch(() => undefined)
      await call('schedule_update', { jobId: job.id, prompt: 'x' }).catch(() => undefined)
      await call('schedule_update', { jobId: 'nope', name: 'x' }).catch(() => undefined)
      expect(recordAgentAction).not.toHaveBeenCalled()
    })

    it('a record that cannot be written does not undo the change', async () => {
      const { call, create, recordAgentAction, stored } = await world()
      recordAgentAction.mockImplementation(() => { throw new Error('events are read-only') })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const job = await create()
      expect(stored(job.id)).toBeDefined()
      await call('schedule_update', { jobId: job.id, name: 'Renamed' })
      expect(stored(job.id).name).toBe('Renamed')
      warn.mockRestore()
    })
  })

  describe('schedule_update', () => {
    it('changes only what it is given', async () => {
      const { call, create, stored } = await world()
      const job = await create({ mode: 'plan' })
      const before = stored(job.id)
      await call('schedule_update', { jobId: job.id, prompt: ' A better prompt ', schedule: { kind: 'interval', minutes: 60 } })
      expect(stored(job.id)).toMatchObject({ name: before.name, mode: 'plan', projectId: 'p1', prompt: 'A better prompt', schedule: { kind: 'interval', minutes: 60 }, createdBy: before.createdBy, expiresAt: before.expiresAt })
    })

    it('null puts a field back to its default', async () => {
      const { call, create, stored } = await world()
      const job = await create({ mode: 'plan' })
      await call('schedule_update', { jobId: job.id, mode: null })
      expect(stored(job.id).mode).toBeUndefined()
    })

    it('rebinds a job to the caller\'s thread and takes that thread\'s project, and frees it with null', async () => {
      const { call, create, stored } = await world()
      const job = await create()
      await call('schedule_update', { jobId: job.id, threadId: 'caller' })
      expect(stored(job.id)).toMatchObject({ threadId: 'caller', projectId: 'p1' })
      await call('schedule_update', { jobId: job.id, threadId: null })
      expect(stored(job.id)).toMatchObject({ projectId: 'p1' })
      expect(stored(job.id).threadId).toBeUndefined()
    })

    it('refuses another thread as the target', async () => {
      const { call, create, denied, stored } = await world()
      const job = await create()
      expect((await denied(call('schedule_update', { jobId: job.id, threadId: 'elsewhere' })))!.code).toBe('mousse_scope_denied')
      expect(stored(job.id).threadId).toBeUndefined()
    })

    it.each([
      ['a slash prompt', { prompt: '/workflow run ship' }, /workflows/],
      ['a one-minute interval', { schedule: { kind: 'interval', minutes: 1 } }, /less than 15 minutes/],
      ['a ten-minute interval', { schedule: { kind: 'interval', minutes: 10 } }, /less than 15 minutes/],
      ['every minute in cron', { schedule: { kind: 'cron', expr: '* * * * *' } }, /fixed list/],
      ['a worktree', { workspace: { kind: 'worktree', path: '/work/wt' } }, /existing worktree/],
      ['enabling the job', { enabled: true }, /schedule_pause/],
      ['an access cap', { accessCap: 'manage' }, /access/],
      ['a permission ceiling', { permissionCeiling: 'full' }, /permission mode/],
      ['a webhook trigger', { trigger: {} }, /webhook/],
      ['another project', { projectId: 'p2' }, /project/],
      ['nothing', {}, /at least one field/]
    ])('refuses %s, and changes nothing', async (_name, patch, message) => {
      const { call, create, schedules, stored } = await world()
      const job = await create()
      const before = stored(job.id)
      const outcome = await call('schedule_update', { jobId: job.id, ...patch })
      expect(outcome).toMatchObject({ isError: true, text: expect.stringMatching(message) })
      expect(schedules.update).not.toHaveBeenCalled()
      expect(stored(job.id)).toEqual(before)
    })

    it('a job whose prompt is a workflow is not changed or started by an agent, however it got there', async () => {
      const { call, create, jobs, stored } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      jobs.updateJob(job.id, { prompt: '/deploy production' })
      expect(await call('schedule_update', { jobId: job.id, schedule: { kind: 'interval', minutes: 15 } })).toMatchObject({ isError: true, text: expect.stringContaining('workflow') })
      expect(await call('schedule_run', { jobId: job.id })).toMatchObject({ isError: true, text: expect.stringContaining('workflow') })
      expect(stored(job.id).schedule).toEqual({ kind: 'manual' })
      // Pausing is always fine.
      expect((await call('schedule_pause', { jobId: job.id })).isError).toBeUndefined()
    })

    it('a plan ceiling cannot touch a job that runs in agent mode, nor widen a plan job', async () => {
      const { call, create, denied, stored } = await world()
      const planJob = await create({ mode: 'plan' })
      const agentJob = await create({ name: 'Agent mode' })
      expect((await denied(call('schedule_update', { jobId: agentJob.id, name: 'x' }, 'manage', { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect((await denied(call('schedule_run', { jobId: agentJob.id }, 'manage', { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect((await denied(call('schedule_update', { jobId: planJob.id, mode: 'agent' }, 'manage', { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect((await denied(call('schedule_update', { jobId: planJob.id, mode: null }, 'manage', { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect((await call('schedule_update', { jobId: planJob.id, prompt: 'still planning' }, 'manage', { modeCeiling: 'plan' })).isError).toBeUndefined()
      expect(stored(planJob.id).mode).toBe('plan')
    })

    it('validates the job as it would be after the change', async () => {
      const { call, create, schedules } = await world()
      const job = await create({ mode: 'plan' })
      await call('schedule_update', { jobId: job.id, workspace: { kind: 'newWorktree' } })
      expect(schedules.validate).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'plan', workspace: { kind: 'newWorktree' }, projectId: 'p1' }))
      schedules.validate.mockImplementation(() => { throw new Error('A plan-mode job never provisions a worktree') })
      const outcome = await call('schedule_update', { jobId: job.id, workspace: { kind: 'newWorktree' } })
      expect(outcome).toMatchObject({ isError: true, text: expect.stringContaining('never provisions a worktree') })
    })
  })

  describe('an agent can never raise a job\'s limits', () => {
    it('keeps the narrower limits of a job when a wider caller changes what it does', async () => {
      const { call, create, state, stored } = await world()
      state.limits = { accessCap: 'lineage', permissionCeiling: 'ask' }
      const job = await create()
      state.limits = { accessCap: 'manage', permissionCeiling: 'full' }
      await call('schedule_update', { jobId: job.id, prompt: 'Do something else' })
      expect(stored(job.id)).toMatchObject({ accessCap: 'lineage', permissionCeiling: 'ask' })
    })

    it('brings the limits of a job down to a narrower caller', async () => {
      const { call, create, state, stored } = await world()
      const job = await create()
      expect(stored(job.id)).toMatchObject({ accessCap: 'manage', permissionCeiling: 'full' })
      state.limits = { accessCap: 'read', permissionCeiling: 'accept_edits' }
      await call('schedule_update', { jobId: job.id, schedule: { kind: 'interval', minutes: 60 } })
      expect(stored(job.id)).toMatchObject({ accessCap: 'read', permissionCeiling: 'accept_edits' })
      state.limits = { accessCap: 'manage', permissionCeiling: 'full' }
      await call('schedule_update', { jobId: job.id, prompt: 'again' })
      expect(stored(job.id)).toMatchObject({ accessCap: 'read', permissionCeiling: 'accept_edits' })
    })

    it('clearing a restrictive setting keeps the ceiling', async () => {
      const { call, create, state, stored } = await world()
      state.limits = { accessCap: 'read', permissionCeiling: 'ask' }
      const job = await create({ mode: 'plan' })
      state.limits = { accessCap: 'manage', permissionCeiling: 'full' }
      await call('schedule_update', { jobId: job.id, mode: null })
      expect(stored(job.id)).toMatchObject({ accessCap: 'read', permissionCeiling: 'ask' })
    })

    it('a change of the name alone leaves the limits as they were', async () => {
      const { call, create, state, stored } = await world()
      const job = await create()
      state.limits = { accessCap: 'lineage', permissionCeiling: 'ask' }
      await call('schedule_update', { jobId: job.id, name: 'Renamed' })
      expect(stored(job.id)).toMatchObject({ name: 'Renamed', accessCap: 'manage', permissionCeiling: 'full' })
    })
  })

  describe('schedule_pause', () => {
    it('pauses a job it made, says an agent did, and a person resumes it', async () => {
      const { call, create, stored, schedules, jobs } = await world()
      const job = await create()
      const outcome = await call('schedule_pause', { jobId: job.id, reason: 'The report is not needed this week' })
      expect(JSON.parse(outcome.text).job).toMatchObject({ enabled: false, state: 'paused' })
      expect(stored(job.id)).toMatchObject({ enabled: false, state: 'paused', pausedReason: 'Paused by an agent: The report is not needed this week' })
      expect(schedules.pause).toHaveBeenCalledTimes(1)
      expect(jobs.resumeJob(job.id)?.state).toBe('scheduled')
    })

    it('pauses with a plain reason when none is given', async () => {
      const { call, create, stored } = await world()
      const job = await create()
      await call('schedule_pause', { jobId: job.id })
      expect(stored(job.id).pausedReason).toBe('Paused by an agent')
    })

    it('has no way to resume: update refuses enabled and run refuses a paused job', async () => {
      const { call, create, stored } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      await call('schedule_pause', { jobId: job.id })
      expect((await call('schedule_update', { jobId: job.id, enabled: true })).isError).toBe(true)
      expect(await call('schedule_run', { jobId: job.id })).toMatchObject({ isError: true, text: expect.stringContaining('paused') })
      expect(stored(job.id)).toMatchObject({ enabled: false, state: 'paused' })
    })
  })

  describe('schedule_run', () => {
    it('makes the job due now and wakes the scheduler', async () => {
      const { call, create, stored, schedules, woke } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      expect(stored(job.id).nextRunAt).toBeNull()
      const before = Date.now()
      const outcome = await call('schedule_run', { jobId: job.id })
      expect(JSON.parse(outcome.text)).toMatchObject({ started: true, job: { id: job.id } })
      expect(Date.parse(stored(job.id).nextRunAt!)).toBeGreaterThanOrEqual(before)
      expect(schedules.trigger).toHaveBeenCalledWith(job.id)
      expect(woke).toHaveBeenCalledTimes(1)
    })

    it('is refused, as Run now is, while the job is running, has a claim, or has a run in progress or waiting in a queue', async () => {
      const { call, create, jobs, woke, schedules } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      const claim = { pid: 1, processInstanceId: 'x', token: 't', claimedAt: NOW, heartbeatAt: NOW, occurrenceKey: 'k' }
      const cases: Array<[Partial<ScheduledJob>, RegExp]> = [
        [{ state: 'running' }, /already running/],
        [{ state: 'scheduled', runClaim: claim }, /already running/],
        [{ runClaim: undefined, pendingOccurrence: { occurrenceKey: 'k', threadId: 't', runId: 'r', state: 'running' } }, /in progress/],
        [{ pendingOccurrence: { occurrenceKey: 'k', threadId: 't', runId: 'r', queueItemId: 'q', state: 'queued' } }, /waiting in the queue/]
      ]
      for (const [patch, message] of cases) {
        jobs.updateJob(job.id, { state: 'scheduled', runClaim: undefined, pendingOccurrence: undefined })
        jobs.updateJob(job.id, patch)
        const outcome = await call('schedule_run', { jobId: job.id })
        expect(outcome, JSON.stringify(patch)).toMatchObject({ isError: true, text: expect.stringMatching(message) })
      }
      expect(schedules.trigger).not.toHaveBeenCalled()
      expect(woke).not.toHaveBeenCalled()
    })

    it('says the same words as the protocol\'s Run now', async () => {
      const { call, create, jobs } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      jobs.updateJob(job.id, { pendingOccurrence: { occurrenceKey: 'k', threadId: 't', runId: 'r', state: 'queued' } })
      const { runNowRefusal } = await import('../../src/mms/scheduled/runNowRefusal')
      expect((await call('schedule_run', { jobId: job.id })).text).toBe(runNowRefusal(jobs.getJob(job.id)!))
    })

    it('never brings back a one-time job that ran, or a job that ran out of time', async () => {
      const { call, create, jobs, stored, schedules, woke } = await world()
      const once = await create({ schedule: { kind: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() } })
      jobs.updateJob(once.id, { state: 'completed', nextRunAt: null, lastRunAt: NOW })
      const expired = await create({ name: 'Expired', schedule: { kind: 'manual' } })
      jobs.updateJob(expired.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
      for (const id of [once.id, expired.id]) expect(await call('schedule_run', { jobId: id }), id).toMatchObject({ isError: true, text: expect.stringContaining('has ended') })
      expect(stored(once.id).state).toBe('completed')
      expect(schedules.trigger).not.toHaveBeenCalled()
      expect(woke).not.toHaveBeenCalled()
    })

    it('needs the manage level', async () => {
      const { call, create, denied, schedules } = await world()
      const job = await create({ schedule: { kind: 'manual' } })
      expect((await denied(call('schedule_run', { jobId: job.id }, 'read')))!.code).toBe('mousse_scope_denied')
      expect(schedules.trigger).not.toHaveBeenCalled()
    })
  })

  describe('the central check', () => {
    it('refuses a caller whose run is no longer the thread\'s active run, before any host call', async () => {
      const { call, fx: f, callerRun, schedules } = await world()
      f.finish(callerRun.runId)
      await expect(call('schedule_create', CREATE)).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(schedules.create).not.toHaveBeenCalled()
    })

    it('a read-only subagent cannot call any of them', async () => {
      const { call, readOnly, schedules } = await world()
      readOnly.add('caller')
      for (const name of TOOLS) await expect(call(name, { ...CREATE, jobId: 'x' }), name).rejects.toMatchObject({ code: 'mousse_read_only' })
      expect(schedules.create).not.toHaveBeenCalled()
    })
  })
})
