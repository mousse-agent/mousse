import { useCallback, useEffect, useMemo, useState } from 'react'
import {
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

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: 'once-5m', label: 'Once' },
  { value: 'interval-30m', label: '30 min' },
  { value: 'interval-1h', label: 'Hourly' },
  { value: 'cron-daily', label: 'Daily 9am' }
]

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
  if (!iso) return 'none'
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
          >
            <RefreshCw size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="scheduled-btn primary"
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
            aria-label="Job name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <textarea
            className="scheduled-input scheduled-textarea"
            placeholder="Prompt"
            aria-label="Prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
          />
          <div className="scheduled-segmented">
            {PRESETS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`scheduled-segment${preset === opt.value ? ' active' : ''}`}
                onClick={() => setPreset(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="scheduled-form-actions">
            <button type="button" className="scheduled-btn ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="scheduled-btn primary"
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
          <div className="scheduled-empty">No jobs yet.</div>
        ) : (
          sortedJobs.map((job) => (
            <div key={job.id} className="scheduled-item">
              <div className="scheduled-item-main">
                <div className="scheduled-item-top">
                  <span className="scheduled-item-title">{job.name}</span>
                  <span className="scheduled-status">
                    <span className={`scheduled-dot state-${job.state}${job.state === 'running' ? ' on' : ''}`} />
                    {stateLabel(job.state)}
                  </span>
                </div>
                <p className="scheduled-item-prompt">{job.prompt}</p>
                <div className="scheduled-item-meta">
                  <span>Next {formatWhen(job.nextRunAt)}</span>
                  <span>Last {formatWhen(job.lastRunAt)}</span>
                  {job.lastStatus && <span>{job.lastStatus}</span>}
                </div>
                {job.lastError && <p className="scheduled-item-error">{job.lastError}</p>}
              </div>
              <div className="scheduled-item-actions">
                <button
                  type="button"
                  className="scheduled-icon-btn"
                  title="Run now"
                  onClick={() => void window.mousse.scheduled.run(job.id)}
                >
                  <Zap size={14} strokeWidth={2} />
                </button>
                {job.state === 'paused' ? (
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Resume"
                    onClick={() => void window.mousse.scheduled.resume(job.id)}
                  >
                    <Play size={14} strokeWidth={2} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="scheduled-icon-btn"
                    title="Pause"
                    onClick={() => void window.mousse.scheduled.pause(job.id)}
                  >
                    <Pause size={14} strokeWidth={2} />
                  </button>
                )}
                <button
                  type="button"
                  className="scheduled-icon-btn danger"
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
