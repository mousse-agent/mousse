import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessCaps } from '../../../shared/harness/types'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver } from '../../harness/driver'
import { createHarnessGateway, type Harness, type HarnessGatewayOptions } from '../../harness/gateway'
import { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../providers/ProviderInstanceService'
import type { ProviderAdapter } from '../adapters/ProviderAdapter'
import type { McpTurnBinding } from '../mcp/appTools/registry'

/** The turn binding each real driver declares (`harness/drivers/*`), for test drivers of the same kind. */
const TURN_BINDINGS: Partial<Record<ProviderAdapter['driver'], McpTurnBinding>> = { claude: 'per_call', codex: 'drained_turn', antigravity: 'drained_turn', acp: 'drained_turn', pi: 'per_call' }

/**
 * Test drivers over a plain `ProviderAdapter` (scripted, fake or replay adapters), so run-engine
 * tests drive the orchestrator through the real gateway. Capabilities are the adapter's own plus
 * the gateway's three, derived the way the drivers derive them.
 */
export function adapterDriver(adapter: ProviderAdapter, extra: Partial<HarnessCaps> & { runtime?: Partial<DriverRuntime>; mcpTurnBinding?: McpTurnBinding } = {}): HarnessDriver {
  const { runtime, mcpTurnBinding, ...caps } = extra
  const contextUsage: HarnessCaps['contextUsage'] = adapter.describe ? adapter.describe('').contextUsage : 'measured'
  return {
    kind: adapter.driver,
    label: `Test ${adapter.driver}`,
    binaryNames: [],
    multiInstance: false,
    privateHome: false,
    canInstall: false,
    customModels: true,
    mcpTurnBinding: mcpTurnBinding ?? TURN_BINDINGS[adapter.driver],
    // As the real Claude Code and Codex drivers declare.
    mcpImageResults: adapter.driver === 'claude' || adapter.driver === 'codex',
    // As the real pi driver declares: its models name chats.
    oneShot: adapter.driver === 'pi',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    // Mousse-run tools (strong containment) are exact; the vendor-like test runtimes ask first.
    caps: () => ({ ...adapter.capabilities, planMode: true, contextUsage, toolControl: adapter.capabilities.containment === 'strong' ? 'exact' : 'approval_only', budgets: 'unsupported', spendLimits: 'unsupported', definitionLimits: 'none', ...caps }),
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
