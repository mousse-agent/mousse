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
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  /** As sent, decoded leniently. */
  agentCapabilities: Record<string, unknown>
  authMethods: unknown[]
  /** `_meta` of the answer (some agents send their models there). */
  meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Whether the agent advertised an optional session method (`sessionCapabilities.<name>`). */
export function sessionCapability(info: AcpAgentInfo | undefined, name: 'resume' | 'close' | 'fork' | 'list'): boolean {
  const session = info?.agentCapabilities.sessionCapabilities
  return isRecord(session) && session[name] !== undefined && session[name] !== null && session[name] !== false
}

/**
 * `initialize` with Mousse's client capabilities: client fs only where the preset offers it, no
 * client terminals, plus what the runtime adds (sign-in capabilities). `strictProtocol` refuses any version but Mousse's; otherwise the answer is
 * read by its shape, and a newer version is reported, never refused.
 */
export async function initializeAgent(connection: AcpRpc, options: { clientFs: boolean; label: string; strictProtocol?: boolean; meta?: Record<string, unknown>; capabilities?: Record<string, unknown> }): Promise<AcpAgentInfo> {
  const response = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: options.clientFs, writeTextFile: options.clientFs }, terminal: false, ...options.capabilities },
    clientInfo: { name: 'Mousse', version: mousseVersion() },
    ...(options.meta ? { _meta: options.meta } : {})
  })
  if (options.strictProtocol && response.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ${options.label} ACP protocol ${response.protocolVersion}`)
  const raw = (isRecord(response) ? response : {}) as Record<string, unknown>
  const capabilities = isRecord(raw.agentCapabilities) ? raw.agentCapabilities : {}
  const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {}
  const agent = isRecord(raw.agentInfo) ? raw.agentInfo : undefined
  return {
    mcpHttp: mcp.http === true,
    ...(typeof raw.protocolVersion === 'number' ? { protocolVersion: raw.protocolVersion } : {}),
    ...(agent ? { agentInfo: { ...(typeof agent.name === 'string' ? { name: agent.name } : {}), ...(typeof agent.version === 'string' ? { version: agent.version } : {}) } } : {}),
    agentCapabilities: capabilities,
    authMethods: Array.isArray(raw.authMethods) ? raw.authMethods : [],
    ...(isRecord(raw._meta) ? { meta: raw._meta } : {})
  }
}
