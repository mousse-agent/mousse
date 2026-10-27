import type { AgentExecutionHistoryEntry } from '../../shared/agents/execution'
import type { EffectiveAgentGrants } from '../../shared/agents/types'
import type { IntegrationActor } from '../../shared/integrations/actor'
import type { StreamingLlmTextEvent, StreamingLlmToolEvent } from '../harness/turnEvents'
import type { ProviderMetrics, TurnResult } from '../harness/gateway'

/**
 * What a definition turn did, from its own events (PR 4 §6 "Result"): the assistant text by content
 * index, each tool as `{role: 'tool', name, content: summary}`, and usage. A definition's history is
 * built from this record, never from a runtime's native transcript.
 */
export class DefinitionTurnRecord {
  private readonly entries: AgentExecutionHistoryEntry[] = []
  /** Text of the assistant message being streamed, by content index. */
  private open = new Map<number, string>()
  private last = ''
  private cost = 0

  text(event: StreamingLlmTextEvent): void {
    const current = this.open.get(event.contentIndex) ?? ''
    if (event.phase === 'start') this.open.set(event.contentIndex, event.content)
    else if (event.phase === 'delta') this.open.set(event.contentIndex, current + event.content)
    else this.open.set(event.contentIndex, event.content || current)
  }

  tool(event: StreamingLlmToolEvent): void {
    // Text streamed before a tool call is an assistant message of its own.
    if (event.phase === 'start') this.flush()
    if (event.phase !== 'complete' || event.kind === 'skill_loaded') return
    this.entries.push({ role: 'tool', name: event.title, content: event.summary, at: new Date().toISOString() })
  }

  metrics(metrics: ProviderMetrics): void {
    const total = metrics.usage?.cost?.total
    if (typeof total === 'number' && Number.isFinite(total)) this.cost = total
  }

  /** The text streamed last, for a runtime whose result carries none. */
  finalText(): string {
    return this.joined() || this.last
  }

  /** The turn's history: the user message, assistant text and tools in order, ending with `text`. */
  history(user: string, text: string): AgentExecutionHistoryEntry[] {
    this.open = new Map()
    const at = new Date().toISOString()
    const entries = [{ role: 'user' as const, content: user, at }, ...this.entries]
    if (text) entries.push({ role: 'assistant', content: text, at })
    return entries
  }

  usage(usage: TurnResult['usage'] | undefined): { inputTokens: number; outputTokens: number; costUsd: number } {
    return { inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0, costUsd: this.cost }
  }

  private joined(): string {
    return [...this.open.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
  }

  private flush(): void {
    const text = this.joined().trim()
    this.open = new Map()
    if (!text) return
    this.last = text
    this.entries.push({ role: 'assistant', content: text, at: new Date().toISOString() })
  }
}

/** The integration actor of a definition run: only its granted skills and MCP tools are visible. */
export function definitionActor(grants: EffectiveAgentGrants): IntegrationActor {
  return {
    kind: 'agent',
    agentType: 'mousse',
    skillIds: grants.skills.map((grant) => grant.id),
    mcpServerIds: [...new Set(grants.mcpTools.map((grant) => grant.serverId))],
    mcpToolIds: grants.mcpTools.map((grant) => grant.id)
  }
}
