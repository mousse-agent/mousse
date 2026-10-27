import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  Zap
} from '../lib/icons'
import { normalizePermissionMode } from '../../shared/permissionMode'
import type { LlmProviderOption } from '../../shared/settings'
import type { ScheduledJob, ScheduledJobRunRecord, SchedulerStatus } from '../../shared/types'
import { JobEditor } from './scheduled/JobEditor'
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
  describeSchedule,
  describeWorkspace,
  errorText,
  RUN_STATUS_LABEL
} from './scheduled/scheduledLabels'
import { WebhookDialog, type WebhookApi } from './scheduled/WebhookDialog'
import '../styles/scheduled-panel.css'

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'none'
  return new Date(iso).toLocaleString()
}

function stateLabel(job: ScheduledJob): string {
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
  const [actionError, setActionError] = useState<string | null>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const webhookApi = useMemo(browserWebhookApi, [])
  const detailsId = useId()

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
    const [nextJobs, nextStatus] = await Promise.all([
      window.mousse.scheduled.list(),
      window.mousse.scheduled.status()
    ])
    setJobs(nextJobs)
    setStatus(nextStatus)
  }, [])

  useEffect(() => {
    void refresh()
    void loadCatalog()
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

  const closeEditor = (jobId?: string) => {
    setCreating(false)
    setEditing(null)
    if (jobId) focusLater(`[data-edit-job="${jobId}"]`)
    else newButton.current?.focus()
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

  return (
    <div className="scheduled-panel">
      <div className="scheduled-toolbar">
        <div className="scheduled-stats">
          <span className="scheduled-stat">
            <span className={`scheduled-dot${status?.running ? ' on' : ''}`} />
            {status?.running ? 'Running' : 'Stopped'}
          </span>
          {status ? (
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

      {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}

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
                  <p className="scheduled-item-prompt">{job.prompt}</p>
                  <div className="scheduled-item-meta" aria-label="Job settings">
                    <span>{describeSchedule(job.schedule)}</span>
                    <span data-meta="model">{describeModel(job.selection)}</span>
                    <span data-meta="mode">{describeMode(job.mode)}</span>
                    {job.permissionMode ? <span data-meta="permission">{describePermission(job.permissionMode)}</span> : null}
                    {workspace ? <span data-meta="workspace">{workspace}</span> : null}
                    {project ? <span data-meta="project">{project}</span> : null}
                    {thread ? <span data-meta="thread">Thread: {thread}</span> : null}
                    {job.trigger?.webhook ? <span data-meta="webhook">Webhook</span> : null}
                  </div>
                  <div className="scheduled-item-meta">
                    <span>Next {formatWhen(job.nextRunAt)}</span>
                    <span>Last {formatWhen(job.lastRunAt)}</span>
                    {job.lastStatus && <span>{describeLastStatus(job.lastStatus)}</span>}
                  </div>
                  {job.lastError && <p className="scheduled-item-error">{job.lastError}</p>}
                  {selected ? <RunHistory id={`${detailsId}-${job.id}`} job={job} /> : null}
                </div>
                <div className="scheduled-item-actions">
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Edit"
                    aria-label={`Edit ${job.name}`}
                    data-edit-job={job.id}
                    onClick={() => startEdit(job)}
                  >
                    <Pencil size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Webhook"
                    aria-label={`Webhook for ${job.name}`}
                    data-webhook-job={job.id}
                    onClick={() => setWebhookJobId(job.id)}
                  >
                    <Webhook size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Run now"
                    aria-label={`Run ${job.name} now`}
                    onClick={() => void act(() => window.mousse.scheduled.run(job.id))}
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
                  <button
                    type="button"
                    className="scheduled-icon-btn danger"
                    title="Delete"
                    aria-label={`Delete ${job.name}`}
                    onClick={() => void act(() => window.mousse.scheduled.delete(job.id))}
                  >
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
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
            focusLater(`[data-webhook-job="${webhookJob.id}"]`)
          }}
        />
      ) : null}
    </div>
  )
}

function RunHistory({ id, job }: { id: string; job: ScheduledJob }) {
  const records: ScheduledJobRunRecord[] = [...(job.runHistory ?? [])].reverse().slice(0, HISTORY_ROWS)
  return (
    <section className="scheduled-history" id={id} aria-label={`Run history for ${job.name}`}>
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
