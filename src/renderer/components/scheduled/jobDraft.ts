import {
  DEFAULT_PERMISSION_MODE,
  describePermissionMode,
  isStricter,
  normalizePermissionMode,
  PERMISSION_MODES,
  type PermissionMode
} from '../../../shared/permissionMode'
import { isExecutableJobEdit, isWorkflowPrompt } from '../../../shared/jobPermissionEdit'
import { listingKey, listingServes, selectionFromListing, type ModelOverride } from '../../../shared/providerInstances'
import type { LlmProviderOption } from '../../../shared/settings'
import { modelChoiceOf, modelLabel } from '../../../shared/modelChoice'
import type {
  CreateScheduledJobInput,
  JobSchedule,
  Project,
  ScheduledJob,
  ScheduledJobPatch,
  ScheduledJobWorkspace,
  ScheduleKind,
  Thread
} from '../../../shared/types'

/** What the editor offers to choose from. */
export interface ScheduledCatalog {
  models: ModelGroup[]
  projects: Project[]
  /** Threads a job can run on: no subagent threads, no settled ones. */
  threads: Thread[]
  /** The mode threads start in; a job with no thread of its own is created in it. */
  defaultPermissionMode: PermissionMode
}

export interface ModelChoice {
  key: string
  label: string
  selection: ModelOverride
}

export interface ModelGroup {
  label: string
  choices: ModelChoice[]
}

export const EMPTY_CATALOG: ScheduledCatalog = { models: [], projects: [], threads: [], defaultPermissionMode: DEFAULT_PERMISSION_MODE }

const KEY_SEPARATOR = '\u0000'

export function modelGroups(providers: LlmProviderOption[]): ModelGroup[] {
  return providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: provider.label,
      choices: provider.models.map((model) => ({
        key: `${listingKey(provider)}${KEY_SEPARATOR}${model.id}`,
        label: modelLabel(modelChoiceOf({ instanceId: provider.instanceId, provider: provider.id, model: model.id }, model.label)),
        selection: selectionFromListing(provider, model.id)
      }))
    }))
}

/** The key of the choice that serves a job's selection; a model the lists no longer offer gets a key of its own. */
export function modelKeyOf(selection: ModelOverride | undefined, groups: ModelGroup[], providers: LlmProviderOption[]): string {
  if (!selection) return ''
  const listing = providers.find((provider) => listingServes(provider, selection))
  if (listing) return `${listingKey(listing)}${KEY_SEPARATOR}${selection.model}`
  return `${selection.instanceId ?? selection.llmProvider}${KEY_SEPARATOR}${selection.model}`
}

export type WorkspaceKind = 'project' | 'newWorktree' | 'worktree'

/** The form's fields as typed. `''` in a choice field means "not set": the job's default applies. */
export interface JobDraft {
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  /** `datetime-local` value, local time. */
  runAt: string
  minutes: string
  expr: string
  modelKey: string
  /** The model of a job whose provider no longer lists it; kept so saving without touching it changes nothing. */
  staleSelection?: ModelOverride
  mode: '' | 'agent' | 'plan'
  /** How much the run may do without asking; `''` follows the thread. Never above what the person holds. */
  permissionMode: '' | PermissionMode
  projectId: string
  threadId: string
  workspaceKind: WorkspaceKind
  worktreePath: string
}

export function toLocalInput(iso: string | undefined, fallbackOffsetMs = 5 * 60_000): string {
  const date = iso ? new Date(iso) : new Date(Date.now() + fallbackOffsetMs)
  const valid = Number.isNaN(date.getTime()) ? new Date(Date.now() + fallbackOffsetMs) : date
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())}T${pad(valid.getHours())}:${pad(valid.getMinutes())}`
}

export function newDraft(): JobDraft {
  return {
    name: '',
    prompt: '',
    scheduleKind: 'interval',
    runAt: toLocalInput(undefined),
    minutes: '30',
    expr: '0 9 * * *',
    modelKey: '',
    mode: '',
    permissionMode: '',
    projectId: '',
    threadId: '',
    workspaceKind: 'project',
    worktreePath: ''
  }
}

export function draftFromJob(job: ScheduledJob, catalog: ScheduledCatalog, providers: LlmProviderOption[]): JobDraft {
  const base = newDraft()
  const modelKey = modelKeyOf(job.selection, catalog.models, providers)
  const known = catalog.models.some((group) => group.choices.some((choice) => choice.key === modelKey))
  return {
    ...base,
    name: job.name,
    prompt: job.prompt,
    scheduleKind: job.schedule.kind,
    runAt: job.schedule.kind === 'once' ? toLocalInput(job.schedule.runAt) : base.runAt,
    minutes: job.schedule.kind === 'interval' ? String(job.schedule.minutes ?? 30) : base.minutes,
    expr: job.schedule.kind === 'cron' ? job.schedule.expr ?? base.expr : base.expr,
    modelKey,
    ...(job.selection && !known ? { staleSelection: job.selection } : {}),
    mode: job.mode ?? '',
    permissionMode: job.permissionMode ? normalizePermissionMode(job.permissionMode) : '',
    projectId: job.projectId ?? '',
    threadId: job.threadId ?? '',
    workspaceKind: job.workspace?.kind ?? 'project',
    worktreePath: job.workspace?.kind === 'worktree' ? job.workspace.path : ''
  }
}

/** A job on an existing worktree runs on the thread that owns it, so its thread is not a choice. */
export const threadIsChosen = (draft: JobDraft): boolean => draft.workspaceKind !== 'worktree' && draft.threadId !== ''

/** The workspace field applies to a job with a project that does not run on a thread of its own choosing. */
export const showsWorkspace = (draft: JobDraft): boolean => draft.projectId !== '' && !threadIsChosen(draft)

/** Modes the job may use with the workspace it has: a plan-mode run never provisions a worktree. */
export function modeChoices(draft: JobDraft): Array<{ value: JobDraft['mode']; label: string }> {
  const choices: Array<{ value: JobDraft['mode']; label: string }> = [
    { value: '', label: 'Default' },
    { value: 'agent', label: 'Agent' }
  ]
  if (!(showsWorkspace(draft) && draft.workspaceKind === 'newWorktree')) choices.push({ value: 'plan', label: 'Plan (no changes)' })
  return choices
}

/** A prompt that starts with `/` runs a workflow, which takes no permission mode: the form hides the choice. */
export const takesPermissionMode = (draft: JobDraft): boolean => !isWorkflowPrompt(draft.prompt)

/**
 * The permission mode the person holds for this job, which is the job's ceiling: its target thread's mode, else the mode
 * threads start in. The profile works it out the same way and has the last word. `exact` is false when the form cannot
 * tell (the owner of an existing worktree is not known for a path just typed, or the thread is not in the list), and the
 * mode is then `ask`, so nothing above it is offered.
 */
export function heldPermissionMode(draft: JobDraft, catalog: ScheduledCatalog, job?: ScheduledJob): { mode: PermissionMode; exact: boolean } {
  let threadId = draft.threadId
  if (draft.workspaceKind === 'worktree' && draft.projectId !== '') {
    // A job on an existing worktree runs on the thread that owns it; a saved job records which one.
    const sameWorktree = job?.workspace?.kind === 'worktree' && job.workspace.path === draft.worktreePath.trim()
    threadId = sameWorktree && job?.threadId ? job.threadId : ''
    if (!threadId) return { mode: 'ask', exact: false }
  }
  if (!threadId) return { mode: normalizePermissionMode(catalog.defaultPermissionMode), exact: true }
  const thread = catalog.threads.find((candidate) => candidate.id === threadId)
  if (!thread) return { mode: 'ask', exact: false }
  return { mode: normalizePermissionMode(thread.permissionMode ?? catalog.defaultPermissionMode), exact: true }
}

/** The modes a job can run in: "Default" follows the thread up to the job's limit, and none is above what the person holds. */
export function permissionChoices(draft: JobDraft, catalog: ScheduledCatalog, job?: ScheduledJob): Array<{ value: JobDraft['permissionMode']; label: string; disabled: boolean }> {
  const held = heldPermissionMode(draft, catalog, job).mode
  const followsThread = draft.threadId !== '' || (draft.workspaceKind === 'worktree' && draft.projectId !== '')
  return [
    {
      value: '',
      label: followsThread ? "Default (the thread's mode, up to the job's limit)" : "Default (the mode new threads start in, up to the job's limit)",
      disabled: false
    },
    ...PERMISSION_MODES.map((mode) => ({ value: mode, label: describePermissionMode(mode), disabled: isStricter(held, mode) }))
  ]
}

/**
 * What saving will do to a mode the job already has when the person now holds less (a stricter thread): the profile
 * brings it down to what they hold. Only for an edit that changes what the job does, and not when they are choosing a mode now.
 */
export function loweredPermission(draft: JobDraft, initial: JobDraft, catalog: ScheduledCatalog, job?: ScheduledJob): PermissionMode | undefined {
  if (draft.permissionMode === '' || draft.permissionMode !== initial.permissionMode) return undefined
  const held = heldPermissionMode(draft, catalog, job)
  if (!held.exact || !isStricter(held.mode, draft.permissionMode)) return undefined
  return isExecutableJobEdit(patchOf(initial, draft, catalog)) ? held.mode : undefined
}

export function workspaceChoices(draft: JobDraft): Array<{ value: WorkspaceKind; label: string }> {
  const choices: Array<{ value: WorkspaceKind; label: string }> = [{ value: 'project', label: 'Project checkout' }]
  if (draft.mode !== 'plan') choices.push({ value: 'newWorktree', label: 'New worktree per run (recommended)' })
  choices.push({ value: 'worktree', label: 'Existing worktree' })
  return choices
}

export function scheduleOf(draft: JobDraft): JobSchedule {
  switch (draft.scheduleKind) {
    case 'once':
      return { kind: 'once', runAt: new Date(draft.runAt).toISOString() }
    case 'interval':
      return { kind: 'interval', minutes: Number(draft.minutes) }
    case 'cron':
      return { kind: 'cron', expr: draft.expr.trim() }
    case 'manual':
      return { kind: 'manual' }
  }
}

/** The workspace the job is saved with; `undefined` is the default (the project checkout, or the thread's own). */
export function workspaceOf(draft: JobDraft): ScheduledJobWorkspace | undefined {
  if (!draft.projectId) return undefined
  if (draft.workspaceKind === 'worktree') return { kind: 'worktree', path: draft.worktreePath.trim() }
  if (threadIsChosen(draft)) return undefined
  return draft.workspaceKind === 'newWorktree' ? { kind: 'newWorktree' } : undefined
}

export type DraftField = 'name' | 'prompt' | 'minutes' | 'expr' | 'runAt' | 'schedule' | 'worktreePath' | 'workspace' | 'permission'

/**
 * What stops the job from saving. Messages say what to change. `held` is the mode the person holds for a permission
 * mode they are choosing now (leave it out for one the job already had).
 */
export function validateDraft(draft: JobDraft, context: { hasWebhook: boolean; requireName: boolean; held?: PermissionMode }): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {}
  if (context.requireName && !draft.name.trim()) errors.name = 'Give the job a name.'
  if (!draft.prompt.trim()) errors.prompt = 'Write the prompt the job runs.'
  if (draft.scheduleKind === 'interval') {
    const minutes = Number(draft.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 365) errors.minutes = 'Use a whole number of minutes, at least 1.'
  }
  if (draft.scheduleKind === 'cron' && draft.expr.trim().split(/\s+/).filter(Boolean).length < 5) {
    errors.expr = 'A cron expression has five fields, for example 0 9 * * *.'
  }
  if (draft.scheduleKind === 'once' && Number.isNaN(new Date(draft.runAt).getTime())) errors.runAt = 'Pick the date and time to run.'
  if (draft.scheduleKind === 'once' && context.hasWebhook) {
    errors.schedule = 'A job with a webhook cannot be one-time. Use a manual schedule, or disable its webhook first.'
  }
  if (takesPermissionMode(draft) && draft.permissionMode !== '' && context.held !== undefined && isStricter(context.held, draft.permissionMode)) {
    errors.permission = `A job cannot run above the mode you hold here. ${describePermissionMode(draft.permissionMode)} is wider than ${describePermissionMode(context.held)}; choose ${describePermissionMode(context.held)} or stricter.`
  }
  if (showsWorkspace(draft) || draft.workspaceKind === 'worktree') {
    if (draft.workspaceKind === 'newWorktree' && draft.mode === 'plan') {
      errors.workspace = 'A plan-mode job never creates a worktree. Choose Agent mode or the project checkout.'
    }
    if (draft.workspaceKind === 'worktree' && !draft.worktreePath.trim()) errors.worktreePath = 'Enter the path of the worktree.'
  }
  return errors
}

const sameSchedule = (a: JobDraft, b: JobDraft): boolean => {
  if (a.scheduleKind !== b.scheduleKind) return false
  switch (a.scheduleKind) {
    case 'once':
      return a.runAt === b.runAt
    case 'interval':
      return a.minutes.trim() === b.minutes.trim()
    case 'cron':
      return a.expr.trim() === b.expr.trim()
    case 'manual':
      return true
  }
}

const choiceOf = (draft: JobDraft, catalog: ScheduledCatalog): ModelChoice | undefined =>
  catalog.models.flatMap((group) => group.choices).find((choice) => choice.key === draft.modelKey)

/** The input for a new job. A job without a target thread gets a thread per run. */
export function createInputOf(draft: JobDraft, catalog: ScheduledCatalog): CreateScheduledJobInput {
  const workspace = workspaceOf(draft)
  const thread = threadIsChosen(draft)
  const choice = choiceOf(draft, catalog)
  return {
    name: draft.name.trim() || 'Scheduled job',
    prompt: draft.prompt.trim(),
    schedule: scheduleOf(draft),
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(thread ? { threadId: draft.threadId } : { createThread: true }),
    ...(choice ? { selection: choice.selection } : {}),
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.permissionMode && takesPermissionMode(draft) ? { permissionMode: draft.permissionMode } : {}),
    ...(workspace ? { workspace } : {})
  }
}

/** Only what the person changed, so saving never rewrites a field they did not touch. `null` clears. */
export function patchOf(initial: JobDraft, draft: JobDraft, catalog: ScheduledCatalog): ScheduledJobPatch {
  const patch: ScheduledJobPatch = {}
  if (draft.name.trim() !== initial.name.trim()) patch.name = draft.name.trim()
  if (draft.prompt.trim() !== initial.prompt.trim()) patch.prompt = draft.prompt.trim()
  if (!sameSchedule(initial, draft)) patch.schedule = scheduleOf(draft)
  if (draft.modelKey !== initial.modelKey) patch.selection = choiceOf(draft, catalog)?.selection ?? null
  if (draft.mode !== initial.mode) patch.mode = draft.mode || null
  // A prompt that became a workflow loses its permission mode: workflows do not run under one.
  const wantedPermission = takesPermissionMode(draft) ? draft.permissionMode : ''
  if (wantedPermission !== initial.permissionMode) patch.permissionMode = wantedPermission || null
  if (draft.projectId !== initial.projectId) patch.projectId = draft.projectId || null
  const workspace = workspaceOf(draft) ?? null
  const workspaceChanged = JSON.stringify(workspace) !== JSON.stringify(workspaceOf(initial) ?? null)
  if (workspaceChanged) patch.workspace = workspace
  if (workspace?.kind === 'worktree') {
    // The worktree's owner is worked out again from its path, so the old thread must not travel with a new path.
    if (workspaceChanged) patch.threadId = null
  } else if (draft.threadId !== initial.threadId) {
    // Leaving a worktree job drops the thread it owned; the editor clears it from the draft.
    patch.threadId = draft.threadId || null
    patch.createThread = draft.threadId === ''
  }
  return patch
}

export function isUnchanged(patch: ScheduledJobPatch): boolean {
  return Object.keys(patch).length === 0
}
