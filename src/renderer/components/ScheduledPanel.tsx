import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Clock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap
} from 'lucide-react'
import type {
  CreateScheduledJobInput,
  JobSchedule,
  ScheduledJob,
  SchedulerStatus
} from '../../shared/types'
import '../styles/scheduled-panel.css'

type SchedulePreset = 'once-5m' | 'interval-30m' | 'interval-1h' | 'cron-daily'

function presetToSchedule(preset: SchedulePreset): JobSchedule {
  switch (preset) {
    case 'once-5m':
      return {
        kind: 'once',
        runAt: new Date(Date.now() + 5 * 60_000).toISOString()
      }
    case 'interval-30m':
      return { kind: 'interval', minutes: 30 }
    case 'interval-1h':
      return { kind: 'interval', minutes: 60 }
    case 'cron-daily':
      return { kind: 'cron', expr: '0 9 * * *' }
  }
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function stateLabel(state: ScheduledJob['state']): string {
  switch (state) {
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

export function ScheduledPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<SchedulePreset>('interval-30m')
  const [busy, setBusy] = useState(false)

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
    const offUpdated = window.mousse.scheduled.onUpdated(setJobs)
    const offStatus = window.mousse.scheduled.onStatus(setStatus)
    return () => {
      offUpdated()
      offStatus()
    }
  }, [refresh])

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER
        const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER
        return aTime - bTime
      }),
    [jobs]
  )

  const submitCreate = async () => {
    if (!prompt.trim()) return
    setBusy(true)
    try {
      const input: CreateScheduledJobInput = {
        name: name.trim() || 'Scheduled job',
        prompt: prompt.trim(),
        schedule: presetToSchedule(preset),
        createThread: true
      }
      await window.mousse.scheduled.create(input)
      setShowForm(false)
      setName('')
      setPrompt('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scheduled-panel">
      <div className="scheduled-panel-header">
        <p className="scheduled-panel-subtitle">
          {status?.running ? 'Scheduler running' : 'Scheduler stopped'}
          {status ? ` · ${status.jobCount} jobs · ${status.dueCount} due` : ''}
        </p>
        <div className="scheduled-panel-header-actions">
          <button type="button" className="scheduled-panel-btn" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="scheduled-panel-btn scheduled-panel-btn-primary"
            onClick={() => setShowForm((open) => !open)}
          >
            <Plus size={14} strokeWidth={2} />
            New job
          </button>
        </div>
      </div>

      {showForm && (
        <div className="scheduled-form">
          <input
            className="scheduled-input"
            placeholder="Job name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <textarea
            className="scheduled-textarea"
            placeholder="Prompt to run on schedule…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
          />
          <select
            className="scheduled-input"
            value={preset}
            onChange={(event) => setPreset(event.target.value as SchedulePreset)}
          >
            <option value="once-5m">Once in 5 minutes</option>
            <option value="interval-30m">Every 30 minutes</option>
            <option value="interval-1h">Every hour</option>
            <option value="cron-daily">Daily at 9:00 AM</option>
          </select>
          <div className="scheduled-form-actions">
            <button type="button" className="scheduled-panel-btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="scheduled-panel-btn scheduled-panel-btn-primary"
              disabled={busy || !prompt.trim()}
              onClick={() => void submitCreate()}
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div className="scheduled-list">
        {sortedJobs.length === 0 ? (
          <div className="scheduled-empty">No scheduled jobs yet</div>
        ) : (
          sortedJobs.map((job) => (
            <div key={job.id} className={`scheduled-card state-${job.state}`}>
              <div className="scheduled-card-main">
                <div className="scheduled-card-title-row">
                  <Clock size={14} strokeWidth={2} className="scheduled-card-icon" />
                  <span className="scheduled-card-title">{job.name}</span>
                  <span className={`scheduled-state-badge state-${job.state}`}>
                    {stateLabel(job.state)}
                  </span>
                </div>
                <p className="scheduled-card-prompt">{job.prompt}</p>
                <div className="scheduled-card-meta">
                  <span>Next: {formatWhen(job.nextRunAt)}</span>
                  <span>Last: {formatWhen(job.lastRunAt)}</span>
                  {job.lastStatus && <span>Status: {job.lastStatus}</span>}
                </div>
                {job.lastError && <div className="scheduled-card-error">{job.lastError}</div>}
              </div>
              <div className="scheduled-card-actions">
                <button
                  type="button"
                  className="scheduled-panel-btn"
                  title="Run now"
                  onClick={() => void window.mousse.scheduled.run(job.id)}
                >
                  <Zap size={14} strokeWidth={2} />
                </button>
                {job.state === 'paused' ? (
                  <button
                    type="button"
                    className="scheduled-panel-btn"
                    title="Resume"
                    onClick={() => void window.mousse.scheduled.resume(job.id)}
                  >
                    <Play size={14} strokeWidth={2} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="scheduled-panel-btn"
                    title="Pause"
                    onClick={() => void window.mousse.scheduled.pause(job.id)}
                  >
                    <Pause size={14} strokeWidth={2} />
                  </button>
                )}
                <button
                  type="button"
                  className="scheduled-panel-btn scheduled-panel-btn-danger"
                  title="Delete"
                  onClick={() => void window.mousse.scheduled.delete(job.id)}
                >
                  <Trash2 size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
