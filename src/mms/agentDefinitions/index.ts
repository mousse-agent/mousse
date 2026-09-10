import { AgentDefinitionRegistry, type AgentDefinitionRegistryOptions } from './AgentDefinitionRegistry'
import { AgentResolver } from './AgentResolver'
import type { AgentIntegrationLookup, AgentModelLookup } from '../../shared/agents/types'

export { AgentDefinitionRegistry } from './AgentDefinitionRegistry'
export type { AgentDefinitionRegistryOptions } from './AgentDefinitionRegistry'
export { AgentResolver } from './AgentResolver'
export type { AgentResolverOptions } from './AgentResolver'
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
}

export function createAgentDefinitionServices(options: AgentDefinitionRegistryOptions & {
  modelLookup: AgentModelLookup
  integrationLookup: AgentIntegrationLookup
}): AgentDefinitionServices {
  const registry = new AgentDefinitionRegistry(options)
  const resolver = new AgentResolver({
    registry,
    modelLookup: options.modelLookup,
    integrationLookup: options.integrationLookup
  })
  return { registry, resolver }
}
