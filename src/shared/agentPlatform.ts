/** Profile-bound public method names; both daemon and renderer adapters consume this list. */
export const AGENT_DEFINITION_METHODS = [
  'agentDefinitions.list', 'agentDefinitions.get', 'agentDefinitions.create',
  'agentDefinitions.saveDraft', 'agentDefinitions.publish', 'agentDefinitions.archive',
  'agentDefinitions.duplicate', 'agentDefinitions.importBundle', 'agentDefinitions.exportBundle',
  'agentDefinitions.validate', 'agentDefinitions.tryRun'
] as const
export type AgentDefinitionMethod = (typeof AGENT_DEFINITION_METHODS)[number]
export const AGENT_DEFINITION_CAPABILITY = 'agentDefinitions.v1'

/** Transport implementations preserve structured daemon error codes and trusted window binding. */
export interface AgentPlatformRequester {
  request<T>(method: AgentDefinitionMethod, params: unknown): Promise<T>
}
