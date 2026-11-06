import { useEffect, useState } from 'react'
import type { LineEditStatsSnapshot, UsageStatsSnapshot } from '../../shared/lineEditStats'
import { LineEditHeatmap } from './LineEditHeatmap'

/** Activity heatmap and token usage, shown on the Account page. */
export function ActivitySection() {
  const [stats, setStats] = useState<LineEditStatsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageStatsSnapshot | null>(null)
  const [usageFailed, setUsageFailed] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    void window.mousse.lineEdits.getStats().then(setStats, (error) => {
      console.error('Loading activity failed', error)
      setLoadFailed(true)
    })
    return window.mousse.lineEdits.onUpdated((next) => {
      setLoadFailed(false)
      setStats(next)
    })
  }, [])

  useEffect(() => {
    void window.mousse.usageStats.getStats().then(setUsage, (error) => {
      console.error('Loading token usage failed', error)
      setUsageFailed(true)
    })
  }, [])

  // Edit history and token usage load on their own; neither waits for, or hides behind, the other.
  return <LineEditHeatmap stats={stats} statsFailed={loadFailed} usage={usage} usageFailed={usageFailed} />
}
