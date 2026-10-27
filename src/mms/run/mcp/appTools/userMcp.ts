import { Type, type Tool, type ToolCall, type TSchema } from '@earendil-works/pi-ai'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { McpToolCallResult } from '../../../../shared/integrations/results'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { LlmToolEvent } from '../../../harness/turnEvents'
import { truncateForDisplay, type ToolTimeline } from './types'

/**
 * The user's own MCP servers, proxied by Mousse (`mcpManager`). Runtimes that attach them natively
 * (Claude Code, Codex, ACP) keep doing so (`TurnBridge.userMcp = 'native'`); a runtime Mousse feeds
 * tools to (the pi loop, and the Pi RPC engine) gets them as proxied tools through here.
 */

export function toTypeboxSchema(schema: Record<string, unknown> | undefined): TSchema {
  if (schema && schema.type === 'object') return schema as unknown as TSchema
  return Type.Object({}, { additionalProperties: true })
}

/** A user MCP tool as the pi-ai tool a proxied runtime is sent. */
export function userMcpTool(tool: McpToolDescriptor): Tool {
  return {
    name: tool.providerName,
    description: tool.description || `Call ${tool.toolName} on MCP server ${tool.serverName}.`,
    parameters: toTypeboxSchema(tool.inputSchema)
  }
}

/** An MCP result as pi-ai tool-result content: text, images (inline only) and readable stand-ins. */
export function mcpResultToToolContent(result: McpToolCallResult): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image' && block.data) {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      continue
    }
    if (block.type === 'image') {
      blocks.push({
        type: 'text',
        text: `[image ${block.mimeType}${block.bytes ? `, ${block.bytes} bytes` : ''}${block.artifactId ? `; artifact=${block.artifactId}` : ''}]`
      })
      continue
    }
    if (block.type === 'resource_link') {
      blocks.push({ type: 'text', text: `[resource ${block.uri}]` })
      continue
    }
    if (block.type === 'resource') {
      blocks.push({ type: 'text', text: block.text ?? `[resource ${block.uri ?? 'untyped'}]` })
      continue
    }
    blocks.push({ type: 'text', text: `[${block.rawType}]` })
  }
  if (result.structuredContent !== undefined) {
    blocks.push({
      type: 'text',
      text: `structuredContent: ${JSON.stringify(result.structuredContent)}`
    })
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: result.text || (result.isError ? 'MCP tool returned an error.' : '') })
  }
  return blocks
}

export type UserMcpOutcome =
  | { kind: 'refused'; text: string }
  | { kind: 'result'; content: Array<Record<string, unknown>>; isError: boolean }

/**
 * Calls one proxied user MCP tool: the actor's grant is checked again at call time, the call is
 * written to the timeline, and the caller's abort reaches the server.
 */
export async function callUserMcpTool(input: {
  manager: McpManager
  tool: McpToolDescriptor
  call: ToolCall
  projectPath: string | undefined
  actor: IntegrationActor
  signal?: AbortSignal
  timeline?: ToolTimeline
  markEffect?: () => void
}): Promise<UserMcpOutcome> {
  const { manager, tool, call, projectPath, actor, signal, timeline } = input
  if (typeof manager.isToolCallAllowed === 'function') {
    const allowed = await manager.isToolCallAllowed(tool.providerName, projectPath, actor)
    if (!allowed.allowed) return { kind: 'refused', text: allowed.reason ?? 'MCP tool is not enabled for this actor.' }
  }
  const callEvent: LlmToolEvent = {
    kind: 'mcp_tool_call',
    title: `Called ${tool.serverName}.${tool.toolName}`,
    summary: 'The orchestrator called an MCP tool.',
    details: [`Server: ${tool.serverName}`, `Tool: ${tool.toolName}`],
    response: JSON.stringify(call.arguments, null, 2)
  }
  timeline?.record(callEvent, 'start')
  input.markEffect?.()
  const result = await manager.callTool(call.name, call.arguments, projectPath, signal, actor)
  timeline?.record({
    kind: 'mcp_tool_result',
    title: `Called ${tool.serverName}.${tool.toolName}`,
    summary: result.isError ? 'The MCP tool returned an error.' : 'The MCP tool returned successfully.',
    details: [
      `Server: ${tool.serverName}`,
      `Tool: ${tool.toolName}`,
      `Installation: ${result.provenance?.installationId ?? tool.installationId ?? tool.serverId}`
    ],
    response: truncateForDisplay(result.text)
  }, 'complete')
  return { kind: 'result', content: mcpResultToToolContent(result), isError: Boolean(result.isError) }
}
