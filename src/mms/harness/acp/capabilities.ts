import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ProviderCapabilities } from '../../run/adapters/ProviderAdapter'
import { mousseVersion } from '../../appVersion'
import type { AcpRpc } from './connection'

/**
 * What every ACP agent offers the run engine. `childPolicy: 'isolated_only'`: Mousse cannot hold
 * an agent's own tools to read-only, so a `shared` (read-only) child is refused. An `isolated`
 * child runs; any native subagent it starts is only observed, not controlled.
 */
export const ACP_BASE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'interrupt_restart',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'sparse',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  childPolicy: 'isolated_only'
})

/** What `initialize` told Mousse about the agent. */
export interface AcpAgentInfo {
  /** `mcpCapabilities.http`: otherwise the Mousse server goes through the stdio bridge. */
  mcpHttp: boolean
}

/**
 * `initialize` with Mousse's client capabilities: client fs only where the preset offers it, and
 * no client terminals. Throws when the agent answers another protocol version.
 */
export async function initializeAgent(connection: AcpRpc, options: { clientFs: boolean; label: string }): Promise<AcpAgentInfo> {
  const response = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: options.clientFs, writeTextFile: options.clientFs }, terminal: false },
    clientInfo: { name: 'Mousse', version: mousseVersion() }
  })
  if (response.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ${options.label} ACP protocol ${response.protocolVersion}`)
  return { mcpHttp: response.agentCapabilities?.mcpCapabilities?.http === true }
}
