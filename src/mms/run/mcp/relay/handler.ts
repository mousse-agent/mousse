import type { ToolCall } from '@earendil-works/pi-ai'
import { APPROVALS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import { DEFAULT_PERMISSION_MODE, permissionModeAllows, type PermissionMode } from '../../../../shared/permissionMode'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import { redactSensitiveText } from '../../../integrations/secrets'
import { RELAY_CALL_TIMEOUT_MS } from '../attachment'
import { userMcpOutcome, type McpCallRequest, type ToolRegistryOptions } from '../appTools/registry'
import { McpToolError, type ToolLedger, type ToolOutcome } from '../appTools/types'
import type { CredentialRecord } from '../McpCredentials'
import type { RelayCatalog } from './catalog'
import { RELAY_MAX_RESULT_CHARS, relayPermissionKey, type RelayTool } from './names'
import type { RelayAdmitter } from './types'

/** What the relay handler needs of the profile: the catalogue, the manager and the thread's authority. */
export interface RelayHost {
  catalog: RelayCatalog
  manager: Pick<McpManager, 'isToolCallAllowed' | 'callTool'>
  /** `ToolRegistry.admit`: the liveness, run and turn-token checks of every Mousse call. */
  registry: RelayAdmitter
  /** The thread's project directory, which scopes its servers. */
  projectPathFor(threadId: string): string | undefined
  /** A read-only (`shared`) delegated child lists no relayed tools and may call none. */
  readOnlyThread?(threadId: string): boolean
  /** The permission mode the caller's run enforces. */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user before a relayed tool runs (`relay.approvals: 'mousse'`). */
  askApproval?: ToolRegistryOptions['askApproval']
  /** SPEC §12.6 tool ledger of the caller's run. */
  toolLedger?(runId: string): ToolLedger | undefined
}

/** The relay's `initialize` instructions: Mousse's own text, never a server's. */
export const RELAY_INSTRUCTIONS = 'This server relays the MCP servers the user set up in Mousse. Each tool is named <server>__<tool>. A call may ask the user for approval; never pass passwords, keys or tokens as arguments.'

/** A relayed tool listing a runtime sees. */
export interface RelayListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Longest arguments text an approval card shows. */
const MAX_PROMPT_ARGS_CHARS = 4_000
/** Longest error text a relayed call returns. */
const MAX_ERROR_CHARS = 2_000

/**
 * The MCP relay's `tools/list` and `tools/call` (SPEC §15.5): the catalogue's listing for the
 * credential's thread, and a call re-authorised at call time and run on the user's server.
 */
export class RelayHandler {
  constructor(private readonly host: RelayHost) {}

  /** The relayed tools the credential's thread may see: none without a relay grant, or for a read-only child. */
  list(credential: CredentialRecord): RelayListedTool[] {
    if (!credential.relay || this.host.readOnlyThread?.(credential.threadId)) return []
    return this.host.catalog
      .listing(this.host.projectPathFor(credential.threadId))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }

  /**
   * Runs a relayed tool for the credential the request resolved to. The turn is admitted as every
   * Mousse call is; a bot, definition, read-only or plan turn is refused before anything else (a
   * JSON-RPC error, no ledger row, nobody asked); the tool resolves through the catalogue and the
   * manager re-checks it is enabled now. Under `approvals: 'mousse'` the user is asked unless the
   * run's permission mode is Full access; a rejection runs nothing and writes no ledger row.
   */
  async call(name: string, rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<ToolOutcome> {
    const { credential } = request
    const { threadId, active, turn, args } = await this.host.registry.admit(rawArgs, request)
    const grant = credential.relay
    if (!grant || turn.bot) throw unknownTool(name)
    if (turn.definition) throw new McpToolError('mousse_scope_denied', 'A definition run cannot call relayed MCP tools.')
    if (this.host.readOnlyThread?.(threadId)) throw new McpToolError('mousse_read_only', `${name} is a relayed MCP tool; a read-only subagent cannot call it.`)
    if (turn.modeCeiling === 'plan' || credential.modeCeiling === 'plan')
      throw new McpToolError('mousse_ceiling_exceeded', `${name} is a relayed MCP tool, whose effects are unknown; a plan ceiling cannot call it.`)
    const tool = this.host.catalog.resolve(this.host.projectPathFor(threadId), name)
    if (!tool) throw unknownTool(name)
    const allowed = await this.host.manager.isToolCallAllowed(tool.providerName, turn.projectPath, turn.actor)
    if (!allowed.allowed) return { text: allowed.reason ?? 'MCP tool is not enabled for this actor.', isError: true }

    if (grant.approvals === 'mousse') {
      // Unknown mode: asked as under the default mode; only Full access runs a relayed tool unasked.
      const mode = this.host.permissionModeFor?.(active) ?? turn.permissionMode ?? DEFAULT_PERMISSION_MODE
      if (!permissionModeAllows(mode, 'tool')) {
        if (turn.approvals === 'never') return { text: APPROVALS_REFUSED_MESSAGE, isError: true }
        const refusal = await this.askBeforeRunning(threadId, tool, args, turn.projectPath, request)
        if (refusal) return refusal
      }
    }

    // The call's own timeout starts here, after any approval wait.
    const ledger = this.host.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: request.toolCallId, name, arguments: args } as ToolCall)
    let outcome: ToolOutcome
    try {
      const result = await this.host.manager.callTool(tool.providerName, args, turn.projectPath, request.signal, turn.actor, undefined, { timeoutMs: RELAY_CALL_TIMEOUT_MS })
      outcome = capped(userMcpOutcome(result))
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      return { text: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS), isError: true }
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
  }

  /**
   * The outcome a rejected relayed call gets instead of running: null when the user allowed it once.
   * As `ToolRegistry.askBeforeEditing`: an owner that cannot ask rejects, and so does a call whose
   * request or credential ended while it waited.
   */
  private async askBeforeRunning(threadId: string, tool: RelayTool, args: Record<string, unknown>, cwd: string | undefined, request: McpCallRequest): Promise<ToolOutcome | null> {
    const label = `${tool.serverName}/${tool.toolName}`
    const rejected: ToolOutcome = { text: `The user did not approve ${label}, so it did not run. Do not retry it unless they ask.`, isError: true }
    if (!this.host.askApproval) return rejected
    const { signal } = request
    try {
      const answers = await this.host.askApproval(
        threadId,
        [{
          id: 'permission',
          prompt: `Allow ${tool.serverName} / ${tool.toolName} (MCP server relayed by Mousse)?\n\n${argumentsText(args)}`,
          options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }]
        }],
        {
          signal,
          approval: {
            action: 'tool',
            permissionKey: relayPermissionKey(tool.installationId),
            options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
            tool: { name: label, input: args, ...(cwd ? { cwd } : {}) }
          }
        }
      )
      if (answers.permission === 'allow' && !signal.aborted && request.credential.current()) return null
      const why = typeof answers.feedback === 'string' ? answers.feedback.trim().slice(0, 1000) : ''
      return why ? { text: `${rejected.text} Reason: ${why}`, isError: true } : rejected
    } catch {
      return rejected
    }
  }
}

function unknownTool(name: string): McpToolError {
  return new McpToolError('mousse_unknown_tool', `No relayed MCP tool named ${name}.`)
}

function argumentsText(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2) ?? '{}'
  return text.length > MAX_PROMPT_ARGS_CHARS ? `${text.slice(0, MAX_PROMPT_ARGS_CHARS)}…` : text
}

/** A relayed result's text, cut to `RELAY_MAX_RESULT_CHARS`. */
function capped(outcome: ToolOutcome): ToolOutcome {
  if (outcome.text.length <= RELAY_MAX_RESULT_CHARS) return outcome
  const cut = outcome.text.length - RELAY_MAX_RESULT_CHARS
  return { ...outcome, text: `${outcome.text.slice(0, RELAY_MAX_RESULT_CHARS)}\n[${cut} more characters were cut]` }
}
