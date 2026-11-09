import { useEffect, useState } from 'react'
import type { ScheduledSettings, ScheduledSettingsUpdate } from '../../../shared/types'
import { AgentJobLimitFields } from './AgentJobLimitFields'
import { MoreDetails, SettingsRow } from './SettingsRow'

export const AGENT_AUTOMATIONS_HELP =
  "The first time an agent adds an automation, you are asked in Automations, Needs you: Allow adds it and lets that thread add more within these limits; Not now drops it. Automations agents add run no wider than that agent and end after the days below unless you Keep them."

/**
 * Settings → Agent access: the limits on the automations agents add. Whether an agent may add them at all is asked the
 * first time it tries (Allow / Not now in Needs you), so there is no switch.
 */
export function AgentAutomationsSettings() {
  const [settings, setSettings] = useState<ScheduledSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // A window without the scheduler bridge (a test, an older preload) shows the rows without values.
    window.mousse?.scheduled?.settings?.get?.().then((value) => { if (live) setSettings(value) }, () => undefined)
    return () => { live = false }
  }, [])

  const save = async (update: ScheduledSettingsUpdate) => {
    setError(null)
    try {
      setSettings(await window.mousse.scheduled.settings.set(update))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <SettingsRow
        title="Automations agents add"
        anchor="agents-automations"
        description={<>
          You are asked the first time.
          <MoreDetails>{AGENT_AUTOMATIONS_HELP}</MoreDetails>
        </>}
      />
      <AgentJobLimitFields settings={settings} save={save} />
      {error ? <p className="agent-job-limit-error" role="alert">{error}</p> : null}
    </>
  )
}
