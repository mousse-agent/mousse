import type { ProviderAdapter, ProviderCapabilities } from '../../src/mms/harness/adapter'

/**
 * Capabilities of a test-only `pi` adapter whose tools Mousse runs (strong containment, so
 * `adapterDriver` gives it `exact` tool control). Tests that need a `pi` instance but run no turn
 * on it use `PiStubAdapter`.
 */
export const PI_TEST_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'strong',
  historyInjection: 'prompt',
  mcp: false,
  childPolicy: 'enforced'
})

/** A `pi` adapter for tests that run no turn on it: a turn fails. */
export class PiStubAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES

  async startTurn(): Promise<never> {
    throw new Error('unused')
  }

  async interrupt(): Promise<'not_active'> {
    return 'not_active'
  }
}
