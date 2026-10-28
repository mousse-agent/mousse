import type { InstanceTelemetry } from '../../shared/harness/status'
import type { AgentTelemetrySetting } from '../../shared/settings'
import { COMPATIBILITY, type CompatibilityKey } from './compatibility'
import type { HarnessDriver, InstanceConfig } from './driver'

/**
 * The agent-telemetry switch (Settings → General → Privacy, `privacy.agentTelemetry`). It applies
 * only where Mousse owns the setup, and there only through each driver's documented switch
 * (`HarnessDriver.telemetryEnv`). An agent on the user's own setup runs exactly as they set it up.
 */

/**
 * Whether Mousse set the instance up itself: it runs in a home of its own, on a runtime Mousse ships
 * (its compatibility row is `bundled`), or on an agent Mousse installed with no executable of the
 * user's in its place.
 */
export function ownsSetup(driver: Pick<HarnessDriver, 'kind'>, config: InstanceConfig, home: string | undefined): boolean {
  if (home) return true
  if (COMPATIBILITY[driver.kind as CompatibilityKey]?.bundled) return true
  return !config.binaryPath && (config.setup === 'managed' || config.source?.kind === 'registry')
}

/** The variables set last on every process of the instance (`InstanceEnv.enforced`); none unless Mousse owns the setup and the setting is `off`. */
export function telemetryEnforced(
  driver: Pick<HarnessDriver, 'kind' | 'telemetryEnv'>,
  config: InstanceConfig,
  home: string | undefined,
  setting: AgentTelemetrySetting
): Record<string, string> | undefined {
  if (setting !== 'off' || !driver.telemetryEnv || !ownsSetup(driver, config, home)) return undefined
  const env = driver.telemetryEnv(config)
  return Object.keys(env).length ? { ...env } : undefined
}

/** What the snapshot says about the instance's telemetry. */
export function telemetryView(
  driver: Pick<HarnessDriver, 'kind' | 'label' | 'telemetryEnv' | 'telemetryDocs'>,
  config: InstanceConfig,
  home: string | undefined,
  setting: AgentTelemetrySetting
): InstanceTelemetry {
  const shown = { agent: driver.label, ...(driver.telemetryDocs ? { docsUrl: driver.telemetryDocs } : {}) }
  const variables = driver.telemetryEnv ? Object.keys(driver.telemetryEnv(config)) : []
  if (!variables.length) return { state: 'no_switch', ...shown }
  if (!ownsSetup(driver, config, home)) return { state: 'own_settings', ...shown }
  return setting === 'off' ? { state: 'off', variables, ...shown } : { state: 'agent_default', ...shown }
}
