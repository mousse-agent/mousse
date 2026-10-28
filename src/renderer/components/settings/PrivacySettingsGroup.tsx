import { contactedServices } from '../../../shared/privacy/outbound'
import { Lock } from '../../lib/icons'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export const PRIVACY_STATEMENT = 'Mousse itself collects no usage data about you or your chats. Your chats go only to the providers you set up.'

/** Settings → General → Privacy: what Mousse contacts, and where each agent's telemetry is set. */
export function PrivacySettingsGroup() {
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
      <SettingsRow title="Agent telemetry" description="Set for each provider in Settings → Providers." />
    </SettingsGroup>
  )
}
