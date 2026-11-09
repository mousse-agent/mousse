import { narrowPermissionMode, isPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { isTellMe, tellMeOf, type CreateScheduledJobInput, type JobSchedule, type ScheduledJob, type TellMe, type Thread, type ThreadEventKind } from '../../shared/types'
import type { ModelOverride } from '../../shared/providerInstances'
import { isWorkflowPrompt } from '../../shared/jobPermissionEdit'
import { asCreateScheduledJobInput } from '../protocol/validators'
import { computeNextRun, cronProblem } from '../scheduled/computeNextRun'

/**
 * Automation drafts: what the Automation manager (or a bot) builds from a person's words, in the contract of the v4
 * page (Trigger → Agent → Result). A draft is a stored job that is never enabled and never runs. Turn on makes it an
 * ordinary automation the person created (their permission ceiling, no agent limits, no end); Discard deletes it.
 * The app tools (`automation_*`) and the page's methods (`automations.drafts.*`) both act through this one service.
 */

export type DraftTrigger =
  | { kind: 'time'; schedule: JobSchedule }
  | { kind: 'cli'; name?: string }
  | { kind: 'http' }
  | { kind: 'thread_event'; threadId: string; events: ThreadEventKind[] }

export type DraftAgent =
  | { kind: 'default' }
  | { kind: 'model'; instanceId: string; model: string }
  | { kind: 'saved_agent'; id: string }
  | { kind: 'workflow'; slug: string }
  | { kind: 'bot'; botId: string }

export interface DraftResult {
  thread: 'new' | 'reuse'
  tellMe: TellMe
  botChat?: string
}

/** One automation in the contract, as `automation_list` returns it. */
export interface AutomationContract {
  id: string
  name: string
  draft: boolean
  enabled: boolean
  paused: boolean
  trigger: DraftTrigger
  agent: DraftAgent
  prompt: string
  project: { id: string; name: string } | null
  result: DraftResult
  permissionMode: PermissionMode | null
  nextRunAt: string | null
  cliName?: string
  problems?: string[]
  ask?: { question: string; options: string[] }
}

/** Who wrote a draft: the manager's hidden thread, or a bot. */
export interface DraftAuthor {
  managerThreadId?: string
  botId?: string
}

export interface AutomationDraftsDeps {
  get(id: string): ScheduledJob | undefined
  list(): ScheduledJob[]
  create(input: CreateScheduledJobInput): ScheduledJob
  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null
  remove(id: string): boolean
  pause(id: string, reason?: string, until?: string): ScheduledJob | null
  projects(): Array<{ id: string; name: string }>
  thread(id: string): Pick<Thread, 'id' | 'projectId' | 'pullRequest' | 'settledAt'> | undefined
  /** Whether a saved agent exists and has a published revision. */
  savedAgent?(id: string): boolean
  /** Whether a workflow with this slug exists. */
  workflow?(slug: string): boolean
  /** Checks the model as the protocol does; throws words the manager can act on. */
  validate(job: { projectId?: string; threadId?: string; selection?: ModelOverride }): { selection?: ModelOverride; threadId?: string }
  /** The mode the person holds for a run on this thread (or the profile's): Turn on holds the draft to it. */
  personCeiling(threadId?: string): PermissionMode
  /** One reusable thread for every run of an automation (Result: reuse). */
  reuseThread(jobId: string, name: string, projectId?: string): { id: string }
  /** The scheduler and the page hear of a change. */
  changed?(): void
  now?(): Date
}

const MAX_NAME = 120
const MAX_QUESTION = 300
const MAX_OPTIONS = 4
const MAX_OPTION = 60
const EVENT_KINDS: readonly ThreadEventKind[] = ['checks_failed', 'checks_passed', 'review', 'comment']

export class AutomationDraftError extends Error {}

function fail(message: string): never {
  throw new AutomationDraftError(message)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string') fail(`${name} must be a string`)
  return value.trim().slice(0, max)
}

/** A stable CLI name from a name: lowercase words joined by dashes. */
export function cliNameOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'automation'
}

function parseTrigger(value: unknown): DraftTrigger {
  const raw = object(value, 'trigger')
  switch (raw.kind) {
    case 'time': {
      const checked = asCreateScheduledJobInput({ name: 'x', prompt: 'x', schedule: raw.schedule })
      if (checked.schedule.kind === 'manual') fail('A time trigger needs a schedule with a clock; use { kind: "cli" } for one you start by hand.')
      return { kind: 'time', schedule: checked.schedule }
    }
    case 'cli':
      return { kind: 'cli', ...(typeof raw.name === 'string' && raw.name.trim() ? { name: cliNameOf(raw.name) } : {}) }
    case 'http':
      return { kind: 'http' }
    case 'thread_event': {
      const events = Array.isArray(raw.events) ? raw.events.filter((event): event is ThreadEventKind => EVENT_KINDS.includes(event as ThreadEventKind)) : []
      if (!events.length) fail(`trigger.events lists one or more of ${EVENT_KINDS.join(', ')}`)
      return { kind: 'thread_event', threadId: text(raw.threadId, 'trigger.threadId', 256), events: [...new Set(events)] }
    }
    default:
      return fail('trigger.kind is time, cli, http or thread_event')
  }
}

function parseAgent(value: unknown): DraftAgent {
  if (value === undefined || value === null) return { kind: 'default' }
  const raw = object(value, 'agent')
  switch (raw.kind) {
    case 'default':
      return { kind: 'default' }
    case 'model':
      return { kind: 'model', instanceId: text(raw.instanceId, 'agent.instanceId', 256), model: text(raw.model, 'agent.model', 256) }
    case 'saved_agent':
      return { kind: 'saved_agent', id: text(raw.id, 'agent.id', 256) }
    case 'workflow':
      return { kind: 'workflow', slug: text(raw.slug, 'agent.slug', 128).replace(/^\//, '') }
    case 'bot':
      return { kind: 'bot', botId: text(raw.botId, 'agent.botId', 256) }
    default:
      return fail('agent.kind is default, model, saved_agent, workflow or bot')
  }
}

function parseResult(value: unknown): DraftResult {
  if (value === undefined || value === null) return { thread: 'new', tellMe: 'news' }
  const raw = object(value, 'result')
  const thread = raw.thread === undefined ? 'new' : raw.thread
  if (thread !== 'new' && thread !== 'reuse') fail('result.thread is new or reuse')
  const tellMe = raw.tellMe === undefined ? 'news' : raw.tellMe
  if (!isTellMe(tellMe)) fail('result.tellMe is every, news or problems')
  return { thread, tellMe, ...(typeof raw.botChat === 'string' && raw.botChat ? { botChat: raw.botChat } : {}) }
}

/** The fields of a save or an update, read from a tool's arguments. Only what is given is set. */
interface DraftFields {
  name?: string
  trigger?: DraftTrigger
  agent?: DraftAgent
  prompt?: string
  project?: string | null
  result?: DraftResult
  permissionMode?: PermissionMode
}

function parseFields(args: Record<string, unknown>): DraftFields {
  const fields: DraftFields = {}
  if (args.name !== undefined) fields.name = text(args.name, 'name', MAX_NAME)
  if (args.trigger !== undefined) fields.trigger = parseTrigger(args.trigger)
  if (args.agent !== undefined) fields.agent = parseAgent(args.agent)
  if (args.prompt !== undefined) fields.prompt = text(args.prompt, 'prompt')
  if (args.project !== undefined) fields.project = args.project === null ? null : text(args.project, 'project', 256)
  if (args.result !== undefined) fields.result = parseResult(args.result)
  if (args.permissionMode !== undefined) {
    if (!isPermissionMode(args.permissionMode)) fail('permissionMode is ask, accept_edits, auto or full')
    fields.permissionMode = args.permissionMode
  }
  return fields
}

/** The automation's Trigger, Agent and Result read back from its job. */
export function contractOf(job: ScheduledJob, projectName: (id: string) => string | undefined): AutomationContract {
  const wakesOn = job.trigger?.threadEvent
  const trigger: DraftTrigger = wakesOn
    ? { kind: 'thread_event', threadId: wakesOn.threadId, events: [...wakesOn.events] }
    : job.trigger?.webhook ? { kind: 'http' }
    : job.schedule.kind === 'manual' ? { kind: 'cli', ...(job.cliName ? { name: job.cliName } : {}) }
    : { kind: 'time', schedule: job.schedule }
  const workflow = isWorkflowPrompt(job.prompt)
  const agent: DraftAgent = workflow
    ? { kind: 'workflow', slug: job.prompt.trim().split(/\s+/)[0]!.slice(1) }
    : job.agent ? { kind: 'saved_agent', id: job.agent.definitionId }
    : job.bot ? { kind: 'bot', botId: job.bot.botId }
    : job.selection?.instanceId ? { kind: 'model', instanceId: job.selection.instanceId, model: job.selection.model }
    : { kind: 'default' }
  const prompt = workflow ? job.prompt.trim().split(/\s+/).slice(1).join(' ') : job.prompt
  const reuse = Boolean(job.draft?.reuseThread || (job.threadId && !wakesOn))
  return {
    id: job.id,
    name: job.name,
    draft: Boolean(job.draft),
    enabled: job.enabled,
    paused: !job.draft && (job.state === 'paused' || !job.enabled),
    trigger,
    agent,
    prompt,
    project: job.projectId ? { id: job.projectId, name: projectName(job.projectId) ?? 'Removed project' } : null,
    result: { thread: reuse ? 'reuse' : 'new', tellMe: tellMeOf(job) },
    permissionMode: job.permissionMode ?? null,
    nextRunAt: job.nextRunAt,
    ...(job.cliName ? { cliName: job.cliName } : {}),
    ...(job.draft ? { problems: job.draft.problems } : {}),
    ...(job.draft?.ask ? { ask: { question: job.draft.ask.question, options: job.draft.ask.options } } : {})
  }
}

export class AutomationDrafts {
  constructor(private readonly deps: AutomationDraftsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private projectName = (id: string): string | undefined => this.deps.projects().find((project) => project.id === id)?.name

  private draftJob(draftId: string): ScheduledJob {
    const job = this.deps.get(draftId)
    if (!job?.draft) fail(`No draft ${draftId}.`)
    return job
  }

  /** A project named by id or by name (any case); a problem when it is missing or unknown. */
  private resolveProject(project: string | null | undefined, problems: string[]): string | undefined {
    if (!project) {
      problems.push('Which project should it run in?')
      return undefined
    }
    const projects = this.deps.projects()
    const found = projects.find((entry) => entry.id === project) ?? projects.find((entry) => entry.name.toLowerCase() === project.toLowerCase())
    if (!found) problems.push(`There is no project "${project}". Name one of: ${projects.map((entry) => entry.name).join(', ') || 'none yet'}.`)
    return found?.id
  }

  /** A unique CLI name: the asked one, else one from the name, with a number when another automation has it. */
  private uniqueCliName(base: string, ownId: string | undefined): string {
    const taken = new Set(this.deps.list().filter((job) => job.id !== ownId && job.cliName).map((job) => job.cliName!))
    if (!taken.has(base)) return base
    for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`
  }

  /**
   * The job a draft's fields make, with what keeps Turn on off. `current` is the job being changed (a draft, or an
   * automation for `update`); its values fill what the fields leave out.
   */
  private build(fields: DraftFields, current: ScheduledJob | undefined): { job: Partial<ScheduledJob> & { name: string; prompt: string; schedule: JobSchedule }; problems: string[]; reuseThread: boolean } {
    const problems: string[] = []
    const before = current ? contractOf(current, this.projectName) : undefined
    const name = fields.name ?? before?.name ?? ''
    const trigger = fields.trigger ?? before?.trigger ?? { kind: 'cli' }
    const agent = fields.agent ?? before?.agent ?? { kind: 'default' }
    const promptText = fields.prompt ?? before?.prompt ?? ''
    const result = fields.result ?? before?.result ?? { thread: 'new', tellMe: 'news' }
    const projectId = fields.project !== undefined ? this.resolveProject(fields.project, problems) : current?.projectId ?? this.resolveProject(undefined, problems)

    if (!name) problems.push('Give it a name.')
    let schedule: JobSchedule = { kind: 'manual' }
    let threadEvent: ScheduledJob['trigger'] | undefined
    let boundThread: string | undefined
    let cliName: string | undefined
    switch (trigger.kind) {
      case 'time': {
        schedule = trigger.schedule
        if (schedule.kind === 'cron') {
          const problem = cronProblem(schedule.expr ?? '')
          if (problem) problems.push(problem)
        }
        if (schedule.kind === 'once' && (!schedule.runAt || Date.parse(schedule.runAt) <= this.now().getTime())) problems.push('The time to run once is in the past.')
        break
      }
      case 'cli':
        cliName = this.uniqueCliName(trigger.name ?? current?.cliName ?? cliNameOf(name), current?.id)
        break
      case 'http':
        // A request URL and its secret are set up by a person, in Edit details › More, once it is on.
        break
      case 'thread_event': {
        const thread = this.deps.thread(trigger.threadId)
        if (!thread || thread.settledAt) problems.push(`There is no thread ${trigger.threadId}.`)
        else if (!thread.pullRequest) problems.push('That thread has no pull request to watch.')
        else {
          threadEvent = { threadEvent: { threadId: thread.id, number: thread.pullRequest.number, events: trigger.events } }
          boundThread = thread.id
        }
        break
      }
    }

    let prompt = promptText
    let selection: ModelOverride | undefined
    let savedAgent: ScheduledJob['agent']
    switch (agent.kind) {
      case 'model':
        try {
          selection = this.deps.validate({ ...(projectId ? { projectId } : {}), selection: { instanceId: agent.instanceId, model: agent.model } as ModelOverride }).selection
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error))
        }
        break
      case 'saved_agent':
        if (this.deps.savedAgent && !this.deps.savedAgent(agent.id)) problems.push('That saved agent does not exist or is not published.')
        savedAgent = { definitionId: agent.id }
        break
      case 'workflow':
        if (this.deps.workflow && !this.deps.workflow(agent.slug)) problems.push(`There is no workflow /${agent.slug}.`)
        prompt = `/${agent.slug}${promptText ? ` ${promptText}` : ''}`
        break
      case 'bot':
        problems.push('A bot as the agent is set up from the bot\'s chat for now. Pick the default agent, a model or a saved agent.')
        break
    }
    if (!prompt.trim()) problems.push('Say what it should do.')
    if (result.botChat) problems.push('Sending the result to a bot\'s chat is not available yet. Use the run\'s thread and Tell me.')
    if (result.thread === 'reuse' && trigger.kind === 'thread_event') problems.push('An automation that wakes on a pull request runs on that pull request\'s thread.')

    // The schedule the job will have is checked by the protocol's own rules.
    try {
      asCreateScheduledJobInput({ name: name || 'x', prompt: prompt || 'x', schedule })
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }

    const job: Partial<ScheduledJob> & { name: string; prompt: string; schedule: JobSchedule } = {
      name: name || 'New automation',
      prompt,
      schedule,
      projectId,
      selection,
      agent: savedAgent,
      tellMe: result.tellMe,
      cliName,
      trigger: threadEvent ?? (current?.trigger?.webhook ? { webhook: current.trigger.webhook } : undefined),
      threadId: boundThread ?? (result.thread === 'reuse' ? current?.threadId : undefined),
      createThread: !boundThread && result.thread === 'new' ? true : undefined,
      ...(fields.permissionMode !== undefined ? { permissionMode: fields.permissionMode } : {})
    }
    return { job, problems, reuseThread: result.thread === 'reuse' && !boundThread }
  }

  /** `automation_draft_save`: makes or changes a draft. Never enables it. */
  save(args: Record<string, unknown>, author: DraftAuthor): { draftId: string; problems: string[] } {
    const draftId = args.draftId === undefined ? undefined : text(args.draftId, 'draftId', 256)
    const current = draftId ? this.draftJob(draftId) : undefined
    // A bot changes only its own drafts, and the manager only its own and the person's.
    if (current && current.draft!.botId !== author.botId) fail(`No draft ${draftId}.`)
    const fields = parseFields(args)
    const { job, problems, reuseThread } = this.build(fields, current)
    // Held to what the person holds now; Turn on holds it again.
    const ceiling = this.deps.personCeiling(job.threadId)
    const permissionMode = job.permissionMode ? narrowPermissionMode(job.permissionMode, ceiling) : current?.permissionMode
    const draft = {
      draft: true as const,
      draftId: current?.id ?? '',
      ...(author.managerThreadId ?? current?.draft?.managerThreadId ? { managerThreadId: author.managerThreadId ?? current?.draft?.managerThreadId } : {}),
      ...(author.botId ? { botId: author.botId } : {}),
      problems,
      // A new save answers the open question unless it asks again (`automation_ask`).
      ...(reuseThread ? { reuseThread: true as const } : {})
    }
    if (current) {
      const updated = this.deps.update(current.id, { ...job, permissionMode, permissionCeiling: ceiling, draft: { ...draft, draftId: current.id } })
      if (!updated) fail(`No draft ${draftId}.`)
      this.deps.changed?.()
      return { draftId: current.id, problems }
    }
    const created = this.deps.create({
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule,
      ...(job.projectId ? { projectId: job.projectId } : {}),
      ...(job.selection ? { selection: job.selection } : {}),
      ...(job.agent ? { agent: job.agent } : {}),
      ...(job.threadId ? { threadId: job.threadId } : {}),
      ...(job.createThread ? { createThread: true } : {}),
      ...(job.trigger?.threadEvent ? { threadEvent: job.trigger.threadEvent } : {}),
      ...(job.tellMe ? { tellMe: job.tellMe } : {}),
      ...(job.cliName ? { cliName: job.cliName } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      permissionCeiling: ceiling,
      draft
    })
    // The draft's id is the job's: it is known once the job is stored.
    this.deps.update(created.id, { draft: { ...draft, draftId: created.id } })
    this.deps.changed?.()
    return { draftId: created.id, problems }
  }

  /** "Set up by hand": a blank draft the person fills in with Edit details. */
  blank(projectId?: string): ScheduledJob {
    const { draftId } = this.save({ name: 'New automation', trigger: { kind: 'cli' }, prompt: '', ...(projectId ? { project: projectId } : {}) }, {})
    return this.deps.get(draftId)!
  }

  /** `automation_ask`: one open question under the draft, with quick answers. A new one replaces the last. */
  ask(args: Record<string, unknown>, author: DraftAuthor): { draftId: string } {
    const draftId = text(args.draftId, 'draftId', 256)
    const job = this.draftJob(draftId)
    if (job.draft!.botId !== author.botId) fail(`No draft ${draftId}.`)
    const question = text(args.question, 'question', MAX_QUESTION)
    if (!question) fail('question must not be empty')
    const options = args.options === undefined ? [] : Array.isArray(args.options) ? args.options : fail('options must be a list of short answers')
    const answers = options.filter((option): option is string => typeof option === 'string' && option.trim() !== '').map((option) => option.trim().slice(0, MAX_OPTION)).slice(0, MAX_OPTIONS)
    this.deps.update(job.id, { draft: { ...job.draft!, ask: { question, options: answers, at: this.now().toISOString() } } })
    this.deps.changed?.()
    return { draftId: job.id }
  }

  /** The person answered the open question (the answer goes to the manager as a message). */
  answered(draftId: string): void {
    const job = this.draftJob(draftId)
    if (!job.draft!.ask) return
    const { ask: _ask, ...rest } = job.draft!
    this.deps.update(job.id, { draft: rest })
    this.deps.changed?.()
  }

  /** `automation_list`: the profile's automations (not a bot's own schedules) and drafts, in the contract. */
  list(): AutomationContract[] {
    return this.deps.list().filter((job) => !job.bot).map((job) => contractOf(job, this.projectName))
  }

  /**
   * `automation_update`: changes an automation or a draft. An automation keeps running; a change that would leave it
   * with a problem is refused. Its May can only be lowered here; raising it is for the person, in Edit details.
   */
  update(args: Record<string, unknown>): AutomationContract {
    const id = text(args.id, 'id', 256)
    const job = this.deps.get(id)
    if (!job || job.bot) fail(`No automation ${id}.`)
    const fields = parseFields(args)
    if (!Object.keys(fields).length) fail('Pass at least one field to change.')
    if (job.draft) {
      this.save({ ...args, draftId: id }, { ...(job.draft.managerThreadId ? { managerThreadId: job.draft.managerThreadId } : {}), ...(job.draft.botId ? { botId: job.draft.botId } : {}) })
      return contractOf(this.deps.get(id)!, this.projectName)
    }
    const { job: next, problems, reuseThread } = this.build(fields, job)
    if (problems.length) fail(problems.join(' '))
    if (fields.trigger?.kind === 'http' && !job.trigger?.webhook) fail('A request URL is set up by the person, in Edit details › More.')
    const permissionMode = next.permissionMode ? narrowPermissionMode(next.permissionMode, job.permissionCeiling ?? 'ask', job.permissionMode) : job.permissionMode
    const threadId = reuseThread ? job.threadId ?? this.deps.reuseThread(job.id, next.name, next.projectId).id : next.threadId
    // A new clock moves the next run with it; a paused automation gets its next run when it resumes.
    const scheduleChanged = JSON.stringify(next.schedule) !== JSON.stringify(job.schedule)
    const nextRun = scheduleChanged && job.enabled && job.state !== 'paused' && job.state !== 'running' ? { nextRunAt: computeNextRun(next.schedule) } : {}
    const updated = this.deps.update(job.id, { ...next, ...nextRun, permissionMode, threadId, ...(reuseThread ? { createThread: undefined } : {}) })
    if (!updated) fail(`No automation ${id}.`)
    this.deps.changed?.()
    return contractOf(updated, this.projectName)
  }

  /** `automation_pause`: pauses an automation, until a time or until the person resumes it. */
  pause(args: Record<string, unknown>): AutomationContract {
    const id = text(args.id, 'id', 256)
    const job = this.deps.get(id)
    if (!job || job.bot) fail(`No automation ${id}.`)
    if (job.draft) fail('A draft does not run; there is nothing to pause.')
    let until: string | undefined
    if (args.until !== undefined) {
      const at = Date.parse(text(args.until, 'until', 64))
      if (!Number.isFinite(at)) fail('until must be a date and time')
      if (at <= this.now().getTime()) fail('until must be in the future')
      until = new Date(at).toISOString()
    }
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : undefined
    const paused = this.deps.pause(job.id, reason, until)
    if (!paused) fail(`No automation ${id}.`)
    this.deps.changed?.()
    return contractOf(paused, this.projectName)
  }

  /**
   * Turn on: the person makes the draft an automation of their own. Its problems are worked out again first; its May
   * is held to the mode the person holds now; a reused thread is made now.
   */
  turnOn(draftId: string): ScheduledJob {
    const job = this.draftJob(draftId)
    const { problems, reuseThread } = this.build({}, job)
    if (problems.length) {
      this.deps.update(job.id, { draft: { ...job.draft!, problems } })
      this.deps.changed?.()
      fail(problems[0]!)
    }
    const threadId = reuseThread ? this.deps.reuseThread(job.id, job.name, job.projectId).id : job.threadId
    const ceiling = this.deps.personCeiling(threadId)
    const updated = this.deps.update(job.id, {
      draft: undefined,
      enabled: true,
      permissionCeiling: ceiling,
      ...(job.permissionMode ? { permissionMode: narrowPermissionMode(job.permissionMode, ceiling) } : {}),
      ...(reuseThread ? { threadId, createThread: undefined } : {})
    })
    if (!updated) fail(`No draft ${draftId}.`)
    this.deps.changed?.()
    return updated
  }

  /** A draft changed by hand (Edit details): what keeps Turn on off is worked out again. */
  recheck(draftId: string): void {
    const job = this.deps.get(draftId)
    if (!job?.draft) return
    const { problems } = this.build({}, job)
    if (JSON.stringify(problems) !== JSON.stringify(job.draft.problems)) this.deps.update(job.id, { draft: { ...job.draft, problems } })
  }

  /** Discard: the draft is deleted. */
  discard(draftId: string): void {
    const job = this.draftJob(draftId)
    this.deps.remove(job.id)
    this.deps.changed?.()
  }
}
