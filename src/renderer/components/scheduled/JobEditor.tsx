import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { errorText } from './scheduledLabels'
import { describePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type { ScheduledJob, ScheduleKind } from '../../../shared/types'
import {
  heldPermissionMode,
  loweredPermission,
  modeChoices,
  permissionChoices,
  takesPermissionMode,
  showsWorkspace,
  validateDraft,
  workspaceChoices,
  type DraftField,
  type JobDraft,
  type ScheduledCatalog,
  type WorkspaceKind
} from './jobDraft'

const SCHEDULE_KINDS: Array<{ value: ScheduleKind; label: string }> = [
  { value: 'interval', label: 'Every…' },
  { value: 'cron', label: 'Cron' },
  { value: 'once', label: 'Once' },
  { value: 'manual', label: 'Manual' }
]

export const MODE_NOTE =
  "Default uses the thread's own permission settings, and nobody is there to approve anything. Choose Plan for a job that must not change files."
export const WORKFLOW_PERMISSION_NOTE =
  'A prompt that starts with / runs a workflow. Workflows do not run under a permission mode, so there is nothing to choose here.'
export const PROJECT_WORKSPACE_WARNING =
  'The run works in your own checkout, unattended, with no checkpoints or undo. For a Git project, a new worktree per run is safer.'

/**
 * The form for a scheduled job, for a new job and for editing one. It checks the fields as you go (shown after the
 * first save attempt), saves through `save`, and shows what the profile refuses in words. Escape cancels; Enter in
 * a field saves.
 */
export function JobEditor({
  job,
  initial,
  catalog,
  save,
  onCancel
}: {
  job?: ScheduledJob
  initial: JobDraft
  catalog: ScheduledCatalog
  save: (draft: JobDraft) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<JobDraft>(initial)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
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

  const projectThreads = catalog.threads.filter((thread) => !draft.projectId || thread.projectId === draft.projectId)
  const knownThread = projectThreads.some((thread) => thread.id === draft.threadId)
  const workspaceShown = showsWorkspace(draft) || draft.workspaceKind === 'worktree'
  const threadLocked = draft.workspaceKind === 'worktree' && draft.projectId !== ''

  const submit = async () => {
    setAttempted(true)
    const problems = Object.keys(errors) as DraftField[]
    if (problems.length > 0) {
      const target = formRef.current?.querySelector<HTMLElement>(`[data-field="${problems[0]}"]`)
      target?.focus()
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
  const fieldError = (name: DraftField) =>
    shown[name] ? <p className="scheduled-field-error" id={id(`${name}-error`)} role="alert">{shown[name]}</p> : null

  return (
    <form
      ref={formRef}
      className="scheduled-form"
      aria-label={job ? `Edit ${job.name}` : 'New scheduled job'}
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div className="scheduled-field">
        <label className="scheduled-label" htmlFor={id('name')}>Name</label>
        <input id={id('name')} className="scheduled-input" placeholder="Job name" value={draft.name} data-first-field="" {...field('name')} onChange={(event) => patch({ name: event.target.value })} />
        {fieldError('name')}
      </div>
      <div className="scheduled-field">
        <label className="scheduled-label" htmlFor={id('prompt')}>Prompt</label>
        <textarea id={id('prompt')} className="scheduled-input scheduled-textarea" placeholder="Prompt" rows={4} value={draft.prompt} {...field('prompt')} onChange={(event) => patch({ prompt: event.target.value })} />
        {fieldError('prompt')}
      </div>

      <div className="scheduled-field">
        <span className="scheduled-label" id={id('schedule')}>Schedule</span>
        <div className="scheduled-segmented" role="radiogroup" aria-labelledby={id('schedule')} {...field('schedule')}>
          {SCHEDULE_KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={draft.scheduleKind === option.value}
              tabIndex={draft.scheduleKind === option.value ? 0 : -1}
              className={`scheduled-segment${draft.scheduleKind === option.value ? ' active' : ''}`}
              onClick={() => patch({ scheduleKind: option.value })}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                event.preventDefault()
                event.stopPropagation()
                const index = SCHEDULE_KINDS.findIndex((item) => item.value === draft.scheduleKind)
                const next = SCHEDULE_KINDS[(index + (event.key === 'ArrowRight' ? 1 : -1) + SCHEDULE_KINDS.length) % SCHEDULE_KINDS.length]
                patch({ scheduleKind: next.value })
                const group = event.currentTarget.parentElement
                requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {fieldError('schedule')}
        {draft.scheduleKind === 'interval' ? (
          <div className="scheduled-inline">
            <label className="scheduled-label" htmlFor={id('minutes')}>Minutes between runs</label>
            <input id={id('minutes')} className="scheduled-input narrow" inputMode="numeric" value={draft.minutes} {...field('minutes')} onChange={(event) => patch({ minutes: event.target.value })} />
          </div>
        ) : null}
        {fieldError('minutes')}
        {draft.scheduleKind === 'cron' ? (
          <div className="scheduled-inline">
            <label className="scheduled-label" htmlFor={id('expr')}>Cron expression</label>
            <input id={id('expr')} className="scheduled-input" placeholder="0 9 * * *" value={draft.expr} {...field('expr')} onChange={(event) => patch({ expr: event.target.value })} />
          </div>
        ) : null}
        {fieldError('expr')}
        {draft.scheduleKind === 'once' ? (
          <div className="scheduled-inline">
            <label className="scheduled-label" htmlFor={id('runAt')}>Run at</label>
            <input id={id('runAt')} className="scheduled-input narrow" type="datetime-local" value={draft.runAt} {...field('runAt')} onChange={(event) => patch({ runAt: event.target.value })} />
          </div>
        ) : null}
        {fieldError('runAt')}
        {draft.scheduleKind === 'manual' ? <p className="scheduled-note">Runs only when you press Run now{job?.trigger?.webhook ? ' or its webhook is called' : ', or once you add a webhook'}.</p> : null}
      </div>

      <div className="scheduled-field-grid">
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('model')}>Model</label>
          <select id={id('model')} className="scheduled-input" value={draft.modelKey} onChange={(event) => patch({ modelKey: event.target.value })}>
            <option value="">Default model</option>
            {draft.staleSelection && draft.modelKey !== '' && !catalog.models.some((group) => group.choices.some((choice) => choice.key === draft.modelKey)) ? (
              <option value={draft.modelKey}>{draft.staleSelection.model} (not available now)</option>
            ) : null}
            {catalog.models.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('mode')}>Mode</label>
          <select id={id('mode')} className="scheduled-input" value={draft.mode} onChange={(event) => patch({ mode: event.target.value as JobDraft['mode'] })}>
            {modeChoices(draft).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </div>
      </div>
      {draft.mode === '' ? <p className="scheduled-note" data-testid="mode-note">{MODE_NOTE}</p> : null}

      {takesPermissionMode(draft) ? (
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('permission')}>Permissions</label>
          <select
            id={id('permission')}
            className="scheduled-input"
            value={draft.permissionMode}
            {...field('permission')}
            onChange={(event) => patch({ permissionMode: event.target.value as JobDraft['permissionMode'] })}
          >
            {permissionChoices(draft, catalog, job).map((choice) => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}
          </select>
          {fieldError('permission')}
          <p className="scheduled-note" data-testid="permission-note">
            {held.exact
              ? `A run never does more without asking than ${describePermissionMode(held.mode)}, the mode you hold for this job now.`
              : 'The thread that owns the worktree sets what you can choose, so only Ask before acting is offered here. Default follows that thread.'}
            {job?.permissionCeiling ? ` This job's limit is ${describePermissionMode(job.permissionCeiling)}: what its creator held. A run follows its thread, never above that limit.` : ''}
          </p>
          {lowered ? <p className="scheduled-note warn" data-testid="permission-lowered">Saving lowers this job's mode from {describePermissionMode(draft.permissionMode as PermissionMode)} to {describePermissionMode(lowered)}, the most you hold for the thread you chose.</p> : null}
        </div>
      ) : (
        <p className="scheduled-note" data-testid="workflow-permission-note">{WORKFLOW_PERMISSION_NOTE}</p>
      )}

      <div className="scheduled-field-grid">
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('project')}>Project</label>
          <select
            id={id('project')}
            className="scheduled-input"
            value={draft.projectId}
            onChange={(event) => {
              const projectId = event.target.value
              const keep = catalog.threads.some((thread) => thread.id === draft.threadId && (!projectId || thread.projectId === projectId))
              patch({ projectId, ...(keep || draft.threadId === '' || draft.workspaceKind === 'worktree' ? {} : { threadId: '' }) })
            }}
          >
            <option value="">No project</option>
            {catalog.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            {draft.projectId && !catalog.projects.some((project) => project.id === draft.projectId) ? <option value={draft.projectId}>Unknown project</option> : null}
          </select>
        </div>
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('thread')}>Target thread</label>
          <select
            id={id('thread')}
            className="scheduled-input"
            value={threadLocked ? '' : draft.threadId}
            disabled={threadLocked}
            onChange={(event) => patch({ threadId: event.target.value })}
          >
            <option value="">{threadLocked ? 'The thread that owns the worktree' : 'A new thread for each run'}</option>
            {!threadLocked && draft.threadId && !knownThread ? <option value={draft.threadId}>Unknown thread</option> : null}
            {projectThreads.map((thread) => <option key={thread.id} value={thread.id}>{thread.name}</option>)}
          </select>
        </div>
      </div>

      {workspaceShown ? (
        <div className="scheduled-field">
          <label className="scheduled-label" htmlFor={id('workspace')}>Workspace</label>
          <select
            id={id('workspace')}
            className="scheduled-input"
            value={draft.workspaceKind}
            {...field('workspace')}
            onChange={(event) => {
              const workspaceKind = event.target.value as WorkspaceKind
              // A job on a worktree runs on the thread that owns it: leaving that drops the owner from the form.
              patch({ workspaceKind, ...(draft.workspaceKind === 'worktree' && workspaceKind !== 'worktree' ? { threadId: '' } : {}) })
            }}
          >
            {workspaceChoices(draft).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          {fieldError('workspace')}
          {draft.workspaceKind === 'worktree' ? (
            <div className="scheduled-inline">
              <label className="scheduled-label" htmlFor={id('worktreePath')}>Worktree path</label>
              <input id={id('worktreePath')} className="scheduled-input" placeholder="/path/to/worktree" value={draft.worktreePath} {...field('worktreePath')} onChange={(event) => patch({ worktreePath: event.target.value })} />
            </div>
          ) : null}
          {fieldError('worktreePath')}
          {draft.workspaceKind === 'project' && draft.mode !== 'plan' ? <p className="scheduled-note warn" data-testid="workspace-warning">{PROJECT_WORKSPACE_WARNING}</p> : null}
        </div>
      ) : draft.threadId ? (
        <p className="scheduled-note">The run uses the thread's own workspace.</p>
      ) : null}

      {failure ? <p className="scheduled-item-error" role="alert" data-testid="save-error">{failure}</p> : null}
      <div className="scheduled-form-actions">
        <button type="button" className="scheduled-btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="scheduled-btn primary" disabled={busy}>{job ? 'Save' : 'Create'}</button>
      </div>
    </form>
  )
}
