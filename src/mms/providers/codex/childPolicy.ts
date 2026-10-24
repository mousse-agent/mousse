import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'
import type { AskForApproval, SandboxMode, SandboxPolicy } from './protocol'

/** What a turn's mode and delegation policy decide about Codex's sandbox and approvals. */
export interface CodexTurnPolicy {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
}

/**
 * The sandbox and approval policy of one Codex turn, used for `thread/start` / `thread/resume` and
 * again for `turn/start`, so a resumed thread cannot keep an older policy. A plan turn and a
 * read-only (`shared`) child run in the read-only sandbox. The approval policy stays `on-request`
 * for both: Codex then asks before a command that needs more than the sandbox gives, before a file
 * change and before an MCP tool call it does not know to be read-only, and Mousse answers each of
 * those with a denial itself for a read-only child (`CodexProviderService.serve`), so a request
 * never waits in a thread nobody watches. Nothing here edits the user's Codex configuration or
 * their MCP servers.
 */
export function codexTurnPolicy(mode: 'plan' | 'default', child: ChildTurnPolicy | undefined): CodexTurnPolicy {
  if (mode === 'plan' || child?.readOnly === true)
    return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
}
