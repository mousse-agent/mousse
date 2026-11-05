import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  X,
  Zap
} from '../lib/icons'
import { normalizePermissionMode } from '../../shared/permissionMode'
import type { LlmProviderOption } from '../../shared/settings'
import { AGENT_JOB_LIMIT_DEFAULTS } from '../../shared/agentJobLimits'
import type { ScheduledJob, ScheduledJobRunRecord, ScheduledSettings, ScheduledSettingsUpdate, SchedulerStatus } from '../../shared/types'
import { AgentJobLimitFields } from './scheduled/AgentJobLimitFields'
import { JobEditor } from './scheduled/JobEditor'
import { RowMenu } from './integrations/RowMenu'
import { SettingsAdvanced, Switch } from './settings/SettingsRow'
import { Modal } from './ui/Modal'
import {
  createInputOf,
  draftFromJob,
  EMPTY_CATALOG,
  isUnchanged,
  modelGroups,
  newDraft,
  patchOf,
  type JobDraft,
  type ScheduledCatalog
} from './scheduled/jobDraft'
import {
  describeLastStatus,
  describeMode,
  describeModel,
  describePermission,
  describeRunProgress,
  describeSchedule,
  describeWorkspace,
  errorText,
  formatWhen,
  RUN_STATUS_LABEL
} from './scheduled/scheduledLabels'
import { WebhookDialog, type WebhookApi } from './scheduled/WebhookDialog'
import { openThread } from '../lib/openThread'
import '../styles/scheduled-panel.css'

/** Which record was newest when Run now was pressed: a different newest one is that run's. */
function newestRecordKey(job: ScheduledJob): string | null {
  const last = job.runHistory?.[job.runHistory.length - 1]
  return last ? `${last.runAt}|${last.runId ?? ''}|${job.runHistory!.length}` : null
}

/** A Run now press being followed: the status line under the toolbar reads from the job as it updates. */
interface RunWatch {
  jobId: string
  before: string | null
}

function stateLabel(job: ScheduledJob): string {
  // A working occurrence says whether it waits for the person (derived when the job is listed).
  if (job.liveStatus === 'needs_answer') return 'Needs your answer'
  if (job.liveStatus === 'running') return 'Running'
  if (job.pendingOccurrence?.state === 'queued' && job.state !== 'paused') return 'Queued'
  switch (job.state) {
    case 'scheduled':
      return 'Scheduled'
    case 'running':
      return 'Running'
    case 'paused':
      return 'Paused'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Error'
  }
}

const HISTORY_ROWS = 10

/** The thread where the job's current occurrence runs, else where its last recorded run ran. */
function runThreadId(job: ScheduledJob): string | undefined {
  return job.liveThreadId ?? job.pendingOccurrence?.threadId ?? [...(job.runHistory ?? [])].reverse().find((record) => record.threadId)?.threadId
}

function browserWebhookApi(): WebhookApi {
  const webhook = window.mousse.scheduled.webhook
  return {
    enable: (id) => webhook.enable(id),
    rotate: (id) => webhook.rotate(id),
    disable: (id) => webhook.disable(id),
    deliveries: (id) => webhook.deliveries(id),
    copy: (text) => navigator.clipboard.writeText(text)
  }
}

interface Editing {
  id: string
  initial: JobDraft
}

export function ScheduledPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [catalog, setCatalog] = useState<ScheduledCatalog>(EMPTY_CATALOG)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [webhookJobId, setWebhookJobId] = useState<string | null>(null)
  /** `scheduled.agentJobs` and the limits on the jobs agents create; null until the profile has answered. */
  const [settings, setSettings] = useState<ScheduledSettings | null>(null)
  const agentJobs = settings ? settings.agentJobs : null
  /** What "Extend" gives a job: the lifetime of jobs agents create (the default until the profile has answered). */
  const extendDays = settings?.agentJobLifetimeDays ?? AGENT_JOB_LIMIT_DEFAULTS.lifetimeDays
  const [actionError, setActionError] = useState<string | null>(null)
  /** The scheduler could not be asked how it is: shown as unavailable rather than as stopped. */
  const [unavailable, setUnavailable] = useState(false)
  const [runWatch, setRunWatch] = useState<RunWatch | null>(null)
  const [deleting, setDeleting] = useState<ScheduledJob | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const webhookApi = useMemo(browserWebhookApi, [])
  const detailsId = useId()
  const agentToggleId = useId()

  const loadCatalog = useCallback(async () => {
    try {
      const [options, projects, threads, settings] = await Promise.all([
        window.mousse.settings.getOptions(),
        window.mousse.projects.list(),
        window.mousse.threads.listAll(),
        window.mousse.settings.get()
      ])
      setProviders(options.llmProviders)
      setCatalog({
        models: modelGroups(options.llmProviders),
        projects,
        threads: threads.filter((thread) => !thread.lineage && !thread.settledAt),
        // A job made without a thread is made in the mode threads start in; it is also the most the job may run with.
        defaultPermissionMode: normalizePermissionMode(settings.permissions?.defaultMode)
      })
    } catch {
      // The form still works with the defaults; a model or project it cannot list is simply not offered.
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [nextJobs, nextStatus] = await Promise.all([
        window.mousse.scheduled.list(),
        window.mousse.scheduled.status()
      ])
      setJobs(nextJobs)
      setStatus(nextStatus)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadCatalog()
    void window.mousse.scheduled.settings.get().then(setSettings, () => undefined)
    const offUpdated = window.mousse.scheduled.onUpdated(setJobs)
    const offStatus = window.mousse.scheduled.onStatus(setStatus)
    return () => {
      offUpdated()
      offStatus()
    }
  }, [refresh, loadCatalog])

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER
        const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER
        return aTime - bTime
      }),
    [jobs]
  )

  const webhookJob = webhookJobId ? jobs.find((job) => job.id === webhookJobId) : undefined
  // A job deleted while its webhook dialog is open closes the dialog (and with it the secret).
  useEffect(() => {
    if (webhookJobId && !webhookJob && jobs.length > 0) setWebhookJobId(null)
  }, [webhookJobId, webhookJob, jobs.length])

  const focusLater = (selector: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError(errorText(cause))
    }
  }

  const saveSettings = (update: ScheduledSettingsUpdate) =>
    act(async () => setSettings(await window.mousse.scheduled.settings.set(update)))

  const openCreate = () => {
    setEditing(null)
    setCreating(true)
    void loadCatalog()
  }

  const startEdit = (job: ScheduledJob) => {
    setCreating(false)
    setEditing({ id: job.id, initial: draftFromJob(job, catalog, providers) })
    void loadCatalog()
  }

  /** The row's "…" button, where Edit, Webhook and Delete live: focus goes back there when they finish. */
  const moreButton = (jobId: string) => `[data-job-id="${jobId}"] .row-menu-btn`

  const closeEditor = (jobId?: string) => {
    setCreating(false)
    setEditing(null)
    if (jobId) focusLater(moreButton(jobId))
    else newButton.current?.focus()
  }

  const runNow = async (job: ScheduledJob) => {
    setActionError(null)
    setRunWatch({ jobId: job.id, before: newestRecordKey(job) })
    try {
      await window.mousse.scheduled.run(job.id)
    } catch (cause) {
      setRunWatch(null)
      setActionError(errorText(cause))
      return
    }
    // The job's own update normally arrives first; asking again covers a missed one.
    void refresh()
  }

  const askDelete = (job: ScheduledJob) => {
    setDeleteError(null)
    setDeleting(job)
  }

  const cancelDelete = () => {
    if (deleteBusy || !deleting) return
    const jobId = deleting.id
    setDeleting(null)
    focusLater(moreButton(jobId))
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const jobId = deleting.id
    // Focus moves on to the row below, else the row above, else New job.
    const order = sortedJobs.map((item) => item.id)
    const index = order.indexOf(jobId)
    const neighbour = order[index + 1] ?? order[index - 1]
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await window.mousse.scheduled.delete(jobId)
    } catch (cause) {
      setDeleteError(errorText(cause))
      setDeleteBusy(false)
      return
    }
    setDeleteBusy(false)
    setDeleting(null)
    if (selectedId === jobId) setSelectedId(null)
    if (runWatch?.jobId === jobId) setRunWatch(null)
    setJobs((current) => current.filter((item) => item.id !== jobId))
    if (neighbour) focusLater(`[data-job-id="${neighbour}"] [data-row-button]`)
    else requestAnimationFrame(() => newButton.current?.focus())
    void refresh()
  }

  const moveBetweenRows = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-row-button]') ?? [])]
    const index = rows.indexOf(event.currentTarget)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }

  const nameOfThread = (threadId: string) => catalog.threads.find((thread) => thread.id === threadId)?.name
  const nameOfProject = (projectId: string) => catalog.projects.find((project) => project.id === projectId)?.name

  const schedulerState = unavailable ? 'unavailable' : status === null ? 'loading' : status.running ? 'running' : 'stopped'
  const watchedJob = runWatch ? jobs.find((item) => item.id === runWatch.jobId) : undefined
  const watchedRecord = watchedJob && newestRecordKey(watchedJob) !== runWatch?.before ? watchedJob.runHistory?.[watchedJob.runHistory.length - 1] : undefined
  const runProgress = watchedJob ? describeRunProgress(watchedJob.name, watchedRecord, watchedJob.liveStatus) : null
  const watchedThreadId = watchedJob ? (watchedRecord?.threadId ?? (watchedJob.liveStatus ? runThreadId(watchedJob) : undefined)) : undefined

  return (
    <div className="scheduled-panel">
      <div className="scheduled-toolbar">
        <div className="scheduled-stats">
          {schedulerState === 'loading' ? null : (
            <span
              className={`scheduled-stat${schedulerState === 'running' ? '' : ' warn'}`}
              data-testid="scheduler-state"
              title={
                schedulerState === 'stopped'
                  ? 'Jobs do not run while the scheduler is stopped. Refresh to check again.'
                  : schedulerState === 'unavailable'
                    ? 'The scheduler did not answer. Refresh to try again.'
                    : undefined
              }
            >
              <span className={`scheduled-dot ${schedulerState === 'running' ? 'on' : 'warn'}`} />
              {schedulerState === 'running' ? 'Running' : schedulerState === 'unavailable' ? 'Unavailable' : 'Stopped'}
            </span>
          )}
          {status && !unavailable ? (
            <>
              <span className="scheduled-stat-sep" />
              <span className="scheduled-stat">{status.jobCount} jobs</span>
              <span className="scheduled-stat-sep" />
              <span className="scheduled-stat">{status.dueCount} due</span>
            </>
          ) : null}
        </div>
        <div className="scheduled-toolbar-actions">
          <button
            type="button"
            className="scheduled-icon-btn"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={15} strokeWidth={2} />
          </button>
          <button
            ref={newButton}
            type="button"
            className="scheduled-btn primary"
            aria-expanded={creating}
            onClick={() => (creating ? closeEditor() : openCreate())}
          >
            <Plus size={14} strokeWidth={2} />
            New job
          </button>
        </div>
      </div>

      <div className="scheduled-settings">
        <SettingsAdvanced label={`Jobs agents create · ${agentJobs === true ? 'On' : agentJobs === false ? 'Off' : '…'}`}>
          <div
            className="settings-item"
            title="Lets agents create, change, pause and run their own scheduled jobs through Mousse's tools, from a turn you started. It also needs the Manage agent access level. Jobs agents create run no wider than that agent, end after the lifetime set here unless you extend them, and are paused when you turn this off (you resume them)."
          >
            <div className="settings-item-text">
              <label className="settings-item-title" htmlFor={agentToggleId}>Agents may create jobs</label>
            </div>
            <div className="settings-item-control">
              <Switch
                id={agentToggleId}
                checked={agentJobs === true}
                disabled={agentJobs === null}
                onChange={(next) => void saveSettings({ agentJobs: next })}
              />
            </div>
          </div>
          <AgentJobLimitFields settings={settings} save={saveSettings} />
        </SettingsAdvanced>
      </div>

      {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}
      <div className="scheduled-run-status" role="status" aria-live="polite">
        {runProgress && watchedJob ? (
          <>
            <span className={runProgress.failed ? 'settings-status-bad' : undefined} data-testid="run-progress">{runProgress.text}</span>
            {watchedThreadId ? (
              <button type="button" className="scheduled-link-btn" onClick={() => void openThread(watchedThreadId)}>
                Open thread
              </button>
            ) : null}
            <button type="button" className="settings-icon-btn scheduled-run-status-close" title="Dismiss" aria-label="Dismiss" onClick={() => setRunWatch(null)}>
              <X size={14} />
            </button>
          </>
        ) : null}
      </div>

      {creating ? (
        <JobEditor
          initial={newDraft()}
          catalog={catalog}
          onCancel={() => closeEditor()}
          save={async (draft) => {
            await window.mousse.scheduled.create(createInputOf(draft, catalog))
            closeEditor()
            await refresh()
          }}
        />
      ) : null}

      <div className="scheduled-list" ref={listRef}>
        {sortedJobs.length === 0 ? (
          <div className="scheduled-empty">No jobs yet.</div>
        ) : (
          sortedJobs.map((job) => {
            if (editing?.id === job.id) {
              return (
                <div key={job.id} className="scheduled-item editing" data-job-id={job.id}>
                  <JobEditor
                    job={job}
                    initial={editing.initial}
                    catalog={catalog}
                    onCancel={() => closeEditor(job.id)}
                    save={async (draft) => {
                      const patch = patchOf(editing.initial, draft, catalog)
                      if (!isUnchanged(patch)) await window.mousse.scheduled.update(job.id, patch)
                      closeEditor(job.id)
                      await refresh()
                    }}
                  />
                </div>
              )
            }
            const selected = selectedId === job.id
            const workspace = describeWorkspace(job.workspace, job)
            const thread = job.threadId ? nameOfThread(job.threadId) : undefined
            const project = job.projectId ? nameOfProject(job.projectId) : undefined
            return (
              <div key={job.id} className="scheduled-item" data-job-id={job.id} data-selected={selected ? 'true' : undefined}>
                <div className="scheduled-item-main">
                  <div className="scheduled-item-top">
                    <button
                      type="button"
                      className="scheduled-item-select"
                      data-row-button=""
                      aria-expanded={selected}
                      aria-controls={selected ? `${detailsId}-${job.id}` : undefined}
                      onClick={() => setSelectedId(selected ? null : job.id)}
                      onKeyDown={moveBetweenRows}
                    >
                      <span className="scheduled-item-title">{job.name}</span>
                    </button>
                    <span className="scheduled-status">
                      <span className={`scheduled-dot state-${job.state}${job.state === 'running' ? ' on' : ''}`} />
                      {stateLabel(job)}
                    </span>
                  </div>
                  <div className="scheduled-item-meta" data-meta="summary">
                    <span data-meta="schedule">{describeSchedule(job.schedule)}</span>
                    {job.nextRunAt ? <span data-meta="next">Next {formatWhen(job.nextRunAt)}</span> : null}
                    {job.lastStatus ? <span data-meta="last" className={job.lastStatus === 'error' ? 'settings-status-bad' : undefined}>Last: {describeLastStatus(job.lastStatus)}</span> : null}
                  </div>
                  {job.state === 'paused' && job.pausedReason ? <p className="scheduled-item-note" data-meta="paused-reason">Paused: {job.pausedReason}</p> : null}
                  {job.lastError && <p className="scheduled-item-error">{job.lastError}</p>}
                  {selected ? (
                    <div className="scheduled-item-details" id={`${detailsId}-${job.id}`}>
                      <p className="scheduled-item-prompt">{job.prompt}</p>
                      <div className="scheduled-item-meta" aria-label="Job settings">
                        <span data-meta="model">{describeModel(job.selection)}</span>
                        <span data-meta="mode">{describeMode(job.mode)}</span>
                        {job.permissionMode ? <span data-meta="permission">{describePermission(job.permissionMode)}</span> : null}
                        {workspace ? <span data-meta="workspace">{workspace}</span> : null}
                        {project ? <span data-meta="project">{project}</span> : null}
                        {thread ? <span data-meta="thread">Thread: {thread}</span> : null}
                        {job.trigger?.webhook ? <span data-meta="webhook">Webhook</span> : null}
                        {job.createdBy ? <span data-meta="agent">Created by an agent</span> : null}
                        {job.lastRunAt ? <span data-meta="last-run">Last run {formatWhen(job.lastRunAt)}</span> : null}
                        {job.expiresAt ? (
                          <span data-meta="expires">
                            {job.state === 'completed' && new Date(job.expiresAt).getTime() <= Date.now() ? 'Ended' : 'Ends'} {formatWhen(job.expiresAt)}{' '}
                            <button type="button" className="scheduled-link-btn" onClick={() => void act(() => window.mousse.scheduled.extend(job.id))}>
                              {`Extend ${extendDays} ${extendDays === 1 ? 'day' : 'days'}`}
                            </button>
                          </span>
                        ) : null}
                      </div>
                      <RunHistory job={job} />
                    </div>
                  ) : null}
                </div>
                <div className="scheduled-item-actions">
                  {runThreadId(job) ? (
                    <button
                      type="button"
                      className="scheduled-icon-btn"
                      title="Open the run's thread"
                      aria-label={`Open the thread of ${job.name}'s run`}
                      onClick={() => void openThread(runThreadId(job)!)}
                    >
                      <MessageSquare size={14} strokeWidth={2} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Run now"
                    aria-label={`Run ${job.name} now`}
                    onClick={() => void runNow(job)}
                  >
                    <Zap size={14} strokeWidth={2} />
                  </button>
                  {job.state === 'paused' ? (
                    <button
                      type="button"
                      className="scheduled-icon-btn"
                      title="Resume"
                      aria-label={`Resume ${job.name}`}
                      onClick={() => void act(() => window.mousse.scheduled.resume(job.id))}
                    >
                      <Play size={14} strokeWidth={2} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="scheduled-icon-btn"
                      title="Pause"
                      aria-label={`Pause ${job.name}`}
                      onClick={() => void act(() => window.mousse.scheduled.pause(job.id))}
                    >
                      <Pause size={14} strokeWidth={2} />
                    </button>
                  )}
                  <RowMenu
                    label={`More actions for ${job.name}`}
                    items={[
                      { label: 'Edit', onSelect: () => startEdit(job) },
                      { label: 'Webhook', onSelect: () => setWebhookJobId(job.id) },
                      { label: 'Delete', danger: true, onSelect: () => askDelete(job) }
                    ]}
                  />
                </div>
              </div>
            )
          })
        )}
      </div>

      {webhookJob ? (
        <WebhookDialog
          job={webhookJob}
          api={webhookApi}
          onClose={() => {
            setWebhookJobId(null)
            focusLater(moreButton(webhookJob.id))
          }}
        />
      ) : null}

      {deleting ? (
        <Modal
          open
          title={`Delete “${deleting.name}”?`}
          onClose={cancelDelete}
          closeDisabled={deleteBusy}
          footer={
            <>
              <button type="button" className="settings-btn" disabled={deleteBusy} onClick={cancelDelete}>Cancel</button>
              <button type="button" className="settings-btn danger" data-testid="delete-job-confirm" disabled={deleteBusy} onClick={() => void confirmDelete()}>
                Delete
              </button>
            </>
          }
        >
          <p className="scheduled-note">Its run history is deleted too; the threads it ran in stay.</p>
          {deleteError ? <p className="scheduled-item-error" role="alert">{deleteError}</p> : null}
        </Modal>
      ) : null}
    </div>
  )
}

function RunHistory({ job }: { job: ScheduledJob }) {
  const records: ScheduledJobRunRecord[] = [...(job.runHistory ?? [])].reverse().slice(0, HISTORY_ROWS)
  return (
    <section className="scheduled-history" aria-label={`Run history for ${job.name}`}>
      {records.length === 0 ? (
        <p className="scheduled-empty">No runs yet.</p>
      ) : (
        <ul>
          {records.map((record, index) => {
            const workspace = describeWorkspace(record.workspace, job)
            return (
              <li key={`${record.runAt}-${record.runId ?? index}`} className="scheduled-history-row" data-status={record.status}>
                <span className="scheduled-history-status">{RUN_STATUS_LABEL[record.status]}</span>
                <span>{formatWhen(record.runAt)}</span>
                {record.selection ? <span data-meta="model">{describeModel(record.selection)}</span> : null}
                {record.mode ? <span data-meta="mode">{describeMode(record.mode)}</span> : null}
                {record.permissionMode ? <span data-meta="permission">{describePermission(record.permissionMode)}</span> : null}
                {workspace && record.workspace ? <span data-meta="workspace">{workspace}</span> : null}
                {record.agentCreated ? <span data-meta="agent">Job created by an agent</span> : null}
                {record.missingPlaceholders?.length ? <span data-meta="missing">Missing fields: {record.missingPlaceholders.join(', ')}</span> : null}
                {record.error ? <span className="scheduled-history-error">{record.error}</span> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
