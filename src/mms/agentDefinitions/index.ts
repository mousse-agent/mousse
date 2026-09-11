import { AgentDefinitionRegistry, type AgentDefinitionRegistryOptions } from './AgentDefinitionRegistry'
import { AgentResolver } from './AgentResolver'
import type { AgentIntegrationLookup, AgentModelLookup } from '../../shared/agents/types'
import { AgentExecutionService, createAgentExecutionService } from './AgentExecutionService'

export { AgentDefinitionRegistry } from './AgentDefinitionRegistry'
export type { AgentDefinitionRegistryOptions } from './AgentDefinitionRegistry'
export { AgentResolver } from './AgentResolver'
export type { AgentResolverOptions } from './AgentResolver'
export { AgentExecutionService, createAgentExecutionService } from './AgentExecutionService'
export { createCliProcessRuntime } from './cliRuntime'
export type { CliProcessInvocation, CliProcessRuntimeOptions } from './cliRuntime'
export type {
  AgentExecutionBindings,
  AgentExecutionBudget,
  AgentExecutionHistoryEntry,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntimeInput,
  AgentRuntimeResult,
  NativeAgentRuntimePort,
  CliAgentRuntimePort
} from '../../shared/agents/execution'
export {
  BUILTIN_CLI_ENGINE_IDS,
  describeRuntimeAgentLink,
  isBuiltinCliEngineId
} from './adapters'
export type {
  AgentDefinitionExecutionContext,
  AgentDefinitionHostBindings,
  AgentRunnerPort
} from './adapters'
export { StaticAgentIntegrationLookup, StaticAgentModelLookup } from './lookups'
export type { StaticIntegrationState, StaticModelEntry } from './lookups'

export interface AgentDefinitionServices {
  registry: AgentDefinitionRegistry
  resolver: AgentResolver
  execution: AgentExecutionService
}

export function createAgentDefinitionServices(options: AgentDefinitionRegistryOptions & {
  modelLookup: AgentModelLookup
  integrationLookup: AgentIntegrationLookup
  execution?: import('../../shared/agents/execution').AgentExecutionBindings
}): AgentDefinitionServices {
  const registry = new AgentDefinitionRegistry(options)
  const resolver = new AgentResolver({
    registry,
    modelLookup: options.modelLookup,
    integrationLookup: options.integrationLookup
  })
  return { registry, resolver, execution: createAgentExecutionService(options.execution ?? {}) }
}
