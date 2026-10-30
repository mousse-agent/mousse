import type { PermissionMode } from '../../../../shared/permissionMode'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { McpCallRequest, ToolRegistryOptions } from '../appTools/registry'
import { McpToolError, type ToolLedger, type ToolOutcome } from '../appTools/types'
import type { CredentialRecord } from '../McpCredentials'
import type { RelayCatalog } from './catalog'
import type { RelayAdmitter } from './types'

/** What the relay handler needs of the profile: the catalogue, the manager and the thread's authority. */
export interface RelayHost {
  catalog: RelayCatalog
  manager: Pick<McpManager, 'isToolCallAllowed' | 'callTool'>
  /** `ToolRegistry.admit`: the liveness, run and turn-token checks of every Mousse call. */
  registry: RelayAdmitter
  /** The thread's project directory, which scopes its servers. */
  projectPathFor(threadId: string): string | undefined
  /** A read-only (`shared`) delegated child lists no relayed tools and may call none. */
  readOnlyThread?(threadId: string): boolean
  /** The permission mode the caller's run enforces. */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user before a relayed tool runs (`relay.approvals: 'mousse'`). */
  askApproval?: ToolRegistryOptions['askApproval']
  /** SPEC §12.6 tool ledger of the caller's run. */
  toolLedger?(runId: string): ToolLedger | undefined
}

/** The relay's `initialize` instructions: Mousse's own text, never a server's. */
export const RELAY_INSTRUCTIONS = 'This server relays the MCP servers the user set up in Mousse. Each tool is named <server>__<tool>. A call may ask the user for approval; never pass passwords, keys or tokens as arguments.'

/** A relayed tool listing a runtime sees. */
export interface RelayListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * The MCP relay's `tools/list` and `tools/call` (SPEC §15.5): the catalogue's listing for the
 * credential's thread, and a call re-authorised at call time and run on the user's server.
 */
export class RelayHandler {
  constructor(private readonly host: RelayHost) {}

  /** The relayed tools the credential's thread may see. */
  list(_credential: CredentialRecord): RelayListedTool[] {
    return []
  }

  /** Runs a relayed tool for the credential the request resolved to. */
  async call(_name: string, _args: Record<string, unknown>, _request: McpCallRequest): Promise<ToolOutcome> {
    throw new McpToolError('mousse_unknown_tool', 'The MCP relay is not available.')
  }
}
