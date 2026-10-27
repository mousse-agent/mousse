import type { AgentRuntimePolicy, AgentRuntimeToolApprovalCallback } from '../../shared/agents/execution'
import type { EffectiveAgentGrants } from '../../shared/agents/types'
import type { McpToolDescriptor } from '../../shared/integrations'
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
 * Calls a runtime's tool gate already authorized in full (approval included) for app or MCP tools
 * that run later through the Mousse MCP registry: by call id, the digest of the authorized
 * arguments. The registry takes each once, so approval is asked once per call.
 */
const AUTHORIZED = new WeakMap<DefinitionAuthority, Map<string, string>>()

/** The gate authorized `callId` with `args` in full; the registry's dispatch may take it once. */
export function recordAuthorizedCall(authority: DefinitionAuthority, callId: string, args: Record<string, unknown>): void {
  let calls = AUTHORIZED.get(authority)
  if (!calls) AUTHORIZED.set(authority, (calls = new Map()))
  calls.set(callId, digestToolArguments(args))
}

/**
 * At dispatch: whether `callId` was authorized in full with exactly these arguments. The record is
 * taken (one dispatch per authorization).
 */
export function takeAuthorizedCall(authority: DefinitionAuthority, callId: string, args: Record<string, unknown>): boolean {
  const calls = AUTHORIZED.get(authority)
  const digest = calls?.get(callId)
  if (digest === undefined) return false
  calls!.delete(callId)
  return digest === digestToolArguments(args)
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
