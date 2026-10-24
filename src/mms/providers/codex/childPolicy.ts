import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'
import { MOUSSE_MCP_SERVER_NAME } from '../../run/mcp/attachment'
import type { AskForApproval, SandboxMode, SandboxPolicy, ThreadConfig } from './protocol'

/** What a turn's mode and delegation policy decide about Codex's sandbox and approvals. */
export interface CodexTurnPolicy {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
}

const READ_ONLY_SANDBOX: SandboxPolicy = { type: 'readOnly', networkAccess: false }

/**
 * The sandbox and approval policy of one Codex turn, used for `thread/start` / `thread/resume` and
 * again for `turn/start`, so a resumed thread cannot keep an older policy. A plan turn is read-only
 * and asks. A read-only (`shared`) child is read-only and never asks: its approvals would surface in
 * a thread nobody is watching, and the sandbox already refuses the write.
 */
export function codexTurnPolicy(mode: 'plan' | 'default', child: ChildTurnPolicy | undefined): CodexTurnPolicy {
  const readOnlyChild = child?.readOnly === true
  if (readOnlyChild || mode === 'plan')
    return { approvalPolicy: readOnlyChild ? 'never' : 'on-request', sandbox: 'read-only', sandboxPolicy: { ...READ_ONLY_SANDBOX } }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
}

/** Server names that a dotted config key can address (`mcp_servers.<name>.enabled`). */
const BARE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * Config overrides for a delegated child's Codex thread. Any child gets Codex's native subagents
 * (`multi_agent`) turned off, so every task a child runs stays inside its own run. A read-only child
 * also loses everything outside the sandbox that could act for it: plugins, apps (connectors),
 * computer and browser use, and every MCP server the user configured. The user's servers are listed
 * by `config/read` because an override cannot replace the `mcp_servers` table, only switch each
 * server off; Mousse's own server is kept. A server whose name a dotted key cannot address fails the
 * turn rather than stay on.
 */
export function codexChildConfigOverrides(child: ChildTurnPolicy | undefined, userMcpServers: readonly string[] = []): ThreadConfig {
  if (!child) return {}
  const overrides: ThreadConfig = { 'features.multi_agent': false, 'features.multi_agent_v2': false }
  if (!child.readOnly) return overrides
  Object.assign(overrides, {
    'features.plugins': false,
    'features.apps': false,
    'features.computer_use': false,
    'features.browser_use': false
  })
  for (const name of userMcpServers) {
    if (name === MOUSSE_MCP_SERVER_NAME) continue
    if (!BARE_KEY.test(name))
      throw new Error(`The Codex MCP server "${name}" cannot be turned off for a read-only subagent; rename it using letters, digits, "-" and "_".`)
    overrides[`mcp_servers.${name}.enabled`] = false
  }
  return overrides
}
