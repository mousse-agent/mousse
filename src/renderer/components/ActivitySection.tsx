import { useEffect, useState } from 'react'
import type { LineEditStatsSnapshot, UsageStatsSnapshot } from '../../shared/lineEditStats'
import { LineEditHeatmap } from './LineEditHeatmap'
import { SettingsGroup } from './settings/SettingsRow'
import { Activity } from '../lib/icons'

/** Activity heatmap and token usage, shown on the Account page. */
export function ActivitySection() {
  const [stats, setStats] = useState<LineEditStatsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageStatsSnapshot | null>(null)

  useEffect(() => {
    void window.mousse.lineEdits.getStats().then(setStats)
    return window.mousse.lineEdits.onUpdated(setStats)
  }, [])

  useEffect(() => { void window.mousse.usageStats.getStats().then(setUsage) }, [])

  if (!stats) {
    return (
      <SettingsGroup title="Activity" icon={Activity}>
        <p className="settings-muted activity-loading">Loading activity…</p>
      </SettingsGroup>
    )
  }
  return <LineEditHeatmap stats={stats} usage={usage} />
}
