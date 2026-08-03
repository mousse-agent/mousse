import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react'
import { formatWorkedFor, formatWorkingFor } from '../utils/responseTimeline'

interface ResponseWorkProps {
  active: boolean
  startedAt?: string | null
  durationMs?: number
  children: ReactNode
}

export function ResponseWork({ active, startedAt, durationMs = 0, children }: ResponseWorkProps) {
  const [open, setOpen] = useState(active)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) {
      setOpen(false)
      return
    }
    setOpen(true)
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  const parsedStart = startedAt ? Date.parse(startedAt) : Number.NaN
  const elapsedMs = Number.isFinite(parsedStart) ? Math.max(0, now - parsedStart) : 0
  const label = active ? formatWorkingFor(elapsedMs) : formatWorkedFor(durationMs)

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!active) setOpen(event.currentTarget.open)
  }

  return (
    <details
      className={`response-work${active ? ' response-work-active' : ''}`}
      open={active || open}
      onToggle={handleToggle}
    >
      <summary>
        {active && <span className="response-work-status" aria-hidden="true" />}
        <span>{label}</span>
      </summary>
      <div className="response-work-content">{children}</div>
    </details>
  )
}
