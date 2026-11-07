import type { BotAuthority } from '../../../../shared/bots/personal/authority'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ChildTurnPolicy } from '../../adapter'
import type { AskForApproval, SandboxMode, SandboxPolicy } from './protocol'

/** What a turn's mode, permission mode and delegation policy decide about Codex's sandbox and approvals. */
export interface CodexTurnPolicy {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
}

/**
 * The sandbox and approval policy of one Codex turn, used for `thread/start` / `thread/resume` and
 * again for `turn/start`, so a resumed thread cannot keep an older policy.
 *
 * - A plan turn and a read-only (`shared`) child run in the read-only sandbox with the approval
 *   policy `on-request`; Mousse answers each request that reaches it with a denial itself
 *   (`CodexProviderService.serve`), so a request never waits in a thread nobody watches.
 * - Ask before acting and Auto-accept edits run `untrusted` in the read-only sandbox (Codex's
 *   Supervised profile): every command that is not known to be safe and every patch asks Mousse.
 *   Mousse never sends a `workspaceWrite` policy on an interactive turn, whose empty roots would
 *   narrow what Codex's own full-access profile means.
 * - Full access is Codex's own full-access profile: `never` ask, no sandbox.
 * - A bot's turn (`bot`) asks like Ask before acting (`untrusted`), and the bot's authority answers.
 *   Without "run commands" it is in the read-only sandbox; with it, in the `workspaceWrite` sandbox
 *   over exactly the bot's own folders (`codexBotSandbox`), with no network and no temporary folder.
 *
 * Nothing here edits the user's Codex configuration or their MCP servers.
 */
export function codexTurnPolicy(mode: 'plan' | 'default', child: ChildTurnPolicy | undefined, permissionMode: PermissionMode, bot?: CodexBotSandbox): CodexTurnPolicy {
  if (mode === 'plan' || child?.readOnly === true)
    return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (bot?.shell)
    return {
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [...bot.writableRoots], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    }
  if (bot) return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (permissionMode === 'full')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}

/** What a bot's grant decides about its Codex sandbox (`codexTurnPolicy`). */
export interface CodexBotSandbox {
  /** The bot holds "run commands" (`shell`). */
  shell: boolean
  /** The bot's files folder, its scratch folder and the folders it may change. */
  writableRoots: string[]
}

/**
 * A bot's Codex sandbox from its authority: with `shell`, writable are its files folder, its
 * scratch folder and the folders granted for writing (`BotAuthority.workspace.writeRoots`, which
 * holds the files folder), and nothing else.
 */
export function codexBotSandbox(bot: Partial<Pick<BotAuthority, 'tools' | 'workspace'>>): CodexBotSandbox {
  const shell = bot.tools?.has('shell') === true
  const workspace = bot.workspace
  const roots = workspace ? [...(workspace.writeRoots ?? (workspace.access === 'write' ? workspace.roots : [])), ...(workspace.files !== undefined ? [workspace.files] : []), workspace.scratch] : []
  return { shell, writableRoots: shell ? [...new Set(roots)] : [] }
}

/**
 * The thread config of a bot turn with "run commands": the same `workspaceWrite` sandbox as its
 * turns (`codexTurnPolicy`), so nothing in the user's `config.toml` widens it while the thread loads.
 */
export function codexBotSandboxConfig(sandbox: CodexBotSandbox): Record<string, string[] | boolean> {
  if (!sandbox.shell) return {}
  return {
    'sandbox_workspace_write.writable_roots': [...sandbox.writableRoots],
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    'sandbox_workspace_write.exclude_slash_tmp': true
  }
}
