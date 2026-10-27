import type { AgentRuntimePolicy, AgentRuntimeToolApprovalCallback } from '../../shared/agents/execution'
import type { EffectiveAgentGrants } from '../../shared/agents/types'
import type { McpToolDescriptor } from '../../shared/integrations'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import { authorizeTrustedToolDispatch, canonicalizeBuiltinToolName, digestToolArguments, prepareTrustedToolDispatch } from './runtimePolicy'

/**
 * A definition's authority over each tool call of its run, when the run is on a runtime with its
 * own loop (PR 4 §5a "Definition authority in the gate"). The checks are the trusted-dispatch ones
 * the in-process loop applies, unchanged: the effective-grant allowlist, `askUser`, read-only and
 * script rules, path containment in the canonical roots, unattended deny/skip/fail/pause, the host
 * approval callback, and digest and path revalidation after approval.
 *
 * Every field is host-owned and compiled before the run; none comes from the runtime.
 */
export interface DefinitionAuthority {
  policy: AgentRuntimePolicy
  /** The effective grants (inheritance resolved, workflow narrowing applied). */
  grants: EffectiveAgentGrants
  /** Answers calls that need approval; absent: such calls are refused. */
  approve?: AgentRuntimeToolApprovalCallback
  /** The user's MCP tools the run can see, by the name the runtime calls them. */
  mcpTools?: readonly McpToolDescriptor[]
}

/**
 * The digest a definition turn's policy names its authority by (`RunPolicy.authority.digest`): the
 * pinned definition and its effective grants. Admission compares it with the registered authority.
 */
export function definitionAuthorityDigest(authority: Pick<DefinitionAuthority, 'policy' | 'grants'>): string {
  return sha256Hex(canonicalJson({ definitionId: authority.policy.definitionId, revision: authority.policy.definitionRevision, grants: authority.grants }))
}

export type DefinitionDecision = { allowed: true } | { allowed: false; message: string }

/** Whether `toolName` is in the definition's effective grants (a user MCP tool by server and tool). */
export function definitionToolGranted(toolName: string, grants: EffectiveAgentGrants, mcpTools: readonly McpToolDescriptor[] = []): boolean {
  const mcp = mcpTools.find((tool) => tool.providerName === toolName)
  if (mcp)
    return grants.mcpTools.some((grant) => (grant.serverId === mcp.serverId || grant.serverId === mcp.installationId) && grant.toolName === mcp.toolName)
  const canonical = canonicalizeBuiltinToolName(toolName)
  return grants.builtinTools.some((grant) => grant.id === toolName || grant.id === canonical || canonicalizeBuiltinToolName(grant.id) === canonical)
}

/**
 * Why the definition refuses a call outright (not granted, or refused by its policy before any
 * approval), or undefined when it may go on to approval. It asks nobody.
 */
export function definitionRefusal(authority: DefinitionAuthority, call: { toolName: string; args: Record<string, unknown>; projectPath?: string }): string | undefined {
  if (!definitionToolGranted(call.toolName, authority.grants, authority.mcpTools)) return `Tool "${call.toolName}" is not granted to this agent definition.`
  const prepared = prepareTrustedToolDispatch({
    policy: authority.policy,
    grants: authority.grants,
    toolName: call.toolName,
    args: call.args,
    isMcp: (authority.mcpTools ?? []).some((tool) => tool.providerName === call.toolName),
    ...(call.projectPath ? { projectPath: call.projectPath } : {})
  })
  return prepared.allowed ? undefined : prepared.message ?? 'Tool dispatch denied.'
}

/**
 * Fields a transport adds to, rewrites in or strips from a tool call's arguments before the tool
 * sees them: the call id (Pi's extension overwrites it with its own; the Mousse MCP server strips
 * it) and the turn tokens (the registry strips them). They are never part of what is approved.
 */
const TRANSPORT_FIELDS = ['clientRequestId', '_mousse_turn', '_mousse_attempt'] as const

/** The arguments a tool runs with, as approval sees them: without transport fields. */
export function withoutTransportFields(args: Record<string, unknown>): Record<string, unknown> {
  const call = { ...args }
  for (const field of TRANSPORT_FIELDS) delete call[field]
  return call
}

/** One app or MCP tool call a runtime's gate authorized, as the registry later receives it. */
export interface AuthorizedCall {
  /** The turn token the call is stamped with (`_mousse_turn`, or the attempt token). */
  turnToken: string
  toolName: string
  /** The runtime's tool call id (the MCP server's `clientRequestId`). */
  callId: string
  /** The arguments, without transport fields. */
  args: Record<string, unknown>
}

/**
 * Calls a runtime's tool gate already authorized in full (approval included) for app or MCP tools
 * that run later through the Mousse MCP registry, keyed by turn token, tool (and MCP server), and
 * call id; the value is the digest of the authorized arguments. The registry takes each once, so
 * approval is asked once per call, and an approval never covers another tool, turn or argument set.
 */
const AUTHORIZED = new WeakMap<DefinitionAuthority, Map<string, string>>()

function authorizedKey(authority: DefinitionAuthority, call: AuthorizedCall): string {
  const mcp = (authority.mcpTools ?? []).find((tool) => tool.providerName === call.toolName)
  const tool = mcp ? `mcp:${mcp.installationId ?? mcp.serverId}:${mcp.toolName}` : `tool:${call.toolName}`
  return JSON.stringify([call.turnToken, tool, call.callId])
}

/** The gate authorized `call` in full; the registry's dispatch of exactly that call may take it once. */
export function recordAuthorizedCall(authority: DefinitionAuthority, call: AuthorizedCall): void {
  let calls = AUTHORIZED.get(authority)
  if (!calls) AUTHORIZED.set(authority, (calls = new Map()))
  calls.set(authorizedKey(authority, call), digestToolArguments(withoutTransportFields(call.args)))
}

/**
 * At dispatch: whether exactly this call (turn, tool, call id, arguments) was authorized in full.
 * The record is taken: one dispatch per authorization.
 */
export function takeAuthorizedCall(authority: DefinitionAuthority, call: AuthorizedCall): boolean {
  const calls = AUTHORIZED.get(authority)
  const key = authorizedKey(authority, call)
  const digest = calls?.get(key)
  if (digest === undefined) return false
  calls!.delete(key)
  return digest === digestToolArguments(withoutTransportFields(call.args))
}

/**
 * One call under the definition's authority: granted, prepared, approved when the policy says so,
 * and revalidated. `args` are the arguments the call runs with; the caller never changes them
 * after this check.
 */
export async function authorizeDefinitionCall(
  authority: DefinitionAuthority,
  call: { toolName: string; args: Record<string, unknown>; projectPath?: string; signal?: AbortSignal }
): Promise<DefinitionDecision> {
  if (!definitionToolGranted(call.toolName, authority.grants, authority.mcpTools))
    return { allowed: false, message: `Tool "${call.toolName}" is not granted to this agent definition.` }
  const isMcp = (authority.mcpTools ?? []).some((tool) => tool.providerName === call.toolName)
  const base = {
    policy: authority.policy,
    grants: authority.grants,
    toolName: call.toolName,
    args: call.args,
    isMcp,
    ...(call.projectPath ? { projectPath: call.projectPath } : {})
  }
  const prepared = prepareTrustedToolDispatch(base)
  const authorized = await authorizeTrustedToolDispatch({
    ...base,
    prepared,
    ...(call.signal ? { signal: call.signal } : {}),
    ...(authority.approve ? { approveToolRequest: authority.approve } : {})
  })
  return authorized.allowed ? { allowed: true } : { allowed: false, message: authorized.message }
}
