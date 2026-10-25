import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessCaps } from '../../../shared/harness/types'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver } from '../../harness/driver'
import { createHarnessGateway, type Harness, type HarnessGatewayOptions } from '../../harness/gateway'
import { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../providers/ProviderInstanceService'
import type { ProviderAdapter } from '../adapters/ProviderAdapter'

/**
 * Test drivers over a plain `ProviderAdapter` (scripted, fake or replay adapters), so run-engine
 * tests drive the orchestrator through the real gateway. Capabilities are the adapter's own plus
 * the gateway's two, derived the way the PR 1 drivers derive them.
 */
export function adapterDriver(adapter: ProviderAdapter, extra: Partial<HarnessCaps> & { runtime?: Partial<DriverRuntime> } = {}): HarnessDriver {
  const { runtime, ...caps } = extra
  const contextUsage: HarnessCaps['contextUsage'] = adapter.describe ? adapter.describe('').contextUsage : 'measured'
  return {
    kind: adapter.driver,
    label: `Test ${adapter.driver}`,
    binaryNames: [],
    multiInstance: false,
    privateHome: false,
    canInstall: false,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => ({ ...adapter.capabilities, planMode: true, contextUsage, ...caps }),
    create: () => ({
      adapter,
      configured: () => adapter.configured?.() ?? false,
      models: () => [],
      auth: async () => ({ state: 'unknown' }),
      stop: () => {},
      ...runtime
    })
  }
}

/** A gateway for tests: adapters (and drivers) over an instance map, no login-shell capture. */
export function testHarness(options: {
  adapters?: ProviderAdapter[]
  drivers?: HarnessDriver[]
  instances?: ProviderInstanceService
  profileHome?: string
} & Partial<Omit<HarnessGatewayOptions, 'drivers' | 'instanceMap'>> = {}): Harness {
  const { adapters = [], drivers = [], instances, profileHome, ...rest } = options
  const home = profileHome ?? mkdtempSync(join(tmpdir(), 'mousse-harness-'))
  return createHarnessGateway({
    profileHome: home,
    installationHome: home,
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    ...rest,
    instanceMap: instances ?? new ProviderInstanceService(),
    drivers: [...adapters.map((adapter) => adapterDriver(adapter)), ...drivers]
  })
}
