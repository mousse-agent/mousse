/** Host-created dependency pins. These are never accepted from public run DTOs. */
export interface WorkflowExecutionBindings {
  version: 1
  profileId: string
  skills: Array<{
    requestedId: string
    installationId: string
    requestedRevision?: string
    revision: string
    name: string
    /** Exact admitted SKILL.md bytes represented as UTF-8 text. */
    content: string
    contentHash: string
  }>
  mcpTools: Array<{
    requestedServerId: string
    installationId: string
    toolName: string
    configRevision: string
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
  }>
}

export const WORKFLOW_EXECUTION_BINDINGS_MAX_BYTES = 8 * 1024 * 1024
