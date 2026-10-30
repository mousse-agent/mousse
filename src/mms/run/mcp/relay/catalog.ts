import { MCP_RELAY_RUNTIMES, relayEnabledFor, type McpRelayRuntime, type McpServerConfig, type MousseIntegrationsSettings } from '../../../../shared/integrations'
import { defaultIntegrationActor } from '../../../../shared/integrations/actor'
import { resolveEffectiveMcpServers } from '../../../integrations/catalog/EffectiveIntegrationResolver'
import { mcpInstallationId } from '../../../integrations/mcp/connectionKey'
import { canonicalJson, shortHash } from '../../../integrations/revision'
import { redactSensitiveText } from '../../../integrations/secrets'
import { logWarn } from '../../../log/diag'
import type { AppToolTurn } from '../appTools/types'
import { allocateRelayTools, relayListingDigest, type RelayTool } from './names'
import type { RelayCatalogManager, RelayServerTools } from './types'

/** A listing older than this is served, and refreshed in the background. */
export const RELAY_LISTING_TTL_MS = 5 * 60_000
/** How long a turn start waits for a cold catalogue before the turn starts without relay tools. */
export const RELAY_WARMUP_BUDGET_MS = 3_000

export interface RelayCatalogDeps {
  manager: RelayCatalogManager
  settings: () => MousseIntegrationsSettings['mcp']
  now?: () => number
}

/** One project scope's catalogue. */
interface Scope {
  /** Each enabled installation's last good tools. */
  servers: Map<string, RelayServerTools>
  listing: RelayTool[]
  byName: Map<string, RelayTool>
  /** The listing before the last change, so a name a runtime still holds resolves for one generation more. */
  previous: Map<string, RelayTool>
  /** The revision of the last good refresh, before the live "no runtime has the relay" check. */
  revision: string
  /** The last good refresh (undefined: cold) and the last attempt, good or not (the TTL). */
  refreshedAt?: number
  attemptedAt?: number
  /** The settings the last refresh read; other settings make the scope stale. */
  settingsKey?: string
  /** Invalidations seen by the last refresh that started; a newer one makes the scope stale. */
  seen: number
  refreshing?: Promise<void>
}

/**
 * The MCP relay's tools per project scope (SPEC §15.5): the last good listing of the user's enabled
 * servers, read synchronously by the relay's `tools/list` and by turn start (its revision). A listing
 * is never fetched inside a request: `ensure` warms a cold scope, `refresh` re-reads one.
 */
export class RelayCatalog {
  private readonly scopes = new Map<string, Scope>()
  private readonly now: () => number
  private readonly unsubscribe: () => void
  private invalidations = 0
  private disposed = false

  constructor(private readonly deps: RelayCatalogDeps) {
    this.now = deps.now ?? Date.now
    this.unsubscribe = deps.manager.onDiscoveryInvalidated(() => this.invalidate())
  }

  /** The scope's catalogue revision: `''` when no runtime has the relay or no server is eligible. */
  revision(projectPath?: string): string {
    if (!anyRuntime(this.deps.settings())) return ''
    return this.scopes.get(scopeKey(projectPath))?.revision ?? ''
  }

  /** The scope's last good listing; empty while it is cold. */
  listing(projectPath?: string): RelayTool[] {
    return this.scopes.get(scopeKey(projectPath))?.listing ?? []
  }

  /** The tool a relayed name resolves to, in the current or previous good listing of the scope. */
  resolve(projectPath: string | undefined, name: string): RelayTool | undefined {
    const scope = this.scopes.get(scopeKey(projectPath))
    return scope?.byName.get(name) ?? scope?.previous.get(name)
  }

  /** A warm scope returns at once (a stale one refreshes in the background); a cold one waits up to the budget. Never throws. */
  async ensure(projectPath?: string, budgetMs: number = RELAY_WARMUP_BUDGET_MS): Promise<void> {
    if (this.disposed) return
    const scope = this.scope(projectPath)
    if (scope.refreshedAt === undefined) {
      const refresh = this.refresh(projectPath)
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, budgetMs))
        timer.unref?.()
      })
      await Promise.race([refresh, budget])
      clearTimeout(timer)
      return
    }
    if (this.stale(scope)) void this.refresh(projectPath)
  }

  /** Re-reads the scope (one at a time per scope); a server that fails keeps its last good tools. */
  refresh(projectPath?: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const scope = this.scope(projectPath)
    scope.refreshing ??= this.read(projectPath, scope).finally(() => {
      scope.refreshing = undefined
    })
    return scope.refreshing
  }

  /** Marks every scope stale (the manager's discovery cache was invalidated). */
  invalidate(): void {
    this.invalidations += 1
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.scopes.clear()
  }

  private scope(projectPath: string | undefined): Scope {
    const key = scopeKey(projectPath)
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = { servers: new Map(), listing: [], byName: new Map(), previous: new Map(), revision: '', seen: -1 }
      this.scopes.set(key, scope)
    }
    return scope
  }

  private stale(scope: Scope): boolean {
    return scope.seen !== this.invalidations
      || scope.attemptedAt === undefined
      || this.now() - scope.attemptedAt >= RELAY_LISTING_TTL_MS
      || scope.settingsKey !== settingsKey(this.deps.settings())
  }

  /** One refresh of the scope. Nothing changes unless it succeeds; never throws. */
  private async read(projectPath: string | undefined, scope: Scope): Promise<void> {
    const settings = this.deps.settings()
    const seen = this.invalidations
    try {
      let eligible: McpServerConfig[] = []
      let listed: RelayServerTools[] = []
      // No runtime has the relay: nothing is listed and no server is started for it.
      if (anyRuntime(settings)) {
        const actor = defaultIntegrationActor(false)
        const servers = await this.deps.manager.listConfiguredServers(projectPath)
        eligible = resolveEffectiveMcpServers({ servers, settings, actor })
          .filter((server) => server.status !== 'missing-env' && server.status !== 'failed')
        listed = eligible.length ? await this.deps.manager.getEnabledToolsByServer(projectPath, actor) : []
      }
      if (this.disposed) return
      const servers = new Map<string, RelayServerTools>()
      for (const entry of listed) {
        const kept = entry.error ? scope.servers.get(entry.installationId) : entry
        if (entry.error) logWarn('McpRelay', `Listing MCP server "${entry.serverName}" failed; its last good tools are kept: ${redactSensitiveText(entry.error)}`)
        if (kept) servers.set(entry.installationId, kept)
      }
      const { tools, dropped } = allocateRelayTools([...servers.values()].flatMap((entry) => entry.tools))
      const digest = relayListingDigest(tools)
      const changed = digest !== relayListingDigest(scope.listing)
      if (changed && dropped.length) logWarn('McpRelay', `${dropped.length} MCP tool(s) not relayed: ${dropped.map((tool) => `${tool.id} (${tool.reason})`).join(', ').slice(0, 2000)}`)
      if (changed) scope.previous = scope.byName
      scope.servers = servers
      scope.listing = tools
      scope.byName = new Map(tools.map((tool) => [tool.name, tool]))
      scope.revision = catalogueRevision(eligible, digest)
      scope.refreshedAt = this.now()
      scope.settingsKey = settingsKey(settings)
    } catch (error) {
      logWarn('McpRelay', `The relay catalogue could not be refreshed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`)
    } finally {
      scope.attemptedAt = this.now()
      scope.seen = seen
    }
  }
}

function scopeKey(projectPath: string | undefined): string {
  return projectPath ?? ''
}

function anyRuntime(settings: MousseIntegrationsSettings['mcp']): boolean {
  return MCP_RELAY_RUNTIMES.some((runtime) => relayEnabledFor(settings, runtime))
}

function settingsKey(settings: MousseIntegrationsSettings['mcp']): string {
  return canonicalJson(settings)
}

/**
 * What a runtime that caches the relay's tools must reopen for: the eligible servers (installation,
 * config revision, tool allow and deny lists) and the listing's names and schemas, never its
 * descriptions. `''` when no server is eligible.
 */
function catalogueRevision(eligible: readonly McpServerConfig[], listingDigest: string): string {
  if (!eligible.length) return ''
  const servers = eligible
    .map((server) => [mcpInstallationId(server), server.configRevision ?? '', [...(server.enabledTools ?? [])].sort(), [...(server.deniedTools ?? [])].sort()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return shortHash(canonicalJson({ v: 1, eligible: servers, listing: listingDigest }), 12)
}

/** What a turn carries of the MCP relay (`TurnAppContext.relay`). */
export interface RelayTurnContext {
  revision: string
  /** Every relay runtime, `true` where the relay is on. */
  runtimes: Record<McpRelayRuntime, boolean>
}

/**
 * The relay context of a turn that may attach it: none for a bot or a definition run, without a
 * catalogue, or when no runtime has the relay. A cold scope is warmed within `budgetMs` first.
 */
export async function relayTurnContext(
  catalog: RelayCatalog | undefined,
  settings: MousseIntegrationsSettings['mcp'],
  turn: Pick<AppToolTurn, 'bot' | 'definition' | 'projectPath'>,
  budgetMs: number = RELAY_WARMUP_BUDGET_MS
): Promise<RelayTurnContext | undefined> {
  if (!catalog || turn.bot || turn.definition) return undefined
  const runtimes = Object.fromEntries(MCP_RELAY_RUNTIMES.map((runtime) => [runtime, relayEnabledFor(settings, runtime)])) as Record<McpRelayRuntime, boolean>
  if (!Object.values(runtimes).some(Boolean)) return undefined
  await catalog.ensure(turn.projectPath, budgetMs)
  return { revision: catalog.revision(turn.projectPath), runtimes }
}
