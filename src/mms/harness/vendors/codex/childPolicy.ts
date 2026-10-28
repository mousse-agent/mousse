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
 *
 * Nothing here edits the user's Codex configuration or their MCP servers.
 */
export function codexTurnPolicy(mode: 'plan' | 'default', child: ChildTurnPolicy | undefined, permissionMode: PermissionMode): CodexTurnPolicy {
  if (mode === 'plan' || child?.readOnly === true)
    return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (permissionMode === 'full')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}
