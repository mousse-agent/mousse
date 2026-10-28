import type { InstanceTelemetry } from '../../shared/harness/status'
import type { TelemetrySetting } from '../../shared/harness/types'
import { COMPATIBILITY, type CompatibilityKey } from './compatibility'
import type { DriverContext, HarnessDriver, InstanceConfig, TelemetryLaunch } from './driver'

/**
 * Each entry's agent telemetry (Settings → Providers, `InstanceConfig.telemetry`). Mousse applies it
 * only through what it adds to the processes it starts (`HarnessDriver.telemetryOff`, set last); it
 * never edits an agent's files or home. An agent that documents no switch gets nothing.
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

/** The setting an entry has until the user picks one: Off where Mousse set the agent up, the agent's own setting on the user's own setup. */
export function telemetryDefault(driver: Pick<HarnessDriver, 'kind'>, config: InstanceConfig, home: string | undefined): TelemetrySetting {
  return ownsSetup(driver, config, home) ? 'off' : 'agent_setting'
}

/** The driver's documented switch, when it has one that sets anything. */
export function telemetrySwitch(driver: Pick<HarnessDriver, 'telemetryOff'>, config: InstanceConfig): TelemetryLaunch | undefined {
  const launch = driver.telemetryOff?.(config)
  return launch && (Object.keys(launch.env ?? {}).length || launch.args?.length) ? launch : undefined
}

/** What every process of the entry gets last (`InstanceEnv.enforced`, `enforcedArgs`); none unless its telemetry is off. */
export function telemetryEnforced(
  driver: Pick<HarnessDriver, 'kind' | 'telemetryOff'>,
  config: InstanceConfig,
  home: string | undefined
): TelemetryLaunch | undefined {
  const launch = telemetrySwitch(driver, config)
  if (!launch || (config.telemetry ?? telemetryDefault(driver, config, home)) !== 'off') return undefined
  return launch
}

/** What the snapshot says about the entry's telemetry. */
export function telemetryView(
  driver: Pick<HarnessDriver, 'kind' | 'telemetryOff' | 'telemetryDocs'>,
  config: InstanceConfig,
  home: string | undefined
): InstanceTelemetry {
  const docs = driver.telemetryDocs ? { docsUrl: driver.telemetryDocs } : {}
  const launch = telemetrySwitch(driver, config)
  if (!launch) return { setting: 'none', ...docs }
  const defaultSetting = telemetryDefault(driver, config, home)
  return {
    setting: config.telemetry ?? defaultSetting,
    defaultSetting,
    ...(launch.env && Object.keys(launch.env).length ? { variables: Object.keys(launch.env) } : {}),
    ...(launch.args?.length ? { args: [...launch.args] } : {}),
    ...docs
  }
}

/** The entry's telemetry switch from its instance environment (`InstanceEnv.enforced`, `enforcedArgs`), for a service that starts its own processes. */
export function telemetryOf(context: Pick<DriverContext, 'env'>): TelemetryLaunch {
  return { ...(context.env.enforced ? { env: context.env.enforced } : {}), ...(context.env.enforcedArgs ? { args: context.env.enforcedArgs } : {}) }
}
