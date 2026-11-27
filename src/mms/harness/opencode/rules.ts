import { createHash } from 'node:crypto'
import type { PermissionAction, PermissionMode } from '../../../shared/permissionMode'

/**
 * The permission rules Mousse gives each OpenCode session, and what an OpenCode permission request is to Mousse.
 *
 * How OpenCode 2.0 decides (`packages/core/src/permission.ts`): a session's rules are read after its agent's, and the
 * last rule whose action and resource match wins (`evaluate`, `findLast`), so a session rule outranks every agent rule
 * the user's config sets. Rules the user saved with "always" are read after both (`savedRules`), and a plugin's
 * `permission.evaluate` hook sees the result last: those two can turn an ask into an allow, so the runtime checks for
 * them before a turn that must ask (`sessions.ts`). A tool whose action a rule denies for every resource is not offered
 * to the model at all (`tool.ts` `whollyDisabled`).
 */

/** One OpenCode 2.0 permission rule (`Permission.Rule`). */
export interface OpencodeRule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

/** OpenCode's questions (forms nobody in Mousse answers): never offered. */
const NEVER_OFFERED = ['question']

/**
 * Tools offered only in Full access. OpenCode's own subagents run child sessions whose asks Mousse does not follow, and
 * Code Mode (`execute`) runs model code whose own `opencode_*` tools never ask (`tool/plugin/opencode.ts`).
 */
const FULL_ACCESS_ONLY = ['subagent', 'execute', 'opencode_*']

/**
 * Tools that change files: OpenCode's `write`, `edit` and `patch` all ask as `edit` (`tool/plugin/*.ts` `permission`).
 */
const EDIT_ACTIONS: ReadonlySet<string> = new Set(['edit', 'write', 'patch'])

/** OpenCode's shell, by the action it asks as (V2 `shell`, V1 `bash`). */
const SHELL_ACTIONS: ReadonlySet<string> = new Set(['shell', 'bash'])

/** The MCP namespace OpenCode gives a server (`tool/mcp.ts` `namespace`). */
export function mcpNamespace(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** The name Mousse's MCP server has on the OpenCode server for one thread: each thread's bearer stays its own. */
export function mousseServerName(threadId: string): string {
  return `mousse_${createHash('sha256').update(threadId).digest('hex').slice(0, 12)}`
}

/** Whether OpenCode's shell runs unasked in `mode` and so stays offered (see `sessionRules`). */
export function shellOffered(mode: PermissionMode): boolean {
  return mode === 'full'
}

/**
 * The rules of a session in `mode`. Every rule set ends with the same tails: other threads' Mousse servers denied (their
 * tools are on the same server, with another thread's bearer), this thread's allowed (Mousse checks those calls
 * itself; the MCP relay's ask outside Full access), and the tools no turn is offered denied.
 *
 * - Full access: everything allowed (OpenCode's questions aside).
 * - Auto-accept edits: everything asks, file changes allowed.
 * - Ask (and Auto, which OpenCode has no mode for and so runs as Auto-accept edits would, never looser): everything asks.
 *
 * Outside Full access the shell, OpenCode's subagents and Code Mode are not offered: OpenCode 2.0 asks about a command
 * line only when its parser finds a command in it (`tool/plugin/shell.ts`, `parsed.commands.length > 0`), so a line of
 * redirections alone (`> file`) would change files without asking (see `FULL_ACCESS_ONLY` for the other two).
 */
export function sessionRules(mode: PermissionMode, threadServer?: string, relay = false): OpencodeRule[] {
  const rules: OpencodeRule[] = []
  if (mode === 'full') rules.push({ action: '*', resource: '*', effect: 'allow' })
  else {
    rules.push({ action: '*', resource: '*', effect: 'ask' })
    if (mode === 'accept_edits' || mode === 'auto') for (const action of EDIT_ACTIONS) rules.push({ action, resource: '*', effect: 'allow' })
    for (const action of [...SHELL_ACTIONS, ...FULL_ACCESS_ONLY]) rules.push({ action, resource: '*', effect: 'deny' })
  }
  rules.push({ action: 'mousse_*', resource: '*', effect: 'deny' })
  if (threadServer) {
    rules.push({ action: `${mcpNamespace(threadServer)}_*`, resource: '*', effect: 'allow' })
    // The relay's tools are the user's own MCP servers: they ask outside Full access, as OpenCode's own tools do.
    if (relay) rules.push({ action: `${mcpNamespace(threadServer)}_relay_*`, resource: '*', effect: mode === 'full' ? 'allow' : 'ask' })
  }
  for (const action of NEVER_OFFERED) rules.push({ action, resource: '*', effect: 'deny' })
  return rules
}

/**
 * A single request's rules (`opencode/oneShot.ts`): nothing at all, so the model is offered no tool (`whollyDisabled`).
 * `withRead`: OpenCode's own free models refuse a request that carries no tool, so for those only `read` is offered;
 * the request's `generate` runs no tool, so it is never run.
 */
export function oneShotRules(withRead = false): OpencodeRule[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...(withRead ? [{ action: 'read', resource: '*', effect: 'allow' as const }] : [])
  ]
}

/** What a permission request of `action` does, for the thread's permission mode. */
export function actionKind(action: string): PermissionAction {
  if (EDIT_ACTIONS.has(action)) return 'edit'
  if (SHELL_ACTIONS.has(action)) return 'command'
  return 'tool'
}

/**
 * The ACP tool kind an OpenCode action reads as, for the permission key a thread's "Always" grant is kept under
 * (`acp:<kind>`), so a grant made on OpenCode over ACP still applies.
 */
export function permissionKind(action: string): string {
  if (EDIT_ACTIONS.has(action)) return 'edit'
  if (SHELL_ACTIONS.has(action)) return 'execute'
  if (action === 'read') return 'read'
  if (action === 'glob' || action === 'grep') return 'search'
  if (action === 'webfetch' || action === 'websearch') return 'fetch'
  return 'other'
}

/** A stable key of a rule set, so a resumed session is given new rules only when they changed. */
export function rulesKey(rules: readonly OpencodeRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 16)
}
