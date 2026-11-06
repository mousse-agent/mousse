import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { normalizePermissionMode } from '../../shared/permissionMode'
import type { LlmProviderOption } from '../../shared/settings'
import { AGENT_JOB_LIMIT_DEFAULTS } from '../../shared/agentJobLimits'
import type { CreateScheduledJobInput, ScheduledJob, ScheduledSettings, ScheduledSettingsUpdate, SchedulerStatus } from '../../shared/types'
import { AgentJobLimitFields } from './scheduled/AgentJobLimitFields'
import { JobEditor } from './scheduled/JobEditor'
import { JobRow, type PrimaryControl } from './scheduled/JobRow'
import { QuickAdd } from './scheduled/QuickAdd'
import { doneCount, groupJobs } from './scheduled/groupJobs'
import { RowMenu, type RowMenuItem } from './integrations/RowMenu'
import { SettingsAdvanced, Switch } from './settings/SettingsRow'
import { Modal } from './ui/Modal'
import {
  createInputOf,
  draftFromJob,
  EMPTY_CATALOG,
  isUnchanged,
  modelGroups,
  patchOf,
  type JobDraft,
  type ScheduledCatalog
} from './scheduled/jobDraft'
import {
  describeRunProgress,
  describeSchedule,
  errorText,
  isToday,
  newestRecord,
  relativeDay,
  relativeWhen,
  statusOf
} from './scheduled/scheduledLabels'
import { WebhookDialog, type WebhookApi } from './scheduled/WebhookDialog'
import { openThread } from '../lib/openThread'
import '../styles/scheduled-panel.css'

/** Which record was newest when Run now was pressed: a different newest one is that run's. */
function newestRecordKey(job: ScheduledJob): string | null {
  const last = newestRecord(job)
  return last ? `${last.runAt}|${last.runId ?? ''}|${job.runHistory!.length}` : null
}

/** A Run now press being followed: the row's line says "Starting…" until the run shows, and a status region reads it out. */
interface RunWatch {
  jobId: string
  before: string | null
}

/** The thread where the task's current occurrence runs, else where its last recorded run ran. */
function runThreadId(job: ScheduledJob): string | undefined {
  return job.liveThreadId ?? job.pendingOccurrence?.threadId ?? [...(job.runHistory ?? [])].reverse().find((record) => record.threadId)?.threadId
}

const isLive = (job: ScheduledJob) => Boolean(job.liveStatus || job.state === 'running' || job.pendingOccurrence)

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

interface OpenTask {
  id: string
  initial: JobDraft
}

const AGENTS_HELP =
  "Lets agents add, change, pause and run their own scheduled tasks through Mousse's tools, from a turn you started. It also needs the Manage agent access level. Tasks agents add run no wider than that agent, end after the time set here unless you extend them, and are paused when you turn this off (you resume them)."

export function ScheduledPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [catalog, setCatalog] = useState<ScheduledCatalog>(EMPTY_CATALOG)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  /** A new task opened from Custom… in the quick-add line. */
  const [creating, setCreating] = useState<JobDraft | null>(null)
  /** The open row: its editor shows under it. */
  const [openTask, setOpenTask] = useState<OpenTask | null>(null)
  const [webhookJobId, setWebhookJobId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  /** Bumped when a task from Custom… is added, so the quick-add line lets go of its text. */
  const [quickCleared, setQuickCleared] = useState(0)
  /** `scheduled.agentJobs` and the limits on the tasks agents add; null until the profile has answered. */
  const [settings, setSettings] = useState<ScheduledSettings | null>(null)
  const agentJobs = settings ? settings.agentJobs : null
  /** What "Extend" gives a task: the lifetime of tasks agents add (the default until the profile has answered). */
  const extendDays = settings?.agentJobLifetimeDays ?? AGENT_JOB_LIMIT_DEFAULTS.lifetimeDays
  const [actionError, setActionError] = useState<string | null>(null)
  /** The scheduler could not be asked how it is: shown as not answering rather than as stopped. */
  const [unavailable, setUnavailable] = useState(false)
  const [runWatch, setRunWatch] = useState<RunWatch | null>(null)
  const [deleting, setDeleting] = useState<ScheduledJob | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const quickInput = useRef<HTMLInputElement>(null)
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
        // A task made without a thread is made in the mode threads start in; it is also the most the task may run with.
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

  const groups = useMemo(() => groupJobs(jobs, { showDone }), [jobs, showDone])
  const done = useMemo(() => doneCount(jobs), [jobs])
  const ordered = useMemo(() => groups.flatMap((group) => group.jobs), [groups])

  const webhookJob = webhookJobId ? jobs.find((job) => job.id === webhookJobId) : undefined
  // A task deleted while its webhook dialog is open closes the dialog (and with it the secret).
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

  const openRow = (job: ScheduledJob) => {
    setCreating(null)
    setOpenTask({ id: job.id, initial: draftFromJob(job, catalog, providers) })
    void loadCatalog()
  }

  /** The row's "…" button, where Edit, Webhook and Delete live: focus goes back there when they finish. */
  const moreButton = (jobId: string) => `[data-job-id="${jobId}"] .row-menu-btn`

  const closeRow = (jobId: string) => {
    setOpenTask(null)
    focusLater(moreButton(jobId))
  }

  const toggleRow = (job: ScheduledJob) => {
    if (openTask?.id === job.id) setOpenTask(null)
    else openRow(job)
  }

  /** Closes the new task's editor. Cancel leaves what was typed in the quick-add line; adding the task clears it. */
  const closeCreate = (added: boolean) => {
    setCreating(null)
    if (added) setQuickCleared((count) => count + 1)
    requestAnimationFrame(() => quickInput.current?.focus())
  }

  const create = async (input: CreateScheduledJobInput) => {
    await window.mousse.scheduled.create(input)
    await refresh()
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
    // The task's own update normally arrives first; asking again covers a missed one.
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
    // Focus moves on to the row below, else the row above, else the quick-add line.
    const order = ordered.map((item) => item.id)
    const index = order.indexOf(jobId)
    const neighbour = index === -1 ? undefined : order[index + 1] ?? order[index - 1]
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
    if (openTask?.id === jobId) setOpenTask(null)
    if (runWatch?.jobId === jobId) setRunWatch(null)
    setJobs((current) => current.filter((item) => item.id !== jobId))
    if (neighbour) focusLater(`[data-job-id="${neighbour}"] [data-row-button]`)
    else requestAnimationFrame(() => quickInput.current?.focus())
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

  const nameOfProject = (projectId: string) => catalog.projects.find((project) => project.id === projectId)?.name

  const schedulerState = unavailable ? 'unavailable' : status === null ? 'loading' : status.running ? 'running' : 'stopped'
  const watchedJob = runWatch ? jobs.find((item) => item.id === runWatch.jobId) : undefined
  const watchedRecord = watchedJob && newestRecordKey(watchedJob) !== runWatch?.before ? newestRecord(watchedJob) : undefined
  const runProgress = watchedJob ? describeRunProgress(watchedJob.name, watchedRecord, watchedJob.liveStatus) : null

  const rowOf = (job: ScheduledJob) => {
    const now = new Date()
    const starting = runWatch?.jobId === job.id && !watchedRecord && !isLive(job)
    const status = statusOf(job, now, starting)
    const project = job.projectId ? nameOfProject(job.projectId) : undefined
    const thread = runThreadId(job)
    // "Open thread" on the line while the run is live or ran today; older threads are under "…".
    const lastRun = newestRecord(job)?.runAt ?? job.lastRunAt
    const lineThread = thread && (isLive(job) || isToday(lastRun, now)) ? thread : undefined
    const live = isLive(job)
    const before = [
      ...(project ? [{ key: 'project', text: project }] : []),
      { key: 'schedule', text: describeSchedule(job.schedule, now), title: job.schedule.kind === 'cron' ? job.schedule.expr : undefined },
      ...(job.trigger?.webhook ? [{ key: 'webhook', text: 'Webhook on' }] : [])
    ]
    const after = [
      // A one-time task's schedule already says when it runs.
      ...(job.nextRunAt && job.schedule.kind !== 'once' && job.state !== 'paused' && job.state !== 'completed' && !live ? [{ key: 'next', text: `Next ${relativeWhen(job.nextRunAt, now)}` }] : []),
      ...(job.createdBy ? [{ key: 'agent', text: job.expiresAt ? `Added by an agent, ${job.state === 'completed' && new Date(job.expiresAt).getTime() <= now.getTime() ? 'ended' : 'ends'} ${relativeDay(job.expiresAt, now)}` : 'Added by an agent' }] : [])
    ]
    // One control: Resume when paused, the run's thread while it runs or waits for an answer, else Run now.
    const primary: PrimaryControl = job.state === 'paused'
      ? { kind: 'resume', onPress: () => void act(() => window.mousse.scheduled.resume(job.id)) }
      : live && thread
        ? { kind: 'thread', onPress: () => void openThread(thread) }
        : { kind: 'run', onPress: () => void runNow(job) }
    const menu: RowMenuItem[] = [
      ...(primary.kind !== 'run' ? [{ label: 'Run now', disabled: live, onSelect: () => void runNow(job) }] : []),
      ...(job.state !== 'paused' ? [{ label: 'Pause', onSelect: () => void act(() => window.mousse.scheduled.pause(job.id)) }] : []),
      { label: 'Edit', onSelect: () => openRow(job) },
      ...(thread && primary.kind !== 'thread' ? [{ label: 'Open last thread', onSelect: () => void openThread(thread) }] : []),
      { label: 'Webhook', onSelect: () => setWebhookJobId(job.id) },
      { label: 'Delete', danger: true, onSelect: () => askDelete(job) }
    ]
    const open = openTask?.id === job.id
    return (
      <JobRow
        key={job.id}
        job={job}
        open={open}
        detailsId={`${detailsId}-${job.id}`}
        status={status}
        segments={{ before, after }}
        threadId={lineThread}
        primary={primary}
        menu={menu}
        onToggle={() => toggleRow(job)}
        onOpenThread={(id) => void openThread(id)}
        onRowKeyDown={moveBetweenRows}
      >
        {open && openTask ? (
          <JobEditor
            job={job}
            initial={openTask.initial}
            catalog={catalog}
            extendDays={extendDays}
            onExtend={() => void act(() => window.mousse.scheduled.extend(job.id))}
            onWebhook={() => setWebhookJobId(job.id)}
            onOpenThread={(id) => void openThread(id)}
            onCancel={() => closeRow(job.id)}
            save={async (draft) => {
              const patch = patchOf(openTask.initial, draft, catalog)
              if (!isUnchanged(patch)) await window.mousse.scheduled.update(job.id, patch)
              closeRow(job.id)
              await refresh()
            }}
          />
        ) : null}
      </JobRow>
    )
  }

  const pageMenu = (
    <RowMenu
      label="Scheduled page actions"
      items={[
        showDone
          ? { label: 'Hide done', onSelect: () => setShowDone(false) }
          : { label: done > 0 ? `Show done (${done})` : 'Show done', disabled: done === 0, onSelect: () => setShowDone(true) }
      ]}
    />
  )

  return (
    <div className="scheduled-panel">
      <div className="scheduled-scroll">
        <div className="scheduled-column" ref={listRef}>
          <QuickAdd
            ref={quickInput}
            catalog={catalog}
            isGitRepo={async (projectId) => (await window.mousse.git.status({ projectId, workspaceThreadId: null })).isRepo}
            create={create}
            openCustom={(draft) => { setOpenTask(null); setCreating(draft); void loadCatalog() }}
            editing={creating !== null}
            cleared={quickCleared}
            menu={pageMenu}
          />

          {schedulerState === 'stopped' || schedulerState === 'unavailable' ? (
            <p className="scheduled-warning" data-testid="scheduler-state">
              <span className="settings-status-warn">
                {schedulerState === 'stopped' ? 'Scheduler stopped. Nothing will run.' : 'Scheduler did not answer.'}
              </span>
              <button type="button" className="scheduled-line-link" onClick={() => void refresh()}>Refresh</button>
            </p>
          ) : null}

          {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}
          <div className="scheduled-sr-only" role="status" aria-live="polite" data-testid="run-progress">
            {runProgress?.text ?? ''}
          </div>

          {creating ? (
            <section className="scheduled-group" aria-label="New task">
              <div className="scheduled-rows scheduled-new">
                <JobEditor
                  initial={creating}
                  catalog={catalog}
                  startCustom
                  onCancel={() => closeCreate(false)}
                  save={async (draft) => {
                    await window.mousse.scheduled.create(createInputOf(draft, catalog))
                    closeCreate(true)
                    await refresh()
                  }}
                />
              </div>
            </section>
          ) : null}

          {groups.map((group) => (
            <section key={group.key} className="scheduled-group" aria-labelledby={`${detailsId}-group-${group.key}`} data-group={group.key}>
              <h2 className="scheduled-group-head" id={`${detailsId}-group-${group.key}`}>{group.label}</h2>
              <div className="scheduled-rows">{group.jobs.map(rowOf)}</div>
            </section>
          ))}

          {jobs.length === 0 && !creating ? (
            <p className="scheduled-empty">Nothing scheduled yet. Type what the agent should do, then pick when.</p>
          ) : groups.length === 0 && !creating ? (
            <p className="scheduled-empty">Nothing left to run.</p>
          ) : null}

          <div className="scheduled-settings">
            <SettingsAdvanced label={`Agents may add tasks · ${agentJobs === true ? 'On' : agentJobs === false ? 'Off' : '…'}`}>
              <div className="scheduled-rows scheduled-settings-rows">
                <div className="settings-item" title={AGENTS_HELP}>
                  <div className="settings-item-text">
                    <label className="settings-item-title" htmlFor={agentToggleId}>Agents may add tasks</label>
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
              </div>
            </SettingsAdvanced>
          </div>
        </div>
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
