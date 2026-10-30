import type { MousseIntegrationsSettings } from '../../../../shared/integrations'
import type { RelayTool } from './names'
import type { RelayCatalogManager } from './types'

/** A listing older than this is served, and refreshed in the background. */
export const RELAY_LISTING_TTL_MS = 5 * 60_000
/** How long a turn start waits for a cold catalogue before the turn starts without relay tools. */
export const RELAY_WARMUP_BUDGET_MS = 3_000

export interface RelayCatalogDeps {
  manager: RelayCatalogManager
  settings: () => MousseIntegrationsSettings['mcp']
  now?: () => number
}

/**
 * The MCP relay's tools per project scope (SPEC §15.5): the last good listing of the user's enabled
 * servers, read synchronously by the relay's `tools/list` and by turn start (its revision). A listing
 * is never fetched inside a request: `ensure` warms a cold scope, `refresh` re-reads one.
 */
export class RelayCatalog {
  constructor(private readonly deps: RelayCatalogDeps) {}

  /** The scope's catalogue revision: `''` when no runtime has the relay or no server is eligible. */
  revision(_projectPath?: string): string {
    return ''
  }

  /** The scope's last good listing; empty while it is cold. */
  listing(_projectPath?: string): RelayTool[] {
    return []
  }

  /** The tool a relayed name resolves to, in the current or previous good listing of the scope. */
  resolve(_projectPath: string | undefined, _name: string): RelayTool | undefined {
    return undefined
  }

  /** A warm scope returns at once (a stale one refreshes in the background); a cold one waits up to the budget. Never throws. */
  async ensure(_projectPath?: string, _budgetMs: number = RELAY_WARMUP_BUDGET_MS): Promise<void> {}

  /** Re-reads the scope (one at a time per scope); a server that fails keeps its last good tools. */
  async refresh(_projectPath?: string): Promise<void> {}

  /** Marks every scope stale (the manager's discovery cache was invalidated). */
  invalidate(): void {}

  dispose(): void {}
}
