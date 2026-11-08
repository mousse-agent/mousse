import { useEffect, useState } from 'react'
import type { ScheduledSettings, ScheduledSettingsUpdate } from '../../../shared/types'
import { AgentJobLimitFields } from './AgentJobLimitFields'
import { MoreDetails, SettingsRow, Switch } from './SettingsRow'

export const AGENT_AUTOMATIONS_HELP =
  "Agents can add, change, pause and run their own automations through Mousse's tools, from a turn you started. It also needs the Manage level above. Automations agents add run no wider than that agent, end after the days below unless you extend them, and are paused when you turn this off (you resume them)."

/**
 * Settings → Agent access: whether agents may add automations, and the limits on the ones they add. It moved here
 * from the Automations page unchanged; a later step replaces the switch with an ask the first time an agent adds one.
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
        title="Agents may add automations"
        anchor="agents-automations"
        htmlFor="agent-access-automations"
        description={<>
          Off by default. Automations they add run no wider than the agent.
          <MoreDetails>{AGENT_AUTOMATIONS_HELP}</MoreDetails>
        </>}
        control={
          <Switch
            id="agent-access-automations"
            label="Agents may add automations"
            checked={settings?.agentJobs === true}
            disabled={settings === null}
            onChange={(next) => void save({ agentJobs: next })}
          />
        }
      />
      <AgentJobLimitFields settings={settings} save={save} />
      {error ? <p className="agent-job-limit-error" role="alert">{error}</p> : null}
    </>
  )
}
