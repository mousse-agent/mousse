import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { AutomationDrafts, cliNameOf } from '../src/mms/automations/AutomationDrafts'
import { buildAutomationIndex } from '../src/mms/automations/AutomationIndex'
import { automationTools, type AutomationToolHost } from '../src/mms/run/mcp/appTools/automations'
import type { AppToolHost } from '../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../src/mms/run/mcp/appTools/types'
import { resolveRunTarget } from '../src/cli/commands/automation'
import { runNowRefusal } from '../src/mms/scheduled/runNowRefusal'
import type { PermissionMode } from '../src/shared/permissionMode'
import type { Thread } from '../src/shared/types'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.MOUSSE_HOME
  home = mkdtempSync(join(tmpdir(), 'mousse-drafts-'))
  process.env.MOUSSE_HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

function setup(options: { ceiling?: PermissionMode } = {}) {
  const store = new ScheduledJobStore(MousseConfigStore.load(home))
  const prompts: string[] = []
  const service = new ScheduledJobService({ runIsolated: async (prompt) => { prompts.push(prompt); return { text: 'Done.', silent: false } } }, store)
  ;(service as unknown as { stopped: boolean }).stopped = false
  const threads = new Map<string, Thread>([
    ['t-pr', { id: 't-pr', name: 'Fix checkout', projectId: 'p1', pullRequest: { number: 712 } } as Thread]
  ])
  const reused: string[] = []
  const drafts = new AutomationDrafts({
    get: (id) => service.getJob(id),
    list: () => service.listJobs(),
    create: (input) => service.createJob(input),
    update: (id, patch) => service.updateJob(id, patch),
    remove: (id) => service.deleteJob(id),
    pause: (id, reason, until) => service.pauseJob(id, reason, until),
    projects: () => [{ id: 'p1', name: 'mousse' }],
    thread: (id) => threads.get(id),
    savedAgent: (id) => id === 'agent-1',
    validate: (job) => ({ ...(job.selection ? { selection: job.selection } : {}) }),
    personCeiling: () => options.ceiling ?? 'accept_edits',
    reuseThread: (jobId) => { reused.push(jobId); return { id: `thread-for-${jobId}` } }
  })
  const tick = () => (service as unknown as { tickOwned: () => Promise<void> }).tickOwned()
  const settle = () => Promise.all([...(service as unknown as { inFlight: Map<string, Promise<void>> }).inFlight.values()])
  return { store, service, drafts, prompts, tick, settle, reused }
}

const PR_CHECK = {
  name: 'PR check',
  trigger: { kind: 'time', schedule: { kind: 'cron', expr: '0 5 * * 4' } },
  agent: { kind: 'default' },
  prompt: 'Review open PRs and comment on risky ones.',
  result: { thread: 'new', tellMe: 'news' }
}

describe('automation drafts', () => {
  it('saves a draft with its problems, asks one question, and turns on as the person\'s own automation', () => {
    const { drafts, service } = setup()
    const saved = drafts.save({ ...PR_CHECK, permissionMode: 'full' }, { managerThreadId: 'manager' })
    // No project yet: Turn on stays off, and the manager knows what to ask.
    expect(saved.problems).toEqual(['Which project should it run in?'])
    const stored = service.getJob(saved.draftId)!
    expect(stored).toMatchObject({ enabled: false, nextRunAt: null, draft: { draft: true, draftId: saved.draftId, managerThreadId: 'manager' } })
    // Held to what the person holds, even before Turn on.
    expect(stored.permissionMode).toBe('accept_edits')
    expect(() => drafts.turnOn(saved.draftId)).toThrow('Which project should it run in?')

    drafts.ask({ draftId: saved.draftId, question: 'Which project?', options: ['mousse', 'other', '', 'x', 'y'] }, { managerThreadId: 'manager' })
    expect(service.getJob(saved.draftId)!.draft!.ask).toMatchObject({ question: 'Which project?', options: ['mousse', 'other', 'x', 'y'] })
    drafts.answered(saved.draftId)
    expect(service.getJob(saved.draftId)!.draft!.ask).toBeUndefined()

    expect(drafts.save({ draftId: saved.draftId, project: 'Mousse' }, { managerThreadId: 'manager' }).problems).toEqual([])
    const on = drafts.turnOn(saved.draftId)
    expect(on).toMatchObject({ enabled: true, state: 'scheduled', projectId: 'p1', createThread: true, tellMe: 'news', permissionCeiling: 'accept_edits', permissionMode: 'accept_edits' })
    expect(on.draft).toBeUndefined()
    // A person's creation: no agent label, no end.
    expect(on.createdBy).toBeUndefined()
    expect(on.expiresAt).toBeUndefined()
    expect(Date.parse(on.nextRunAt!)).toBeGreaterThan(Date.now())
    // It stays on through a reload, with no draft left on it.
    const reloaded = new ScheduledJobStore(MousseConfigStore.load(home)).getJob(on.id)!
    expect(reloaded.draft).toBeUndefined()
    expect(reloaded.enabled).toBe(true)
  })

  it('never runs a draft: not when due, not by Run now, not by Resume or enabling it', async () => {
    const { drafts, service, store, prompts, tick, settle } = setup()
    const { draftId } = drafts.save({ ...PR_CHECK, project: 'p1', trigger: { kind: 'time', schedule: { kind: 'interval', minutes: 1 } } }, { managerThreadId: 'manager' })
    // Even a draft whose next run is somehow due is not claimed.
    store.updateJob(draftId, { nextRunAt: new Date(Date.now() - 60_000).toISOString() })
    await tick()
    await settle()
    expect(prompts).toEqual([])
    expect(runNowRefusal(service.getJob(draftId)!)).toMatch(/is a draft/)
    expect(() => service.triggerJob(draftId)).toThrow(/draft/)
    expect(() => service.resumeJob(draftId)).toThrow(/draft/)
    expect(() => service.updateJob(draftId, { enabled: true })).toThrow(/draft/)
    expect(service.getJob(draftId)!.enabled).toBe(false)
    // Discard deletes it.
    drafts.discard(draftId)
    expect(service.getJob(draftId)).toBeUndefined()
  })

  it('lists drafts in their own section of the index, never in Needs you', () => {
    const { drafts, service } = setup()
    const { draftId } = drafts.save(PR_CHECK, { managerThreadId: 'manager' })
    drafts.ask({ draftId, question: 'Skip draft PRs?', options: ['Yes', 'No'] }, { managerThreadId: 'manager' })
    const index = buildAutomationIndex({ jobs: () => service.listJobs(), thread: () => undefined, threads: () => [], projectName: () => 'mousse', threadMode: () => 'ask', computerName: 'Desk', timeZone: 'UTC' })
    const item = index.items.find((entry) => entry.id === draftId)!
    expect(item).toMatchObject({ paused: false, draft: { draftId, managerThreadId: 'manager', problems: ['Which project should it run in?'], ask: { question: 'Skip draft PRs?', options: ['Yes', 'No'] } }, result: { thread: 'new' } })
    expect(item.attention).toBeUndefined()
    expect(item.next).toBeUndefined()
  })

  it('maps a CLI trigger to a manual job with a stable name that `automation run` finds', () => {
    const { drafts, service } = setup()
    const first = drafts.save({ ...PR_CHECK, name: 'Deploy preview', project: 'p1', trigger: { kind: 'cli' } }, {})
    const second = drafts.save({ ...PR_CHECK, name: 'Deploy preview!', project: 'p1', trigger: { kind: 'cli' } }, {})
    const a = service.getJob(first.draftId)!
    const b = service.getJob(second.draftId)!
    expect(a).toMatchObject({ schedule: { kind: 'manual' }, cliName: 'deploy-preview' })
    expect(b.cliName).toBe('deploy-preview-2')
    drafts.turnOn(first.draftId)
    expect(service.getJob(first.draftId)!.cliName).toBe('deploy-preview')
    expect(resolveRunTarget(service.listJobs(), 'deploy-preview')).toBe(a.id)
    expect(resolveRunTarget(service.listJobs(), a.id.slice(0, 8))).toBe(a.id)
    expect(resolveRunTarget(service.listJobs(), 'nope')).toBeUndefined()
    expect(cliNameOf('  PR check: Thursday!  ')).toBe('pr-check-thursday')
  })

  it('reads the rest of the contract: a pull request event, a saved agent, a workflow, one reused thread', () => {
    const { drafts, service, reused } = setup()
    const event = drafts.save({ ...PR_CHECK, project: 'p1', trigger: { kind: 'thread_event', threadId: 't-pr', events: ['review'] } }, {})
    expect(event.problems).toEqual([])
    expect(service.getJob(event.draftId)).toMatchObject({ schedule: { kind: 'manual' }, threadId: 't-pr', trigger: { threadEvent: { threadId: 't-pr', number: 712, events: ['review'] } } })
    expect(drafts.save({ ...PR_CHECK, project: 'p1', agent: { kind: 'saved_agent', id: 'gone' } }, {}).problems).toEqual(['That saved agent does not exist or is not published.'])
    const workflow = drafts.save({ ...PR_CHECK, project: 'p1', agent: { kind: 'workflow', slug: 'release-notes' }, prompt: '--tag v1' }, {})
    expect(service.getJob(workflow.draftId)!.prompt).toBe('/release-notes --tag v1')
    const reuse = drafts.save({ ...PR_CHECK, project: 'p1', result: { thread: 'reuse', tellMe: 'problems' } }, {})
    const on = drafts.turnOn(reuse.draftId)
    expect(reused).toEqual([reuse.draftId])
    expect(on).toMatchObject({ threadId: `thread-for-${reuse.draftId}`, tellMe: 'problems' })
    expect(on.createThread).toBeUndefined()
    expect(drafts.list().find((entry) => entry.id === reuse.draftId)).toMatchObject({ draft: false, result: { thread: 'reuse', tellMe: 'problems' } })
  })

  it('changes and pauses an automation for "Change it…", never raising its May', () => {
    const { drafts, service } = setup({ ceiling: 'auto' })
    const { draftId } = drafts.save({ ...PR_CHECK, project: 'p1', permissionMode: 'accept_edits' }, {})
    drafts.turnOn(draftId)
    const changed = drafts.update({ id: draftId, trigger: { kind: 'time', schedule: { kind: 'cron', expr: '0 8 * * 1' } }, permissionMode: 'full' })
    expect(changed.trigger).toEqual({ kind: 'time', schedule: { kind: 'cron', expr: '0 8 * * 1' } })
    expect(changed.permissionMode).toBe('accept_edits')
    expect(() => drafts.update({ id: draftId, project: 'elsewhere' })).toThrow(/no project "elsewhere"/)
    const until = new Date(Date.now() + 86_400_000).toISOString()
    expect(drafts.pause({ id: draftId, until })).toMatchObject({ paused: true })
    expect(service.getJob(draftId)!.resumeAt).toBe(until)
  })
})

describe('the automation tools', () => {
  const ctx = (threadId: string) => ({ caller: { threadId, runId: 'r1' }, turn: { threadId }, toolCallId: 'c1' }) as unknown as ToolCallContext

  it('work for the manager\'s thread and a bot, and nowhere else', async () => {
    const { drafts } = setup()
    const tools: AutomationToolHost = { drafts, isManagerThread: (id) => id === 'manager', botOf: (id) => (id === 'bot-thread' ? 'bot_1' : undefined) }
    const list = automationTools({ automations: () => tools } as unknown as AppToolHost)
    expect(list.map((tool) => tool.name)).toEqual(['automation_draft_save', 'automation_ask', 'automation_list', 'automation_update', 'automation_pause'])
    const save = list[0]!
    expect(save.available!({ threadId: 'other' } as never)).toMatch(/Only the Automation manager/)
    expect(save.available!({ threadId: 'manager' } as never)).toBe(true)
    const result = JSON.parse((await save.handler({ ...PR_CHECK, project: 'mousse' }, ctx('manager'))).text) as { draftId: string; problems: string[] }
    expect(result.problems).toEqual([])
    // A bot writes its own drafts; it cannot change the manager's.
    expect((await save.handler({ ...PR_CHECK, draftId: result.draftId }, ctx('bot-thread'))).isError).toBe(true)
    const botDraft = JSON.parse((await save.handler(PR_CHECK, ctx('bot-thread'))).text) as { draftId: string }
    expect(drafts.list().find((entry) => entry.id === botDraft.draftId)).toMatchObject({ draft: true })
    await expect(Promise.resolve().then(() => save.handler(PR_CHECK, ctx('other')))).rejects.toThrow(/Only the Automation manager/)
    // A shape the tool cannot read is an error the agent reads, not a crash.
    expect((await save.handler({ ...PR_CHECK, trigger: { kind: 'weekly' } }, ctx('manager'))).isError).toBe(true)
  })
})

describe('the tool list', () => {
  it('offers the schedule tools once the profile hands its jobs over after the list was built, and the automation tools to the manager only', async () => {
    const { createAppToolRegistry } = await import('../src/mms/run/mcp/appTools')
    const { fakeAppToolHost } = await import('./run/appToolsFixture')
    const { drafts } = setup()
    const host = fakeAppToolHost().host
    host.agentAccess = () => ({ level: 'manage', projectIds: [] })
    const tools: AutomationToolHost = { drafts, isManagerThread: (id) => id === 'manager', botOf: () => undefined }
    host.automations = () => tools
    const { registry } = createAppToolRegistry({ host, engine: {} as never })
    const names = (threadId: string) => registry.listForThread(threadId, 'default', 'manage').map((tool) => tool.name)
    expect(names('t1')).not.toContain('schedule_list')
    host.schedules = { jobLimits: () => ({ maxActive: 10, minIntervalMinutes: 15, lifetimeDays: 7 }) } as AppToolHost['schedules']
    expect(names('t1')).toEqual(expect.arrayContaining(['schedule_list', 'schedule_create', 'schedule_update', 'schedule_pause', 'schedule_run']))
    expect(names('t1')).not.toContain('automation_draft_save')
    expect(names('manager')).toEqual(expect.arrayContaining(['automation_draft_save', 'automation_ask', 'automation_list', 'automation_update', 'automation_pause']))
  })
})
