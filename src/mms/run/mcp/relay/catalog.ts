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
  /**
   * Whether the profile's own servers (the scope with no project) are listed even while no runtime has the relay on:
   * personal bots reach them through Mousse whatever the relay settings of the owner's threads (`BotMcp`).
   */
  listProfile?: () => boolean
}

/** One project scope's catalogue. */
interface Scope {
  /** Each enabled installation's last good tools. */
  servers: Map<string, RelayServerTools>
  /** Installations whose last listing failed (their last good tools are kept). */
  failing: Set<string>
  /** Enabled installations that have not answered a listing yet (just started, or slow): no tools known yet. */
  starting: Set<string>
  /** Each configured installation (enabled or not) with its name and identity (`mcpServerIdentity`). */
  configured: Map<string, { serverName: string; identity: string }>
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
  private readonly listeners = new Set<(projectPath: string | undefined) => void>()
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

  /**
   * Each enabled installation of the scope with its last good tools, whether its last listing failed (it is down,
   * signed out or slow), whether it has not answered yet (`starting`: no tools known), and its identity. Empty while the
   * scope is cold; a server shows here as soon as the scope's configured servers are read, and its tools as soon as it
   * answers, whatever the others do.
   */
  servers(projectPath?: string): Array<RelayServerTools & { failing: boolean; starting: boolean; identity?: string }> {
    const scope = this.scopes.get(scopeKey(projectPath))
    if (!scope) return []
    return [...scope.servers.values()].map((entry) => {
      const identity = scope.configured.get(entry.installationId)?.identity
      return { ...entry, failing: scope.failing.has(entry.installationId), starting: scope.starting.has(entry.installationId), ...(identity ? { identity } : {}) }
    })
  }

  /** Every configured installation of the scope, switched on or off, by its last read; empty while the scope is cold. */
  configured(projectPath?: string): Array<{ installationId: string; serverName: string; identity: string }> {
    const scope = this.scopes.get(scopeKey(projectPath))
    return scope ? [...scope.configured].map(([installationId, entry]) => ({ installationId, ...entry })) : []
  }

  /** Called after each change of a scope's servers or tools (each server's answer included); returns the unsubscribe. */
  onPublished(listener: (projectPath: string | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Whether the scope was read at least once (a cold scope lists nothing yet, which says nothing of its servers). */
  listed(projectPath?: string): boolean {
    return this.scopes.get(scopeKey(projectPath))?.refreshedAt !== undefined
  }

  /** The tool a relayed name resolves to, in the current or previous good listing of the scope. */
  resolve(projectPath: string | undefined, name: string): RelayTool | undefined {
    const scope = this.scopes.get(scopeKey(projectPath))
    return scope?.byName.get(name) ?? scope?.previous.get(name)
  }

  /**
   * A warm scope returns at once (a stale one refreshes in the background); a cold one waits up to the budget. Never
   * throws. `signIn: false`: a refresh this starts never starts a sign-in (a bot's). `fresh`: a scope whose servers or
   * settings changed since its last read waits up to the budget too (a bot's turn must not be offered a removed server).
   */
  async ensure(projectPath?: string, budgetMs: number = RELAY_WARMUP_BUDGET_MS, options: { signIn?: false; fresh?: true } = {}): Promise<void> {
    if (this.disposed) return
    const scope = this.scope(projectPath)
    const changed = options.fresh === true && (scope.seen !== this.invalidations || scope.settingsKey !== settingsKey(this.deps.settings()))
    if (scope.refreshedAt === undefined || changed) {
      const refresh = this.refresh(projectPath, options)
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, budgetMs))
        timer.unref?.()
      })
      await Promise.race([refresh, budget])
      clearTimeout(timer)
      return
    }
    if (this.stale(scope)) void this.refresh(projectPath, options)
  }

  /** Re-reads the scope (one at a time per scope); a server that fails keeps its last good tools. */
  refresh(projectPath?: string, options: { signIn?: false } = {}): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const scope = this.scope(projectPath)
    scope.refreshing ??= this.read(projectPath, scope, options).finally(() => {
      scope.refreshing = undefined
    })
    return scope.refreshing
  }

  /**
   * Marks every scope stale (the manager's discovery cache was invalidated). The profile's own scope, which personal
   * bots read (`listProfile`), is read again at once, without a sign-in, so a server removed or added shows in About.
   */
  invalidate(): void {
    this.invalidations += 1
    if (!this.disposed && this.deps.listProfile?.() === true && this.scopes.get(scopeKey(undefined))?.refreshedAt !== undefined)
      void this.refresh(undefined, { signIn: false })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.scopes.clear()
    this.listeners.clear()
  }

  private scope(projectPath: string | undefined): Scope {
    const key = scopeKey(projectPath)
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = { servers: new Map(), failing: new Set(), starting: new Set(), configured: new Map(), listing: [], byName: new Map(), previous: new Map(), revision: '', seen: -1 }
      this.scopes.set(key, scope)
    }
    return scope
  }

  private published(projectPath: string | undefined): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(projectPath)
      } catch (error) {
        logWarn('McpRelay', `A catalogue listener failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`)
      }
    }
  }

  private stale(scope: Scope): boolean {
    return scope.seen !== this.invalidations
      || scope.attemptedAt === undefined
      || this.now() - scope.attemptedAt >= RELAY_LISTING_TTL_MS
      || scope.settingsKey !== settingsKey(this.deps.settings())
  }

  /**
   * One refresh of the scope; never throws. The configured servers are published first (each enabled one that never
   * answered as `starting`, the others with their last good tools), then each server's tools as soon as it answers,
   * so one slow server hides only itself. A server that fails keeps its last good tools; one that never listed is
   * kept with none, as failing. Nothing changes unless the configured servers could be read.
   */
  private async read(projectPath: string | undefined, scope: Scope, options: { signIn?: false } = {}): Promise<void> {
    const settings = this.deps.settings()
    const seen = this.invalidations
    try {
      let eligible: McpServerConfig[] = []
      let configured: McpServerConfig[] = []
      // No runtime has the relay (and no bot needs the profile's servers): nothing is listed and no server is started.
      const lists = anyRuntime(settings) || (projectPath === undefined && settings.enabled && this.deps.listProfile?.() === true)
      const actor = defaultIntegrationActor(false)
      if (lists) {
        configured = await this.deps.manager.listConfiguredServers(projectPath)
        eligible = resolveEffectiveMcpServers({ servers: configured, settings, actor })
          .filter((server) => server.status !== 'missing-env' && server.status !== 'failed')
      }
      if (this.disposed) return
      const before = { servers: scope.servers, byName: scope.byName }
      const answered = new Map<string, RelayServerTools>()
      scope.configured = new Map(configured.map((server) => [mcpInstallationId(server), { serverName: server.name, identity: mcpServerIdentity(server) }]))
      const publish = (final: boolean): void => {
        if (this.disposed) return
        const servers = new Map<string, RelayServerTools>()
        const failing = new Set<string>()
        const starting = new Set<string>()
        const ids = [...eligible.map((server) => ({ id: mcpInstallationId(server), name: server.name })), ...[...answered.values()].map((entry) => ({ id: entry.installationId, name: entry.serverName }))]
        for (const { id, name } of ids) {
          if (servers.has(id)) continue
          const entry = answered.get(id)
          const kept = before.servers.get(id)
          if (entry && !entry.error) servers.set(id, entry)
          else if (entry || final) {
            failing.add(id)
            servers.set(id, kept ?? { installationId: id, serverName: entry?.serverName ?? name, tools: [] })
          } else if (kept) {
            // Still listing: its last good tools (or none, as failing, if its last listing failed).
            servers.set(id, kept)
            if (scope.failing.has(id)) failing.add(id)
          } else {
            servers.set(id, { installationId: id, serverName: name, tools: [] })
            starting.add(id)
          }
        }
        scope.failing = failing
        scope.starting = starting
        const { tools, dropped } = allocateRelayTools([...servers.values()].flatMap((entry) => entry.tools))
        const digest = relayListingDigest(tools)
        const changed = digest !== relayListingDigest(scope.listing)
        if (final && changed && dropped.length) logWarn('McpRelay', `${dropped.length} MCP tool(s) not relayed: ${dropped.map((tool) => `${tool.id} (${tool.reason})`).join(', ').slice(0, 2000)}`)
        // A name a runtime still holds resolves for one generation more: the listing before this refresh, and the last
        // one published during it.
        if (changed) scope.previous = new Map([...before.byName, ...scope.byName])
        scope.servers = servers
        scope.listing = tools
        scope.byName = new Map(tools.map((tool) => [tool.name, tool]))
        // A runtime reopens for a new revision: none is made while nothing answered yet.
        if (final || tools.length) scope.revision = catalogueRevision(eligible, digest)
        scope.refreshedAt = this.now()
        scope.settingsKey = settingsKey(settings)
        this.published(projectPath)
      }
      publish(false)
      if (eligible.length) {
        const heard = (entry: RelayServerTools): void => {
          answered.set(entry.installationId, entry)
          if (entry.error) logWarn('McpRelay', `Listing MCP server "${entry.serverName}" failed; its last good tools are kept: ${redactSensitiveText(entry.error)}`)
        }
        try {
          const listed = await this.deps.manager.getEnabledToolsByServer(projectPath, actor, {
            ...options,
            onServer: (entry) => {
              heard(entry)
              publish(false)
            }
          })
          // A manager that does not report each server as it answers is read whole.
          for (const entry of listed) if (!answered.has(entry.installationId)) heard(entry)
        } catch (error) {
          // The servers that did not answer count as failing, with their last good tools.
          logWarn('McpRelay', `The MCP servers could not all be listed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`)
        }
      }
      publish(true)
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

/**
 * What a server is, as a bot's grant binds it (10 hex characters): a remote server's URL origin and path (never its
 * query), or a local server's command and arguments, with anything that looks like a secret redacted first. A server
 * edited in place to point somewhere else gets another identity, so a grant made for the old one no longer holds.
 */
export function mcpServerIdentity(server: Pick<McpServerConfig, 'transport' | 'url' | 'command' | 'args'>): string {
  if (server.transport === 'stdio') {
    const args = (server.args ?? []).map(String)
    // A value after a flag that names a secret (`--api-key <value>`), and anything shaped like a key, is left out.
    const redacted = args.map((arg, index) => (index > 0 && SECRET_FLAG.test(args[index - 1]!) && !arg.startsWith('-')) || looksLikeSecret(arg) ? '<secret>' : redactSensitiveText(arg))
    return shortHash(canonicalJson({ v: 1, command: redactSensitiveText(server.command ?? ''), args: redacted }), 10)
  }
  let where = server.url ?? ''
  try {
    const url = new URL(where)
    const decoded = (part: string) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    }
    where = `${url.origin}${url.pathname.split('/').map((part) => (looksLikeSecret(decoded(part)) ? '<secret>' : part)).join('/')}`
  } catch {
    // Not a URL: hashed as it is (redacted).
  }
  return shortHash(canonicalJson({ v: 1, url: redactSensitiveText(where) }), 10)
}

const SECRET_FLAG = /^--?[\w-]*(?:key|token|secret|password|auth)[\w-]*$/i

/** A long run of letters and digits, mixed, with no spaces: an API key or token, not a name a person chose. */
function looksLikeSecret(value: string): boolean {
  const core = value.replace(/^[A-Za-z]{1,6}[-_]/, '')
  return core.length >= 24 && /^[A-Za-z0-9_\-+/=.]+$/.test(core) && /\d/.test(core) && /[A-Za-z]/.test(core) && !/[\\/.]{2}|^\./.test(core) && !/\.(?:js|mjs|cjs|ts|py|exe|json|jar)$/i.test(core)
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
