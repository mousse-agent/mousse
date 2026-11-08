import { isAbsolute, resolve } from 'node:path'
import type { BotAuthority, BotCheck, NormalisedCall } from '../../../../shared/bots/personal/authority'
import { checkMessage } from '../../../../shared/bots/personal/walls'
import type { NativeToolTable } from '../../../../shared/harness/tools'
import { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../run/mcp/attachment'

/**
 * A bot's turn on Codex (Bot Phase 1): Codex runs in its asking mode (`untrusted` approvals, no
 * network), and every approval it raises is answered by the bot's authority, the same check (and
 * the same walls and asks) as Pi's gate. Nobody is asked. Its sandbox is read-only, or, for a bot
 * with "run commands", `workspaceWrite` over the bot's own folders (`codexTurnPolicy`).
 *
 * What Codex runs without asking is not checked here: the read-only commands it trusts (it reads
 * files with them) and its web search. Its sandbox keeps those inside it. Shell commands it asks
 * about are `shell` calls, allowed whenever the bot holds "run commands"; file changes are `write`
 * (a new file) or `edit` calls, each on its own path. A retry outside the sandbox is never allowed.
 */

/**
 * Codex's own items for each neutral tool, for a bot policy's allowlist. Codex does not enforce the
 * list: what it runs is decided by its approvals (`codexBotCommand`, `codexBotFileChange`). It reads
 * and searches with commands, and has no fetch of its own beside its web search.
 */
export const CODEX_NATIVE_TOOLS: NativeToolTable = Object.freeze({
  read: ['commandExecution'],
  list: ['commandExecution'],
  search: ['commandExecution'],
  edit: ['fileChange'],
  write: ['fileChange'],
  shell: ['commandExecution'],
  web_fetch: ['webSearch'],
  web_search: ['webSearch']
})

/** Codex's answer to one approval of a bot turn: the call runs, or is declined with the reason the model reads. */
export type CodexBotDecision = { decision: 'accept' } | { decision: 'decline'; reason: string }

const decided = (check: BotCheck): CodexBotDecision => (check.ok ? { decision: 'accept' } : { decision: 'decline', reason: checkMessage(check) })

/** Why a bot's command never runs outside Codex's sandbox. */
export const CODEX_BOT_UNSANDBOXED_REFUSAL = 'This bot\'s commands run only in its sandbox. Try another way.'

/**
 * A command Codex asks to run (`item/commandExecution/requestApproval`): a `shell` call in its
 * folder. Codex asks again to run a command that failed in its sandbox without it ("retry without
 * sandbox"): that is declined, whatever the bot holds.
 */
export function codexBotCommand(bot: Pick<BotAuthority, 'check'>, request: { command: string | undefined; cwd: string; reason?: string | null }): CodexBotDecision {
  if (request.reason && /without (the )?sandbox/i.test(request.reason)) return { decision: 'decline', reason: CODEX_BOT_UNSANDBOXED_REFUSAL }
  const call: NormalisedCall = { kind: 'builtin', tool: 'shell', nativeName: 'shell', args: { ...(request.command !== undefined ? { command: request.command } : {}), cwd: request.cwd } }
  return decided(bot.check(call))
}

/** One change of a Codex file change, as the item describes it. */
export interface CodexFileChange {
  path: string
  /** `add`, `update` or `delete`. */
  kind: string
  /** An update that moves the file there. */
  movePath?: string | null
}

/**
 * A file change Codex asks to apply (`item/fileChange/requestApproval`): every path it touches must
 * be allowed, a new file as `write`, any other change as `edit`. Relative paths are under the
 * turn's folder. A change set Codex did not describe, or one that asks to widen its write roots
 * (`grantRoot`), is declined: nothing could be checked.
 */
export function codexBotFileChange(bot: Pick<BotAuthority, 'check'>, request: { changes: readonly CodexFileChange[]; cwd: string; grantRoot?: string | null }): CodexBotDecision {
  if (request.grantRoot) return { decision: 'decline', reason: 'This bot cannot widen where Codex may write. Change one file at a time instead.' }
  if (!request.changes.length) return { decision: 'decline', reason: 'This change does not say which files it touches, so it was not checked and does not run.' }
  const at = (path: string) => (isAbsolute(path) ? path : resolve(request.cwd, path))
  for (const change of request.changes) {
    const touched: Array<{ tool: 'write' | 'edit'; path: string }> = [{ tool: change.kind === 'add' ? 'write' : 'edit', path: at(change.path) }]
    if (change.movePath) touched.push({ tool: 'write', path: at(change.movePath) })
    for (const { tool, path } of touched) {
      const answer = decided(bot.check({ kind: 'builtin', tool, nativeName: 'apply_patch', args: { path } }))
      if (answer.decision === 'decline') return answer
    }
  }
  return { decision: 'accept' }
}

/** Why a bot turn does not run on Codex while the user's own MCP servers cannot be read or switched off. */
export const CODEX_BOT_USER_MCP_UNREADABLE = 'Mousse could not read your Codex MCP servers to switch them off for this bot, so it does not run on Codex now.'

/**
 * The thread config of a bot turn that switches off every MCP server of the user's own Codex setup
 * (`readCodexUserSetup`): their tools would run under Codex's rules, never the bot's. Mousse's own
 * server stays. Undefined when the setup could not be read or names a server that cannot be
 * addressed in a config key: the turn is then refused.
 */
export function codexBotMcpOverrides(servers: readonly string[] | null): Record<string, boolean> | undefined {
  if (servers === null) return undefined
  const overrides: Record<string, boolean> = {}
  for (const name of servers) {
    if (name === MOUSSE_MCP_SERVER_NAME || name === MOUSSE_RELAY_SERVER_NAME) continue
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined
    overrides[`mcp_servers.${name}.enabled`] = false
  }
  return overrides
}
