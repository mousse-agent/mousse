import { useEffect, useState } from 'react'
import type { LineEditStatsSnapshot, UsageStatsSnapshot } from '../../shared/lineEditStats'
import { LineEditHeatmap } from './LineEditHeatmap'
import { SettingsGroup } from './settings/SettingsRow'
import { Activity } from '../lib/icons'

/** Activity heatmap and token usage, shown on the Activity page. */
export function ActivitySection() {
  const [stats, setStats] = useState<LineEditStatsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageStatsSnapshot | null>(null)
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
    void window.mousse.usageStats.getStats().then(setUsage, (error) => console.error('Loading token usage failed', error))
  }, [])

  if (!stats) {
    return (
      <SettingsGroup title="Activity" icon={Activity}>
        <p className="settings-muted activity-loading">{loadFailed ? 'Couldn’t load activity.' : 'Loading activity…'}</p>
      </SettingsGroup>
    )
  }
  return <LineEditHeatmap stats={stats} usage={usage} />
}
