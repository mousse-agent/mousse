import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, MessageSquare } from '../../lib/icons'
import { modelLabel } from '../../../shared/modelChoice'
import { resolveModelChoice } from '../../lib/modelChoice'
import { describePermissionMode, narrowPermissionMode, PERMISSION_MODES, isStricter, type PermissionMode } from '../../../shared/permissionMode'
import { TELL_ME_LABELS, type AutomationItem, type AutomationRun } from '../../../shared/automations'
import { TELL_ME_VALUES, type ScheduledJob, type TellMe } from '../../../shared/types'
import { parseSimpleCron, WEEKDAY_NAMES } from '../../../shared/scheduleLabel'
import { Select, type SelectOption } from '../ui/Select'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import {
  cronFormOf,
  cronOfForm,
  cronParts,
  heldPermissionMode,
  isUnchanged,
  loweredPermission,
  modeChoices,
  patchOf,
  scheduleOf,
  showsWorkspace,
  validateDraft,
  workspaceChoices,
  type CronForm,
  type DraftField,
  type JobDraft,
  type ScheduledCatalog,
  type WorkspaceKind
} from '../scheduled/jobDraft'
import { describeScheduleLong, errorText, nameFromPrompt, scheduleCode, WEEKDAY_OPTIONS } from '../scheduled/scheduledLabels'
import { ownedWhenText, skippedDates, whenText, zoneName } from './automationTime'
import { runText } from './automationList'
import { isWorkflowPrompt } from '../../../shared/jobPermissionEdit'
import { parseWhoKey, whoKey, whoName as nameOfWho, whoOptions, type AutomationLibrary, type Who } from './whoDo'
import { DoPicker, useWorkflowFields, WorkflowInputs } from './WhoDoPickers'
import { parseWorkflowCommand, workflowCommandText } from '../../../shared/workflows/workflowCommand'
import { BotFaceStill } from '../bots/face/BotFace'

/** The custom schedule builder's choices. Daily and Weekly are plain forms that save as cron. */
type BuilderKind = 'interval' | 'daily' | 'weekly' | 'cron' | 'once' | 'manual'

const BUILDER_KINDS: Array<{ value: BuilderKind; label: string }> = [
  { value: 'interval', label: 'Every…' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron' },
  { value: 'once', label: 'Once' },
  { value: 'manual', label: 'On demand' }
]
/** A bot repeats: Once and On demand are something you ask it in its chat. */
const BOT_BUILDER_KINDS = BUILDER_KINDS.filter((option) => option.value !== 'once' && option.value !== 'manual')

/** Why a bot can't keep this When, by field; empty when it can. A bot runs at most every 5 minutes. */
export function botScheduleErrors(draft: JobDraft): Partial<Record<DraftField, string>> {
  if (draft.scheduleKind === 'once' || draft.scheduleKind === 'manual') return { schedule: 'A bot repeats. For one run, ask it in its chat.' }
  if (draft.scheduleKind === 'interval' && Number(draft.minutes) < 5) return { minutes: 'A bot runs at most every 5 minutes.' }
  if (draft.scheduleKind === 'cron') {
    const cron = parseSimpleCron(draft.expr)
    if (cron?.kind === 'minutes' && cron.every < 5) return { expr: 'A bot runs at most every 5 minutes.' }
  }
  return {}
}

export const PROJECT_WORKSPACE_WARNING =
  'The run works in your own checkout, unattended, with no checkpoints or undo. For a Git project, a new worktree per run is safer.'

/** Fields that live behind More: a problem in one opens it. */
const MORE_FIELDS = new Set<DraftField>(['name', 'worktreePath', 'workspace'])
const BUILDER_FIELDS = new Set<DraftField>(['minutes', 'expr', 'runAt', 'schedule'])
const RECENT_RUNS = 5

/** The When of the sentence: "Every weekday at 9:00", "Every 30 minutes", "When you run it". */
export function whenSentence(draft: JobDraft): string {
  const schedule = scheduleOf(draft)
  if (schedule.kind === 'manual') return 'When you run it'
  if (schedule.kind === 'interval') {
    const minutes = schedule.minutes ?? 0
    if (minutes === 60) return 'Every hour'
    if (minutes > 60 && minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`
    if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`
    return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`
  }
  if (schedule.kind === 'once') return describeScheduleLong(schedule)
  const cron = parseSimpleCron(schedule.expr)
  if (!cron) return 'On a custom schedule'
  if (cron.kind === 'minutes') return `Every ${cron.every} minutes`
  if (cron.kind === 'hours') return cron.every === 1 ? 'Every hour' : `Every ${cron.every} hours`
  const time = new Date(2000, 0, 3, cron.hour, cron.minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = cron.days
  const day = days === 'all' || days.length === 7
    ? 'day'
    : days.join(',') === '1,2,3,4,5' ? 'weekday' : days.join(',') === '0,6' ? 'weekend day' : days.map((entry) => WEEKDAY_NAMES[entry]!.slice(0, days.length === 1 ? undefined : 3)).join(', ')
  return `Every ${day} at ${time}`
}

/** The glyph of a run in the Runs list. */
const RUN_GLYPH: Record<AutomationRun['state'], string> = {
  done: '✓', nothing_new: '·', incomplete: '◐', failed: '✕', queued: '◌', running: '◌', waiting: '◷'
}

function MoreRow({ title, htmlFor, description, control, children, field, testId }: {
  title: string
  htmlFor?: string
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
  field?: DraftField
  testId?: string
}) {
  return (
    <div className="scheduled-detail-row" data-field={field} data-testid={testId}>
      <div className="scheduled-detail-text">
        {htmlFor ? <label className="scheduled-detail-title" htmlFor={htmlFor}>{title}</label> : <span className="scheduled-detail-title">{title}</span>}
        {description ? <div className="scheduled-detail-desc">{description}</div> : null}
      </div>
      {control ? <div className="scheduled-detail-control">{control}</div> : null}
      {children ? <div className="scheduled-detail-extra">{children}</div> : null}
    </div>
  )
}

/**
 * An automation's detail: the sentence is the editor ("Every [weekday at 9:00], [Claude] does [this] in [mousse]."),
 * then the prompt, May and Tell me, the next run with its reasons, the runs, and More with everything technical.
 * Saving sends only what changed. Escape goes back. A bot's automation is the same record: its Who stays the bot,
 * its May is the bot's grant, and only When, Do, the name and Tell me change.
 */
export function AutomationDetail({
  job,
  item,
  initial,
  catalog,
  library,
  defaultName,
  profileId,
  viewerZone,
  save,
  onBack,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onWebhook,
  onKeep,
  onOpenThread,
  onOpenBot
}: {
  job: ScheduledJob
  item?: AutomationItem
  initial: JobDraft
  catalog: ScheduledCatalog
  /** Saved agents and workflows that fill Who and Do. */
  library: AutomationLibrary
  /** The default agent's name. */
  defaultName: string
  profileId: string
  viewerZone: string
  save: (draft: JobDraft) => Promise<void>
  onBack: () => void
  onRunNow: () => void
  onPause: () => void
  onResume: () => void
  onDelete: () => void
  onWebhook: () => void
  /** Keep: an agent-added automation loses only its end. */
  onKeep: () => void
  onOpenThread: (threadId: string) => void
  /** A bot's automation: opens the bot's chat, where its grant (its May) is shown. */
  onOpenBot?: (botId: string) => void
}) {
  const [draft, setDraft] = useState<JobDraft>(initial)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [whyOpen, setWhyOpen] = useState(false)
  const [allRuns, setAllRuns] = useState(false)
  const [cronForm, setCronForm] = useState<CronForm>(() => cronFormOf(initial.expr))
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const ids = useId()
  const id = (field: string) => `${ids}-${field}`
  useEffect(() => () => { mounted.current = false }, [])

  const held = heldPermissionMode(draft, catalog, job)
  const choosingPermission = draft.permissionMode !== initial.permissionMode
  const bot = job.bot && item?.who.kind === 'bot' ? { id: job.bot.botId, name: item.who.name, look: item.who.look } : undefined
  const errors = useMemo(
    () => ({
      ...validateDraft(draft, { hasWebhook: Boolean(job.trigger?.webhook), requireName: true, ...(choosingPermission ? { held: held.mode } : {}) }),
      ...(job.bot ? botScheduleErrors(draft) : {})
    }),
    [draft, job, choosingPermission, held.mode]
  )
  const shown = attempted ? errors : {}
  const patch = (changes: Partial<JobDraft>) => { setDraft((current) => ({ ...current, ...changes })); setFailure(null) }
  const unchanged = isUnchanged(patchOf(initial, draft, catalog))
  const lowered = loweredPermission(draft, initial, catalog, job)
  const builderKind: BuilderKind = draft.scheduleKind === 'cron' ? cronForm : draft.scheduleKind
  const parts = cronParts(draft.expr)
  // A bot's row is paused too while its bot is (Resume then resumes the bot).
  const paused = job.state === 'paused' || item?.pausedBy === 'bot'
  const owner = item?.computer ?? { name: 'This computer', timeZone: viewerZone, local: true }
  const now = new Date()

  const chooseBuilderKind = (kind: BuilderKind) => {
    if (kind === 'daily' || kind === 'weekly') {
      setCronForm(kind)
      patch({ scheduleKind: 'cron', expr: cronOfForm(kind, parts.time, parts.day) })
      return
    }
    if (kind === 'cron') {
      setCronForm('cron')
      patch({ scheduleKind: 'cron' })
      return
    }
    patch({ scheduleKind: kind })
  }

  const submit = async () => {
    setAttempted(true)
    const problems = Object.keys(errors) as DraftField[]
    if (problems.length > 0) {
      if (problems.some((field) => MORE_FIELDS.has(field))) setMoreOpen(true)
      if (problems.some((field) => BUILDER_FIELDS.has(field))) setBuilderOpen(true)
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await save(draft)
    } catch (cause) {
      if (mounted.current) setFailure(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const field = (name: DraftField) => ({
    'data-field': name,
    'aria-invalid': shown[name] ? true : undefined,
    'aria-describedby': shown[name] ? id(`${name}-error`) : undefined
  })
  const fieldError = (name: DraftField) =>
    shown[name] ? <p className="scheduled-field-error" id={id(`${name}-error`)} role="alert">{shown[name]}</p> : null

  // Where, in the sentence.
  const projectOptions: SelectOption[] = [
    { value: '', label: 'no project' },
    ...catalog.projects.map((project) => ({ value: project.id, label: project.name })),
    ...(draft.projectId && !catalog.projects.some((project) => project.id === draft.projectId) ? [{ value: draft.projectId, label: 'Removed project' }] : [])
  ]
  const projectThreads = catalog.threads.filter((thread) => !draft.projectId || thread.projectId === draft.projectId)
  const threadLocked = draft.workspaceKind === 'worktree' && draft.projectId !== ''
  const threadOptions: SelectOption[] = [
    { value: '', label: threadLocked ? 'The thread that owns the worktree' : 'A new thread each run' },
    ...(!threadLocked && draft.threadId && !projectThreads.some((thread) => thread.id === draft.threadId) ? [{ value: draft.threadId, label: 'Unknown thread' }] : []),
    ...projectThreads.map((thread) => ({ value: thread.id, label: thread.name }))
  ]
  // Who: the default agent, a model or a saved agent. A model the lists no longer offer stays chosen until changed.
  const who: Who = draft.agentId ? { kind: 'agent', id: draft.agentId } : draft.modelKey ? { kind: 'model', key: draft.modelKey } : { kind: 'default' }
  const naming = { defaultName, models: catalog.models, library }
  const staleModel = draft.staleSelection && draft.modelKey !== '' && !catalog.models.some((group) => group.choices.some((choice) => choice.key === draft.modelKey))
    ? `${modelLabel(resolveModelChoice({ ...draft.staleSelection, provider: draft.staleSelection.llmProvider }))} (not available now)`
    : undefined
  const savedAgentName = draft.agentId ? library.agents.find((agent) => agent.id === draft.agentId)?.name ?? (draft.agentId === initial.agentId && item?.who.kind === 'saved_agent' ? item.who.name : 'Saved agent') : undefined
  const whoLabel = staleModel ?? savedAgentName ?? nameOfWho(who, naming)
  const whoChoices = whoOptions({ ...naming, withBots: false, current: { key: whoKey(who), label: whoLabel } })
  const chooseWho = (key: string) => {
    const next = parseWhoKey(key)
    if (next.kind === 'agent') patch({ agentId: next.id, modelKey: '' })
    else if (next.kind === 'model') patch({ agentId: '', modelKey: next.key })
    else patch({ agentId: '', modelKey: '' })
  }

  // Do: a prompt, or a workflow whose inputs replace the prompt.
  const command = parseWorkflowCommand(draft.prompt)
  const doWorkflow = command ? library.workflows.find((entry) => entry.slug === command.slug) : undefined
  const { fields, loading: fieldsLoading } = useWorkflowFields(profileId, doWorkflow)
  const chooseDo = (workflowId: string) => {
    const chosen = library.workflows.find((entry) => entry.id === workflowId)
    if (chosen) patch({ prompt: `/${chosen.slug}`, agentId: '' })
    else patch({ prompt: '' })
    if (!chosen) requestAnimationFrame(() => promptRef.current?.focus())
  }

  // May: the effective mode a run gets, from what is chosen here, held to what the person holds.
  const workflow = isWorkflowPrompt(draft.prompt)
  const effectiveMay: PermissionMode = narrowPermissionMode(draft.permissionMode || undefined, job.permissionCeiling, held.mode)
  const mayOptions: SelectOption<PermissionMode>[] = PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: describePermissionMode(mode),
    disabled: isStricter(held.mode, mode)
  }))
  const tellOptions: SelectOption<TellMe>[] = TELL_ME_VALUES.map((value) => ({ value, label: TELL_ME_LABELS[value] }))

  // Next and why.
  const savedSchedule = scheduleOf(draft)
  const scheduleChanged = Boolean(patchOf(initial, draft, catalog).schedule)
  const next = !scheduleChanged && !paused && job.nextRunAt ? job.nextRunAt : null
  const skipped = whyOpen ? skippedDates(savedSchedule, now) : []
  const code = scheduleCode(savedSchedule)

  const runs = item?.runs ?? []
  const shownRuns = runs.slice(0, allRuns ? runs.length : RECENT_RUNS)
  const creatorThread = job.createdBy ? catalog.threads.find((thread) => thread.id === job.createdBy!.threadId)?.name : undefined
  const workspaceShown = showsWorkspace(draft) || draft.workspaceKind === 'worktree'

  const menu: RowMenuItem[] = bot
    ? [
        ...(onOpenBot ? [{ label: 'Open bot chat', onSelect: () => onOpenBot(bot.id) }] : []),
        { label: 'Delete', danger: true, onSelect: onDelete }
      ]
    : [
        { label: job.trigger?.webhook ? 'Request URL…' : 'Add request URL…', onSelect: onWebhook },
        { label: 'Delete', danger: true, onSelect: onDelete }
      ]

  return (
    <form
      className="automation-detail"
      data-testid="automation-detail"
      data-job-id={job.id}
      aria-label={job.name}
      noValidate
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onBack()
        }
      }}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div className="automation-detail-head">
        <button type="button" className="automations-back" onClick={onBack} aria-label="Back to Automations" title="Back">
          <ChevronLeft size={15} />
        </button>
        <h2 className="automation-detail-name">{draft.name.trim() || job.name}</h2>
        <div className="automation-detail-actions">
          {bot ? null : <button type="button" className="settings-btn" onClick={onRunNow} disabled={Boolean(item?.active && item.active.state !== 'waiting')}>Run now</button>}
          {paused
            ? <button type="button" className="settings-btn" onClick={onResume} data-testid="automation-detail-resume">Resume</button>
            : <button type="button" className="settings-btn" onClick={onPause} title="Pause…" aria-label="Pause…" data-testid="automation-detail-pause">⏸</button>}
          <RowMenu label={`More actions for ${job.name}`} items={menu} />
        </div>
      </div>

      <p className="automation-sentence" data-testid="automation-sentence">
        <span className="automation-sentence-glue">
          <button type="button" className="automation-chip" aria-expanded={builderOpen} onClick={() => setBuilderOpen((open) => !open)} data-testid="automation-when">
            {whenSentence(draft)}
          </button>
          ,
        </span>
        {' '}
        {bot ? (
          <span className="automation-chip readonly" data-testid="automation-who" title={`${bot.name} does it, in its own way and with its own permissions`}>
            <span className="automation-bot-face" aria-hidden="true"><BotFaceStill look={bot.look} state="idle" size={16} view="head" /></span>
            {bot.name}
          </span>
        ) : workflow ? null : (
          <Select
            ariaLabel="Who"
            className="automation-chip-select"
            size="small"
            value={whoKey(who)}
            options={whoChoices}
            title="Who does it"
            renderValue={() => <span data-testid="automation-who">{whoLabel}</span>}
            onChange={chooseWho}
          />
        )}
        {workflow ? null : ' does '}
        {bot ? <span className="automation-sentence-glue">this.</span> : (
          <DoPicker
            value={doWorkflow?.id ?? (workflow ? draft.prompt.trim().split(/\s+/)[0] ?? '' : '')}
            workflows={doWorkflow || !workflow ? library.workflows : [...library.workflows, { id: draft.prompt.trim().split(/\s+/)[0] ?? '/', slug: (draft.prompt.trim().split(/\s+/)[0] ?? '/').slice(1), name: 'Workflow not found', revisionId: '' }]}
            promptLabel="this"
            onChange={chooseDo}
          />
        )}
        {workflow ? ' runs' : null}
        {bot ? null : ' in '}
        {bot ? null : <span className="automation-sentence-glue">
          <Select
            id={id('project')}
            ariaLabel="Where"
            className="automation-chip-select"
            size="small"
            value={draft.projectId}
            options={projectOptions}
            onChange={(projectId) => {
              const keep = catalog.threads.some((thread) => thread.id === draft.threadId && (!projectId || thread.projectId === projectId))
              patch({ projectId, ...(keep || draft.threadId === '' || draft.workspaceKind === 'worktree' ? {} : { threadId: '' }) })
            }}
          />
          .
        </span>}
      </p>

      {builderOpen ? (
        <div className="scheduled-builder automation-builder">
          <div className="scheduled-segmented" role="radiogroup" aria-label="When" {...field('schedule')}>
            {(bot ? BOT_BUILDER_KINDS : BUILDER_KINDS).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={builderKind === option.value}
                tabIndex={builderKind === option.value ? 0 : -1}
                className={`scheduled-segment${builderKind === option.value ? ' active' : ''}`}
                onClick={() => chooseBuilderKind(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {fieldError('schedule')}
          {builderKind === 'interval' ? (
            <div className="scheduled-inline">
              <label className="scheduled-label" htmlFor={id('minutes')}>Minutes between runs</label>
              <input id={id('minutes')} className="scheduled-input narrow" inputMode="numeric" value={draft.minutes} {...field('minutes')} onChange={(event) => patch({ minutes: event.target.value })} />
            </div>
          ) : null}
          {fieldError('minutes')}
          {builderKind === 'daily' || builderKind === 'weekly' ? (
            <div className="scheduled-inline">
              {builderKind === 'weekly' ? (
                <>
                  <label className="scheduled-label" htmlFor={id('day')}>Day</label>
                  <Select id={id('day')} className="scheduled-select narrow" value={parts.day} options={WEEKDAY_OPTIONS} onChange={(day) => patch({ expr: cronOfForm('weekly', parts.time, day) })} />
                </>
              ) : null}
              <label className="scheduled-label" htmlFor={id('time')}>Time</label>
              <input id={id('time')} className="scheduled-input narrow" type="time" value={parts.time} onChange={(event) => patch({ expr: cronOfForm(builderKind, event.target.value, parts.day) })} />
            </div>
          ) : null}
          {builderKind === 'cron' ? (
            <div className="scheduled-inline">
              <label className="scheduled-label" htmlFor={id('expr')}>Cron</label>
              <input id={id('expr')} className="scheduled-input mono" placeholder="0 9 * * *" title="Minute, hour, day of month, month, day of week" {...field('expr')} value={draft.expr} onChange={(event) => patch({ expr: event.target.value })} />
            </div>
          ) : null}
          {fieldError('expr')}
          {builderKind === 'once' ? (
            <div className="scheduled-inline">
              <label className="scheduled-label" htmlFor={id('runAt')}>Run at</label>
              <input id={id('runAt')} className="scheduled-input narrow" type="datetime-local" value={draft.runAt} {...field('runAt')} onChange={(event) => patch({ runAt: event.target.value })} />
            </div>
          ) : null}
          {fieldError('runAt')}
        </div>
      ) : null}

      {doWorkflow && command ? (
        <WorkflowInputs
          fields={fields}
          values={command.values}
          loading={fieldsLoading}
          onChange={(key, value) => patch({ prompt: workflowCommandText(doWorkflow.slug, { ...command.values, [key]: value }, fields) })}
        />
      ) : (
        <>
          <label className="scheduled-sr-only" htmlFor={id('prompt')}>What it does</label>
          <textarea
            ref={promptRef}
            id={id('prompt')}
            className="scheduled-prompt"
            placeholder={bot ? `What should ${bot.name} do?` : 'What should the agent do?'}
            rows={3}
            value={draft.prompt}
            {...field('prompt')}
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </>
      )}
      {fieldError('prompt')}

      <div className="automation-detail-pair">
        <span className="automation-detail-label" id={id('may-label')}>May</span>
        {bot ? (
          <span className="automation-detail-value" data-testid="automation-may-bot" title={`What ${bot.name} may do is set by asking it, in its chat`}>
            {`${bot.name}'s grant`}
            {onOpenBot ? <button type="button" className="scheduled-link-btn" onClick={() => onOpenBot(bot.id)}>View</button> : null}
          </span>
        ) : draft.agentId && !workflow ? (
          <span className="automation-detail-value" data-testid="automation-may-agent" title="A saved agent keeps to what it may use, set in the Library">{`What ${whoLabel} may use`}</span>
        ) : (
          <Select<PermissionMode>
            id={id('may')}
            ariaLabelledBy={id('may-label')}
            className="automation-inline-select"
            size="small"
            value={effectiveMay}
            options={mayOptions}
            title={`The strictest of this automation's mode${job.permissionCeiling ? `, its limit (${describePermissionMode(job.permissionCeiling)})` : ''} and its thread's. Never more than ${describePermissionMode(held.mode)}.`}
            onChange={(permissionMode) => patch({ permissionMode })}
          />
        )}
        <span className="automation-detail-label" id={id('tell-label')}>Tell me</span>
        <Select<TellMe>
          id={id('tell')}
          ariaLabelledBy={id('tell-label')}
          className="automation-inline-select"
          size="small"
          value={draft.tellMe}
          options={tellOptions}
          title="When a run notifies you. Nothing new is when the agent finds nothing to report."
          onChange={(tellMe) => patch({ tellMe })}
        />
      </div>
      {fieldError('permission')}
      {lowered ? <p className="scheduled-note warn" data-testid="permission-lowered">Saving lowers May to {describePermissionMode(lowered)}, the most you hold for the thread you chose.</p> : null}

      <div className="automation-detail-pair">
        <span className="automation-detail-label">Next</span>
        <span className="automation-detail-value" data-testid="automation-next">
          {paused
            ? job.resumeAt ? `Paused until ${ownedWhenText(job.resumeAt, now, owner, viewerZone)}` : item?.pausedBy === 'bot' ? `${item.pausedReason ?? 'Paused'} · the bot is paused` : 'Paused'
            : scheduleChanged ? 'Shown after Save' : next ? ownedWhenText(next, now, owner, viewerZone) : savedSchedule.kind === 'manual' ? 'When you run it' : 'None'}
        </span>
        <button type="button" className="scheduled-link-btn" aria-expanded={whyOpen} onClick={() => setWhyOpen((open) => !open)} data-testid="automation-why">(why?)</button>
      </div>
      {whyOpen ? (
        <div className="automation-why" data-testid="automation-why-panel">
          <p>{describeScheduleLong(savedSchedule, now).replace(", this computer's time", '')}{code ? <> · <span className="scheduled-mono">{code}</span></> : null}</p>
          <p>
            {`${owner.name} time, ${zoneName(owner.timeZone, now)} (${owner.timeZone})`}
            {owner.timeZone !== viewerZone ? ` · this computer: ${zoneName(viewerZone, now)} (${viewerZone})` : ''}
          </p>
          {next ? <p>{`Next ${whenText(next, now, owner.timeZone)}${owner.timeZone !== viewerZone ? ` · ${whenText(next, now, viewerZone)} here` : ''}`}</p> : null}
          {savedSchedule.kind === 'cron'
            ? skipped.length
              ? <ul>{skipped.map((entry) => <li key={entry.date}>{entry.reason}</li>)}</ul>
              : <p>Skips no dates in the next year.</p>
            : null}
        </div>
      ) : null}

      <section className="automation-runs" aria-label={`Runs of ${job.name}`}>
        <h3 className="automation-runs-head">Runs</h3>
        {shownRuns.length === 0 ? <p className="scheduled-note">No runs yet.</p> : (
          <ul>
            {shownRuns.map((run, index) => (
              <li key={`${run.at}-${index}`} className="automation-run" data-state={run.state}>
                <span className={`automation-run-glyph ${run.state}`} aria-hidden="true">{RUN_GLYPH[run.state]}</span>
                <span className="automation-run-when">{ownedWhenText(run.at, now, owner, viewerZone)}</span>
                <span className="automation-run-text">{runText(run, now, owner, viewerZone).replace(/ · (just now|\d+ (min|h|d) ago)$/, '')}</span>
                {run.ranBy ? <span className="automation-run-who" data-testid="automation-run-who" title="Who ran it">{run.ranBy}</span> : null}
                {run.agentChanged ? <span className="automation-run-changed" data-testid="automation-run-changed" title="The saved agent was published again since the run before">agent changed since last run</span> : null}
                {run.threadId ? <button type="button" className="scheduled-link-btn" onClick={() => onOpenThread(run.threadId!)}>Open thread</button> : null}
              </li>
            ))}
          </ul>
        )}
        {runs.length > RECENT_RUNS ? (
          <button type="button" className="scheduled-link-btn" aria-expanded={allRuns} onClick={() => setAllRuns((all) => !all)}>{allRuns ? 'Fewer runs' : 'All runs'}</button>
        ) : null}
      </section>

      <button type="button" className="scheduled-disclosure" aria-expanded={moreOpen} aria-controls={id('more')} onClick={() => setMoreOpen((open) => !open)} data-testid="automation-more">
        <ChevronRight size={13} aria-hidden="true" className="scheduled-disclosure-chevron" />
        More
        <span className="automation-more-hint">{bot ? 'name · added by' : 'thread · worktree · mode · limits · request URL · added by'}</span>
      </button>

      {moreOpen ? (
        <div className="scheduled-details" id={id('more')}>
          <MoreRow title="Name" htmlFor={id('name')} field="name" control={
            <input id={id('name')} className="scheduled-input" placeholder={nameFromPrompt(draft.prompt) || 'Name'} value={draft.name} {...field('name')} onChange={(event) => patch({ name: event.target.value })} />
          }>{fieldError('name')}</MoreRow>

          {bot ? null : <>
          <MoreRow title="Thread" htmlFor={id('thread')} control={
            <Select id={id('thread')} className="scheduled-select" value={threadLocked ? '' : draft.threadId} options={threadOptions} disabled={threadLocked} onChange={(threadId) => patch({ threadId })} />
          } />

          {workspaceShown ? (
            <MoreRow title="Runs in" htmlFor={id('workspace')} field="workspace" control={
              <Select<WorkspaceKind>
                id={id('workspace')}
                className="scheduled-select"
                value={draft.workspaceKind}
                options={workspaceChoices(draft)}
                onChange={(workspaceKind) => patch({ workspaceKind, ...(draft.workspaceKind === 'worktree' && workspaceKind !== 'worktree' ? { threadId: '' } : {}) })}
              />
            }>
              {fieldError('workspace')}
              {draft.workspaceKind === 'worktree' ? (
                <div className="scheduled-inline">
                  <label className="scheduled-label" htmlFor={id('worktreePath')}>Worktree path</label>
                  <input id={id('worktreePath')} className="scheduled-input" placeholder="/path/to/worktree" value={draft.worktreePath} {...field('worktreePath')} onChange={(event) => patch({ worktreePath: event.target.value })} />
                </div>
              ) : null}
              {fieldError('worktreePath')}
              {draft.workspaceKind === 'project' && draft.mode !== 'plan' ? <p className="scheduled-note warn" data-testid="workspace-warning">{PROJECT_WORKSPACE_WARNING}</p> : null}
            </MoreRow>
          ) : draft.threadId ? <MoreRow title="Runs in" description="The thread's own workspace" /> : null}


          <MoreRow title="Mode" htmlFor={id('mode')} control={
            <Select<JobDraft['mode']> id={id('mode')} className="scheduled-select" value={draft.mode} options={modeChoices(draft)} onChange={(mode) => patch({ mode })} />
          } />

          <MoreRow title="Request URL" description={job.trigger?.webhook ? 'On: a signed request runs it' : 'Off'} control={
            <button type="button" className="settings-btn" onClick={onWebhook}>{job.trigger?.webhook ? 'Manage' : 'Set up'}</button>
          } />

          {job.createdBy ? (
            <MoreRow title="Added by" testId="agent-row" description={
              <>
                {creatorThread ?? 'An agent'}
                {job.expiresAt ? <span data-meta="expires">{` · ${job.state === 'completed' && Date.parse(job.expiresAt) <= Date.now() ? 'Ended' : 'Ends'} ${ownedWhenText(job.expiresAt, now, owner, viewerZone)}`}</span> : null}
              </>
            } control={
              <>
                {job.expiresAt ? <button type="button" className="settings-btn" data-testid="automation-keep" onClick={onKeep} title="Remove its end. Its access, how often it runs and what the agent may add stay as they are.">Keep</button> : null}
                <button type="button" className="settings-icon-btn" title="Open the thread that added it" aria-label="Open the thread that added it" onClick={() => onOpenThread(job.createdBy!.threadId)}>
                  <MessageSquare size={14} />
                </button>
              </>
            } />
          ) : null}
          </>}
          {bot ? <MoreRow title="Added by" testId="bot-added-by" description={job.bot?.createdBy === 'bot' ? bot.name : 'You'} /> : null}
        </div>
      ) : null}

      {failure ? <p className="scheduled-item-error" role="alert" data-testid="save-error">{failure}</p> : null}
      <div className="scheduled-form-actions">
        <button type="button" className="settings-btn" onClick={onBack}>{unchanged ? 'Done' : 'Cancel'}</button>
        <button type="submit" className="settings-btn primary" disabled={busy || unchanged}>Save</button>
      </div>
    </form>
  )
}
