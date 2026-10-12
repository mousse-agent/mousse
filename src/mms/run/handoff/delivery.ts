import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai'
import type { HandoffPlan } from './HandoffService'

/**
 * How a planned handoff reaches the provider (docs/run-engine/SPEC.md §16.1 Delivery): adapters with
 * `historyInjection: 'native'` receive the selected items as transcript messages; the others receive
 * a `<handoff>` block in front of the prompt. Both carry the recovery pointer when items were left out.
 */
type DeliverablePlan = Pick<HandoffPlan, 'strategy' | 'history' | 'pointer' | 'record'>

function coveredRange(plan: DeliverablePlan): string {
  const { coveredFromOrdinal: from, coveredToOrdinal: to } = plan.record
  if (from === null || to === null) return 'none'
  return from === to ? String(from) : `${from}-${to}`
}

/** `<handoff strategy=… covered=…>` with one line group per item, then the pointer. */
export function renderHandoffBlock(plan: DeliverablePlan): string {
  const items = plan.history.map((item) => `[${item.role}${item.compacted ? ', compacted' : ''}] ${item.text}`)
  const lines = [
    `<handoff strategy="${plan.strategy}" covered="${coveredRange(plan)}" items="${plan.record.selectedItems}/${plan.record.selectedItems + plan.record.omittedItems}">`,
    ...items,
    '</handoff>'
  ]
  if (plan.pointer) lines.push(plan.pointer)
  return lines.join('\n')
}

/** The prompt of a prompt-injected runtime with the handoff block in front. */
export function promptWithHandoff(plan: DeliverablePlan, prompt: string): string {
  return `${renderHandoffBlock(plan)}\n\n${prompt}`
}

function userText(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistantText(text: string, plan: DeliverablePlan): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: plan.record.toRef.provider,
    model: plan.record.toRef.model ?? 'handoff',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

/**
 * The selected items as transcript messages for a transcript-native runtime, oldest first. A first
 * user message opens with a one-line handoff header (and the pointer); consecutive items of one
 * role are joined so roles alternate. Empty when nothing was selected and nothing was omitted.
 */
export function handoffMessages(plan: DeliverablePlan): Message[] {
  const header = `[Context handoff: strategy=${plan.strategy}, covered=${coveredRange(plan)}.${plan.pointer ? ` ${plan.pointer}` : ''}]`
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const item of plan.history) {
    const last = turns.at(-1)
    if (last && last.role === item.role) last.text = `${last.text}\n\n${item.text}`
    else turns.push({ role: item.role, text: item.text })
  }
  if (!turns.length && !plan.pointer) return []
  if (turns[0]?.role === 'user') turns[0].text = `${header}\n\n${turns[0].text}`
  else turns.unshift({ role: 'user', text: header })
  return turns.map((turn) => (turn.role === 'user' ? userText(turn.text) : assistantText(turn.text, plan)))
}
