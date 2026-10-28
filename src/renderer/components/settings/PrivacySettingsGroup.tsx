import type { InstanceSnapshot, InstanceTelemetry } from '../../../shared/harness/status'
import { contactedServices } from '../../../shared/privacy/outbound'
import type { AgentTelemetrySetting, MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { Lock } from '../../lib/icons'
import { DEVICE_SCOPE, useProviderSnapshots } from '../../lib/providerSnapshots'
import { openExternalUrl } from '../PullRequestMarkdown'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export const PRIVACY_STATEMENT = 'Mousse itself collects no usage data about you or your chats. Your chats go only to the providers you set up.'

export const AGENT_TELEMETRY_TITLE = 'Agent telemetry for agents Mousse sets up'

const TELEMETRY_OPTIONS: Array<{ value: AgentTelemetrySetting; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'agent_default', label: 'Agent default' }
]

/** One provider's line under the switch: what its agent's telemetry is, and why. */
export function telemetryLine(telemetry: InstanceTelemetry): string {
  switch (telemetry.state) {
    case 'off': return `Off: Mousse sets ${(telemetry.variables ?? []).join(', ')}.`
    case 'agent_default': return `As ${telemetry.agent} does by default: Mousse sets nothing.`
    case 'own_settings': return `Uses your own ${telemetry.agent} settings.`
    case 'no_switch': return `No documented switch: ${telemetry.agent} runs as it does by default.`
  }
}

/** Settings → General → Privacy: what Mousse contacts, and the telemetry of the agents it sets up. */
export function PrivacySettingsGroup({ privacy, onUpdate }: { privacy: MousseSettings['privacy']; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  const listed = (snapshots ?? []).filter((snapshot): snapshot is InstanceSnapshot & { telemetry: InstanceTelemetry } => Boolean(snapshot.telemetry))
  return (
    <SettingsGroup title="Privacy" icon={Lock}>
      <SettingsRow title="Usage data" description={PRIVACY_STATEMENT}>
        <ul className="privacy-list">
          {contactedServices().map((service) => (
            <li key={service.label}>
              <span className="privacy-list-name">{service.label}</span>
              <span className="privacy-list-detail">{service.when} Sends: {service.sends}</span>
            </li>
          ))}
        </ul>
      </SettingsRow>
      <SettingsRow
        title={AGENT_TELEMETRY_TITLE}
        description="Off turns the agent's own usage and error reports off where Mousse set the agent up (a home of its own, an agent Mousse installed, the Mousse agent) and the agent documents how. Agents on your own setup always run as you set them up. A change applies from each agent's next start."
        control={
          <Select
            ariaLabel={AGENT_TELEMETRY_TITLE}
            value={privacy.agentTelemetry}
            onChange={(agentTelemetry) => { if (agentTelemetry !== privacy.agentTelemetry) void onUpdate({ privacy: { agentTelemetry } }) }}
            options={TELEMETRY_OPTIONS}
          />
        }
      >
        {listed.length > 0 && (
          <ul className="privacy-list">
            {listed.map((snapshot) => (
              <li key={snapshot.instanceId}>
                <span className="privacy-list-name">{snapshot.displayName}</span>
                <span className="privacy-list-detail">
                  {telemetryLine(snapshot.telemetry)}
                  {snapshot.telemetry.docsUrl && snapshot.telemetry.state !== 'off' && (
                    <>
                      {' '}
                      <button type="button" className="privacy-link" onClick={() => openExternalUrl(snapshot.telemetry.docsUrl!)}>What it collects</button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
