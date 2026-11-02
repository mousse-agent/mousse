import type { McpServerConfig, McpToolDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { McpCallRequest } from '../appTools/registry'
import type { AppToolTurn, McpCaller } from '../appTools/types'

/**
 * What a turn's bearer grants of the MCP relay (`mousse-relay`, SPEC §15.5): who asks the user
 * before a relayed tool runs. `runtime`: the runtime's own permission flow; `mousse`: the relay asks
 * through the thread's approval cards. Kept in memory with the credential, never in its generation.
 */
export interface RelayGrant {
  approvals: 'runtime' | 'mousse'
}

/** One enabled server's tools as the relay catalogue reads them (`McpManager.getEnabledToolsByServer`). */
export interface RelayServerTools {
  installationId: string
  serverName: string
  configRevision?: string
  tools: McpToolDescriptor[]
  /** Listing this server failed: the catalogue keeps its last-good tools. */
  error?: string
}

/** What the relay catalogue needs of `McpManager` (structural, so the manager satisfies it as it grows). */
export interface RelayCatalogManager {
  /** Each enabled server's tools for the actor, one server's failure never failing the rest. */
  getEnabledToolsByServer(projectPath?: string, actor?: IntegrationActor): Promise<RelayServerTools[]>
  /** Called when the manager's discovery cache is invalidated; returns the unsubscribe. */
  onDiscoveryInvalidated(listener: () => void): () => void
  /** The configured servers of the scope, from the manager's cached discovery. */
  listConfiguredServers(projectPath?: string): Promise<McpServerConfig[]>
}

/** A relay call admitted by the registry (`ToolRegistry.admit`): the same liveness, run and token checks as `call`. */
export interface RelayAdmission {
  threadId: string
  /** The thread's active run, which the call acts as. */
  active: string
  turn: AppToolTurn
  /** The arguments with the turn and attempt tokens removed. */
  args: Record<string, unknown>
  caller: McpCaller
  /** The turn or attempt token the call is bound to. */
  boundToken: string
}

/** The registry's admission step, as the relay handler uses it. */
export interface RelayAdmitter {
  admit(rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<RelayAdmission>
}
