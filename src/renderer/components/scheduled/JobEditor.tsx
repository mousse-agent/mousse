import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, MessageSquare } from '../../lib/icons'
import {
  describeMode,
  describeModel,
  describePermission,
  describeScheduleLong,
  describeWorkspace,
  errorText,
  nameFromPrompt,
  relativeWhen,
  RUN_STATUS_LABEL,
  scheduleCode,
  SCHEDULE_PRESETS,
  WEEKDAY_OPTIONS,
  type SchedulePreset
} from './scheduledLabels'
import { modelLabel } from '../../../shared/modelChoice'
import { resolveModelChoice } from '../../lib/modelChoice'
import { describePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type { ScheduledJob, ScheduledJobRunRecord } from '../../../shared/types'
import { Select, type SelectOption } from '../ui/Select'
import { QUICK_ADD_PLACEHOLDER } from './automationsCopy'
import {
  cronFormOf,
  cronOfForm,
  cronParts,
  draftPreset,
  heldPermissionMode,
  isUnchanged,
  loweredPermission,
  modeChoices,
  patchOf,
  permissionChoices,
  presetFields,
  scheduleOf,
  takesPermissionMode,
  showsWorkspace,
  validateDraft,
  workspaceChoices,
  type CronForm,
  type DraftField,
  type JobDraft,
  type ScheduledCatalog,
  type WorkspaceKind
} from './jobDraft'

/** The custom schedule builder's choices. Daily and Weekly are plain forms that save as cron. */
type BuilderKind = 'interval' | 'daily' | 'weekly' | 'cron' | 'once' | 'manual'

const BUILDER_KINDS: Array<{ value: BuilderKind; label: string }> = [
  { value: 'interval', label: 'Every…' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron' },
  { value: 'once', label: 'Once' },
  { value: 'manual', label: 'Manual' }
]

export const MODE_NOTE =
  "Default uses the thread's own permission settings, and nobody is there to approve anything. Choose Plan for a task that must not change files."
export const WORKFLOW_PERMISSION_NOTE =
  'A prompt that starts with / runs a workflow. Workflows do not run under a permission mode, so there is nothing to choose here.'
export const PROJECT_WORKSPACE_WARNING =
  'The run works in your own checkout, unattended, with no checkpoints or undo. For a Git project, a new worktree per run is safer.'

/** Fields that live behind Details: a problem in one opens it. */
const DETAIL_FIELDS = new Set<DraftField>(['name', 'minutes', 'expr', 'runAt', 'schedule', 'worktreePath', 'workspace', 'permission'])
const BUILDER_FIELDS = new Set<DraftField>(['minutes', 'expr', 'runAt', 'schedule'])
const RECENT_RUNS = 3
const HISTORY_ROWS = 10

/** When: the presets, then Custom…, which opens the schedule builder. */
const WHEN_OPTIONS: SelectOption<SchedulePreset>[] = [
  ...SCHEDULE_PRESETS.map((item) => ({ value: item.value, label: item.label })),
  { value: 'custom', label: 'Custom…' }
]

/** One row of Details: text left, one control right; anything longer sits under it. What needs explaining is the title's tooltip. */
function DetailRow({ title, htmlFor, description, descriptionTitle, tip, tipTestId, control, children, field, testId }: {
  title: string
  htmlFor?: string
  description?: ReactNode
  descriptionTitle?: string
  tip?: string
  tipTestId?: string
  control?: ReactNode
  children?: ReactNode
  field?: DraftField
  testId?: string
}) {
  return (
    <div className="scheduled-detail-row" data-field={field} data-testid={testId}>
      <div className="scheduled-detail-text">
        {htmlFor
          ? <label className="scheduled-detail-title" htmlFor={htmlFor} title={tip} data-testid={tipTestId}>{title}</label>
          : <span className="scheduled-detail-title" title={tip} data-testid={tipTestId}>{title}</span>}
        {description ? <div className="scheduled-detail-desc" title={descriptionTitle}>{description}</div> : null}
      </div>
      {control ? <div className="scheduled-detail-control">{control}</div> : null}
      {children ? <div className="scheduled-detail-extra">{children}</div> : null}
    </div>
  )
}

/**
 * The open task, for a new task and for editing one: the prompt, when it runs and where, then Details with
 * everything technical (schedule as saved, workspace, thread, model, mode, permissions, webhook, the agent that added
 * it, runs). It checks the fields after the first save attempt, saves through `save`, and shows what the profile
 * refuses in words. Escape cancels; Enter in a field saves.
 */
export function JobEditor({
  job,
  initial,
  catalog,
  save,
  onCancel,
  startCustom = false,
  extendDays,
  onExtend,
  onWebhook,
  onOpenThread
}: {
  job?: ScheduledJob
  initial: JobDraft
  catalog: ScheduledCatalog
  save: (draft: JobDraft) => Promise<void>
  onCancel: () => void
  /** Open on the custom schedule builder (Custom… from the quick-add line). */
  startCustom?: boolean
  extendDays?: number
  onExtend?: () => void
  onWebhook?: () => void
  onOpenThread?: (threadId: string) => void
}) {
  const [draft, setDraft] = useState<JobDraft>(initial)
  // Custom stays chosen even when what is typed happens to match a preset.
  const [custom, setCustom] = useState(() => startCustom || draftPreset(initial) === 'custom')
  const [detailsOpen, setDetailsOpen] = useState(startCustom)
  const [builderOpen, setBuilderOpen] = useState(startCustom)
  const [cronForm, setCronForm] = useState<CronForm>(() => cronFormOf(initial.expr))
  const [allRuns, setAllRuns] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const problemsRef = useRef<DraftField[]>([])
  const formRef = useRef<HTMLFormElement>(null)
  const mounted = useRef(true)
  const ids = useId()
  const id = (field: string) => `${ids}-${field}`
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { formRef.current?.querySelector<HTMLElement>('[data-first-field]')?.focus() }, [])

  // The mode the person holds is checked only for a permission mode they are choosing now, not one the job already had.
  const held = heldPermissionMode(draft, catalog, job)
  const choosingPermission = draft.permissionMode !== initial.permissionMode
  const errors = useMemo(
    () => validateDraft(draft, { hasWebhook: Boolean(job?.trigger?.webhook), requireName: Boolean(job), ...(choosingPermission ? { held: held.mode } : {}) }),
    [draft, job, choosingPermission, held.mode]
  )
  const lowered = loweredPermission(draft, initial, catalog, job)
  const shown = attempted ? errors : {}
  const patch = (changes: Partial<JobDraft>) => { setDraft((current) => ({ ...current, ...changes })); setFailure(null) }
  const unchanged = job ? isUnchanged(patchOf(initial, draft, catalog)) : false

  const projectThreads = catalog.threads.filter((thread) => !draft.projectId || thread.projectId === draft.projectId)
  const knownThread = projectThreads.some((thread) => thread.id === draft.threadId)
  const workspaceShown = showsWorkspace(draft) || draft.workspaceKind === 'worktree'
  const threadLocked = draft.workspaceKind === 'worktree' && draft.projectId !== ''
  const preset: SchedulePreset = custom ? 'custom' : draftPreset(draft)
  const builderKind: BuilderKind = draft.scheduleKind === 'cron' ? cronForm : draft.scheduleKind
  const parts = cronParts(draft.expr)

  // After a refused save, focus the first problem in the order the form shows them (Details opens for its own).
  useEffect(() => {
    if (focusTick === 0) return
    const fields = [...(formRef.current?.querySelectorAll<HTMLElement>('[data-field]') ?? [])]
    const target = fields.find((element) => problemsRef.current.includes(element.dataset.field as DraftField))
    const focusable = target?.matches('input, textarea, button') ? target : target?.querySelector<HTMLElement>('[aria-checked="true"], [aria-invalid="true"], input, textarea, button')
    focusable?.focus()
  }, [focusTick])

  const choosePreset = (next: SchedulePreset) => {
    if (next === 'custom') {
      // The custom builder opens on what the preset saves, ready to change.
      setCustom(true)
      setDetailsOpen(true)
      setBuilderOpen(true)
      return
    }
    setCustom(false)
    setBuilderOpen(false)
    setCronForm(cronFormOf(presetFields(next).expr ?? draft.expr))
    patch(presetFields(next))
  }

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

  const modelOptions: SelectOption[] = [
    { value: '', label: 'Default model' },
    ...(draft.staleSelection && draft.modelKey !== '' && !catalog.models.some((group) => group.choices.some((choice) => choice.key === draft.modelKey))
      ? [{ value: draft.modelKey, label: `${modelLabel(resolveModelChoice({ ...draft.staleSelection, provider: draft.staleSelection.llmProvider }))} (not available now)` }]
      : []),
    ...catalog.models.flatMap((group) => group.choices.map((choice) => ({ value: choice.key, label: choice.label, group: group.label })))
  ]
  const projectOptions: SelectOption[] = [
    { value: '', label: 'No project' },
    ...catalog.projects.map((project) => ({ value: project.id, label: project.name })),
    ...(draft.projectId && !catalog.projects.some((project) => project.id === draft.projectId) ? [{ value: draft.projectId, label: 'Unknown project' }] : [])
  ]
  const threadOptions: SelectOption[] = [
    { value: '', label: threadLocked ? 'The thread that owns the worktree' : 'A new thread for each run' },
    ...(!threadLocked && draft.threadId && !knownThread ? [{ value: draft.threadId, label: 'Unknown thread' }] : []),
    ...projectThreads.map((thread) => ({ value: thread.id, label: thread.name }))
  ]

  const submit = async () => {
    setAttempted(true)
    const problems = Object.keys(errors) as DraftField[]
    if (problems.length > 0) {
      problemsRef.current = problems
      if (problems.some((field) => DETAIL_FIELDS.has(field))) setDetailsOpen(true)
      if (problems.some((field) => BUILDER_FIELDS.has(field))) { setCustom(true); setBuilderOpen(true) }
      setFocusTick((tick) => tick + 1)
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

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  const field = (name: DraftField) => ({
    'data-field': name,
    'aria-invalid': shown[name] ? true : undefined,
    'aria-describedby': shown[name] ? id(`${name}-error`) : undefined
  })
  const selectField = (name: DraftField) => ({
    ariaInvalid: Boolean(shown[name]),
    ariaDescribedBy: shown[name] ? id(`${name}-error`) : undefined
  })
  const fieldError = (name: DraftField) =>
    shown[name] ? <p className="scheduled-field-error" id={id(`${name}-error`)} role="alert">{shown[name]}</p> : null

  // What the saved schedule reads as; the next run is the stored one, shown only while the schedule is unchanged.
  const savedSchedule = scheduleOf(draft)
  const scheduleUnchanged = job ? !patchOf(initial, draft, catalog).schedule : false
  const scheduleText = `${describeScheduleLong(savedSchedule)}${scheduleUnchanged && job?.nextRunAt ? ` · Next ${relativeWhen(job.nextRunAt)}` : ''}`
  const code = scheduleCode(savedSchedule)

  const permissionNote = held.exact
    ? `Never more than ${describePermissionMode(held.mode)}${job?.permissionCeiling ? `; this task's limit is ${describePermissionMode(job.permissionCeiling)}` : ''}`
    : 'Only Ask before acting: the thread that owns the worktree decides'
  const permissionHelp = `${held.exact
    ? `A run never does more without asking than ${describePermissionMode(held.mode)}, the mode you hold for this task now.`
    : 'The thread that owns the worktree sets what you can choose, so only Ask before acting is offered here. Default follows that thread.'}${job?.permissionCeiling ? ` This task's limit is ${describePermissionMode(job.permissionCeiling)}: what its creator held. A run follows its thread, never above that limit.` : ''}`

  const workspaceNote = draft.workspaceKind === 'newWorktree'
    ? 'A new worktree and a new thread for each run'
    : draft.workspaceKind === 'worktree'
      ? 'The worktree at this path, on the thread that owns it'
      : null

  const records: ScheduledJobRunRecord[] = [...(job?.runHistory ?? [])].reverse().slice(0, allRuns ? HISTORY_ROWS : RECENT_RUNS)
  const runCount = job?.runHistory?.length ?? 0
  const creatorThread = job?.createdBy ? catalog.threads.find((thread) => thread.id === job.createdBy!.threadId)?.name : undefined
  const ended = job?.expiresAt ? job.state === 'completed' && new Date(job.expiresAt).getTime() <= Date.now() : false

  return (
    <form
      ref={formRef}
      className="scheduled-editor"
      aria-label={job ? `Edit ${job.name}` : 'New scheduled task'}
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <label className="scheduled-sr-only" htmlFor={id('prompt')}>Prompt</label>
      <textarea
        id={id('prompt')}
        className="scheduled-prompt"
        placeholder={QUICK_ADD_PLACEHOLDER}
        rows={3}
        value={draft.prompt}
        data-first-field=""
        {...field('prompt')}
        onChange={(event) => patch({ prompt: event.target.value })}
      />
      {fieldError('prompt')}

      <div className="scheduled-when">
        <span className="scheduled-when-label" id={id('when')}>When</span>
        <Select<SchedulePreset>
          variant="menu"
          ariaLabelledBy={id('when')}
          data-testid="editor-when"
          value={preset}
          options={WHEN_OPTIONS}
          renderValue={(option) => (option?.value === 'custom' ? 'Custom' : option?.label)}
          onChange={choosePreset}
        />
        <label className="scheduled-when-label" htmlFor={id('project')}>Where</label>
        <Select
          id={id('project')}
          variant="menu"
          value={draft.projectId}
          options={projectOptions}
          onChange={(projectId) => {
            const keep = catalog.threads.some((thread) => thread.id === draft.threadId && (!projectId || thread.projectId === projectId))
            patch({ projectId, ...(keep || draft.threadId === '' || draft.workspaceKind === 'worktree' ? {} : { threadId: '' }) })
          }}
        />
      </div>

      <button
        type="button"
        className="scheduled-disclosure"
        aria-expanded={detailsOpen}
        aria-controls={id('details')}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <ChevronRight size={13} aria-hidden="true" className="scheduled-disclosure-chevron" />
        Details
      </button>

      {detailsOpen ? (
        <div className="scheduled-details" id={id('details')}>
          <DetailRow
            title="Name"
            htmlFor={id('name')}
            field="name"
            control={
              <input
                id={id('name')}
                className="scheduled-input"
                placeholder={nameFromPrompt(draft.prompt) || 'Task name'}
                value={draft.name}
                {...field('name')}
                onChange={(event) => patch({ name: event.target.value })}
              />
            }
          >
            {fieldError('name')}
          </DetailRow>

          <DetailRow
            title="Schedule"
            description={<span data-testid="schedule-summary">{scheduleText}</span>}
            control={
              <>
                {code ? <span className="scheduled-mono" title={draft.scheduleKind === 'cron' ? 'Cron: minute, hour, day of month, month, day of week' : 'Interval'}>{code}</span> : null}
                <button
                  type="button"
                  className="settings-btn"
                  aria-expanded={builderOpen}
                  onClick={() => { setBuilderOpen((open) => !open); setCustom(true) }}
                >
                  Change
                </button>
              </>
            }
          >
            {builderOpen ? (
              <div className="scheduled-builder">
                <div className="scheduled-segmented" role="radiogroup" aria-label="Custom schedule" {...field('schedule')}>
                  {BUILDER_KINDS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={builderKind === option.value}
                      tabIndex={builderKind === option.value ? 0 : -1}
                      className={`scheduled-segment${builderKind === option.value ? ' active' : ''}`}
                      title={option.value === 'manual' ? `Runs only when you press Run now${job?.trigger?.webhook ? ' or its webhook is called' : ', or once you add a webhook'}` : undefined}
                      onClick={() => chooseBuilderKind(option.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                        event.preventDefault()
                        event.stopPropagation()
                        const index = BUILDER_KINDS.findIndex((item) => item.value === builderKind)
                        const next = BUILDER_KINDS[(index + (event.key === 'ArrowRight' ? 1 : -1) + BUILDER_KINDS.length) % BUILDER_KINDS.length]
                        chooseBuilderKind(next.value)
                        const group = event.currentTarget.parentElement
                        requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
                      }}
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
                        <Select
                          id={id('day')}
                          variant="menu"
                          value={parts.day}
                          options={WEEKDAY_OPTIONS}
                          onChange={(day) => patch({ expr: cronOfForm('weekly', parts.time, day) })}
                        />
                      </>
                    ) : null}
                    <label className="scheduled-label" htmlFor={id('time')}>Time</label>
                    <input
                      id={id('time')}
                      className="scheduled-input narrow"
                      type="time"
                      value={parts.time}
                      onChange={(event) => patch({ expr: cronOfForm(builderKind, event.target.value, parts.day) })}
                    />
                  </div>
                ) : null}
                {builderKind === 'cron' ? (
                  <div className="scheduled-inline">
                    <label className="scheduled-label" htmlFor={id('expr')}>Cron expression</label>
                    <input
                      id={id('expr')}
                      className="scheduled-input mono"
                      placeholder="0 9 * * *"
                      title="Minute, hour, day of month, month, day of week"
                      data-field="expr"
                      aria-invalid={shown.expr ? true : undefined}
                      aria-describedby={shown.expr ? id('expr-error') : undefined}
                      value={draft.expr}
                      onChange={(event) => patch({ expr: event.target.value })}
                    />
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
          </DetailRow>

          {workspaceShown ? (
            <DetailRow
              title="Runs in"
              htmlFor={id('workspace')}
              field="workspace"
              tip={workspaceNote ?? undefined}
              control={
                <Select<WorkspaceKind>
                  id={id('workspace')}
                  variant="menu"
                  value={draft.workspaceKind}
                  options={workspaceChoices(draft)}
                  {...selectField('workspace')}
                  onChange={(workspaceKind) => {
                    // A task on a worktree runs on the thread that owns it: leaving that drops the owner from the form.
                    patch({ workspaceKind, ...(draft.workspaceKind === 'worktree' && workspaceKind !== 'worktree' ? { threadId: '' } : {}) })
                  }}
                />
              }
            >
              {fieldError('workspace')}
              {draft.workspaceKind === 'worktree' ? (
                <div className="scheduled-inline">
                  <label className="scheduled-label" htmlFor={id('worktreePath')}>Worktree path</label>
                  <input id={id('worktreePath')} className="scheduled-input" placeholder="/path/to/worktree" value={draft.worktreePath} {...field('worktreePath')} onChange={(event) => patch({ worktreePath: event.target.value })} />
                </div>
              ) : null}
              {fieldError('worktreePath')}
              {draft.workspaceKind === 'project' && draft.mode !== 'plan' ? <p className="scheduled-note warn" data-testid="workspace-warning">{PROJECT_WORKSPACE_WARNING}</p> : null}
            </DetailRow>
          ) : draft.threadId ? (
            <DetailRow title="Runs in" description="The thread's own workspace" />
          ) : null}

          <DetailRow
            title="Thread"
            htmlFor={id('thread')}
            control={
              <Select
                id={id('thread')}
                variant="menu"
                value={threadLocked ? '' : draft.threadId}
                options={threadOptions}
                disabled={threadLocked}
                onChange={(threadId) => patch({ threadId })}
              />
            }
          />

          <DetailRow
            title="Model"
            htmlFor={id('model')}
            control={<Select id={id('model')} variant="menu" value={draft.modelKey} options={modelOptions} onChange={(modelKey) => patch({ modelKey })} />}
          />

          <DetailRow
            title="Mode"
            htmlFor={id('mode')}
            tip={draft.mode === '' ? MODE_NOTE : undefined}
            tipTestId={draft.mode === '' ? 'mode-note' : undefined}
            control={
              <Select<JobDraft['mode']>
                id={id('mode')}
                variant="menu"
                value={draft.mode}
                options={modeChoices(draft)}
                onChange={(mode) => patch({ mode })}
              />
            }
          />

          {takesPermissionMode(draft) ? (
            <DetailRow
              title="Permissions"
              htmlFor={id('permission')}
              field="permission"
              tip={`${permissionNote}. ${permissionHelp}`}
              tipTestId="permission-note"
              control={
                <Select<JobDraft['permissionMode']>
                  id={id('permission')}
                  variant="menu"
                  value={draft.permissionMode}
                  options={permissionChoices(draft, catalog, job)}
                  {...selectField('permission')}
                  onChange={(permissionMode) => patch({ permissionMode })}
                />
              }
            >
              {fieldError('permission')}
              {lowered ? <p className="scheduled-note warn" data-testid="permission-lowered">Saving lowers this task's mode from {describePermissionMode(draft.permissionMode as PermissionMode)} to {describePermissionMode(lowered)}, the most you hold for the thread you chose.</p> : null}
            </DetailRow>
          ) : (
            <DetailRow title="Permissions" description="Not used" tip={WORKFLOW_PERMISSION_NOTE} tipTestId="workflow-permission-note" />
          )}

          {job && onWebhook ? (
            <DetailRow
              title="Webhook"
              description={job.trigger?.webhook ? 'On' : 'Off'}
              control={<button type="button" className="settings-btn" onClick={onWebhook}>{job.trigger?.webhook ? 'Manage' : 'Set up'}</button>}
            />
          ) : null}

          {job?.createdBy ? (
            <DetailRow
              title="Added by an agent"
              testId="agent-row"
              description={
                <>
                  {creatorThread ? `From ${creatorThread}` : 'From an agent'}
                  {job.expiresAt ? <span data-meta="expires">{` · ${ended ? 'Ended' : 'Ends'} ${relativeWhen(job.expiresAt)}`}</span> : null}
                </>
              }
              control={
                <>
                  {job.expiresAt && onExtend ? (
                    <button type="button" className="settings-btn" onClick={onExtend}>{`Extend ${extendDays} ${extendDays === 1 ? 'day' : 'days'}`}</button>
                  ) : null}
                  {onOpenThread ? (
                    <button type="button" className="settings-icon-btn" title="Open the thread that added it" aria-label="Open the thread that added it" onClick={() => onOpenThread(job.createdBy!.threadId)}>
                      <MessageSquare size={14} />
                    </button>
                  ) : null}
                </>
              }
            />
          ) : null}

          {job ? (
            <section className="scheduled-history" aria-label={`Runs of ${job.name}`}>
              <h3 className="scheduled-history-head">
                Runs{runCount > records.length ? <span className="scheduled-history-sub">{`last ${records.length} of ${runCount}`}</span> : null}
              </h3>
              {records.length === 0 ? (
                <p className="scheduled-note">No runs yet.</p>
              ) : (
                <ul>
                  {records.map((record, index) => (
                    <RunRow key={`${record.runAt}-${record.runId ?? index}`} job={job} record={record} onOpenThread={onOpenThread} />
                  ))}
                </ul>
              )}
              {runCount > RECENT_RUNS ? (
                <button type="button" className="scheduled-link-btn" aria-expanded={allRuns} onClick={() => setAllRuns((all) => !all)}>
                  {allRuns ? 'Fewer runs' : 'All runs'}
                </button>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {failure ? <p className="scheduled-item-error" role="alert" data-testid="save-error">{failure}</p> : null}
      <div className="scheduled-form-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="settings-btn" disabled={busy || unchanged}>{job ? 'Save' : 'Add'}</button>
      </div>
    </form>
  )
}

/** One past run: ✓ or ×, when, what went wrong, and its thread. What it ran with is in the tooltip. */
function RunRow({ job, record, onOpenThread }: { job: ScheduledJob; record: ScheduledJobRunRecord; onOpenThread?: (threadId: string) => void }) {
  const workspace = record.workspace ? describeWorkspace(record.workspace, job) : null
  const used = [
    record.selection ? describeModel(record.selection) : null,
    record.mode ? describeMode(record.mode) : null,
    record.permissionMode ? describePermission(record.permissionMode) : null,
    workspace,
    record.agentCreated ? 'Task added by an agent' : null
  ].filter(Boolean).join(' · ')
  const tone = record.status === 'ok' ? 'ok' : record.status === 'error' || record.status === 'interrupted' || record.status === 'uncertain' ? 'bad' : 'muted'
  return (
    <li className="scheduled-history-row" data-status={record.status} title={used || undefined}>
      <span className={`scheduled-history-glyph ${tone}`} aria-hidden="true">{tone === 'ok' ? '✓' : tone === 'bad' ? '×' : '•'}</span>
      <span>{relativeWhen(record.runAt)}</span>
      {record.status !== 'ok' ? <span className={tone === 'bad' ? 'settings-status-bad' : undefined}>{RUN_STATUS_LABEL[record.status]}</span> : null}
      {record.error ? <span className="scheduled-history-error">{record.error}</span> : null}
      {record.missingPlaceholders?.length ? <span data-meta="missing">Missing fields: {record.missingPlaceholders.join(', ')}</span> : null}
      {record.threadId && onOpenThread ? (
        <button type="button" className="scheduled-link-btn" onClick={() => onOpenThread(record.threadId!)}>Open thread</button>
      ) : null}
      {used ? <span className="scheduled-sr-only">{used}</span> : null}
    </li>
  )
}
