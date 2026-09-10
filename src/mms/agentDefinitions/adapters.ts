import type { AgentTypeId } from '../../shared/settings'
import { AGENT_RUNTIME_KINDS, type AgentRuntimeKind, type ResolvedAgentDefinition } from '../../shared/agents/types'

/**
 * Existing CLI engine IDs. Keep these aligned with `AgentTypeId` / runtime `Agent.cliType`.
 * This module does not spawn agents or replace AgentRegistry.
 */
export const BUILTIN_CLI_ENGINE_IDS: readonly AgentTypeId[] = AGENT_RUNTIME_KINDS

export function isBuiltinCliEngineId(value: string): value is AgentRuntimeKind {
  return (BUILTIN_CLI_ENGINE_IDS as readonly string[]).includes(value)
}

/** Context the host must pass from validated dispatch. Root owns protocol/IPC wiring. */
export interface AgentDefinitionExecutionContext {
  profileId: string
  threadId: string
  turnId?: string
  source: 'gui' | 'cli' | 'schedule' | 'channel' | 'control'
  task: string
}

/**
 * Port for root to attach existing native/CLI runners.
 * Implementations must use existing AgentRegistry / MousseAgentService / CLI spawners.
 * Do not invent a second native agent loop here.
 */
export interface AgentRunnerPort {
  runtimeKind: AgentRuntimeKind
  start(
    resolved: ResolvedAgentDefinition,
    context: AgentDefinitionExecutionContext
  ): Promise<{ runtimeAgentId: string }>
}

export interface AgentDefinitionHostBindings {
  runners: Partial<Record<AgentRuntimeKind, AgentRunnerPort>>
}

export function describeRuntimeAgentLink(resolved: ResolvedAgentDefinition): {
  definitionId: string
  definitionRevision: string
  cliType: AgentRuntimeKind
} {
  return {
    definitionId: resolved.definitionId,
    definitionRevision: resolved.revision,
    cliType: resolved.runtimeKind
  }
}
