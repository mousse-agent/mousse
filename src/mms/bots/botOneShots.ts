import { BOT_CHAT_DIGEST } from '../../shared/bots/personal/memory'
import type { HarnessGateway } from '../harness/gateway'

/**
 * A bot's own single requests on the gateway (`HarnessGateway.oneShot`): naming a new bot, and the digest of its chat.
 * Each names its operation, so a bot-only entry (a locked one) serves them while it never names a thread.
 */

interface BotSelection {
  instanceId: string
  model: string
  effort?: string
}

/** Naming a new bot: one short call on the model its activations would use. */
export async function botNameOneShot(harness: Pick<HarnessGateway, 'oneShot'>, input: { selection: BotSelection; prompt: string; signal?: AbortSignal }): Promise<string> {
  const { selection } = input
  return (await harness.oneShot({
    selection: { instanceId: selection.instanceId, llmProvider: selection.instanceId.split(':')[0] ?? '', model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) },
    ...(input.signal ? { signal: input.signal } : {}),
    purpose: 'title',
    op: 'bot_name',
    system: 'Name a helper in 2–3 words.',
    prompt: input.prompt,
    maxChars: 60
  })).text
}

/** The digest of a fold of a bot's chat (docs/plans/bot-context.md §14): one call with no tools on the bot's chat model. */
export async function botDigestOneShot(harness: Pick<HarnessGateway, 'oneShot'>, input: { selection: BotSelection; system: string; prompt: string; signal?: AbortSignal }): Promise<string> {
  const { selection } = input
  return (await harness.oneShot({
    selection: { instanceId: selection.instanceId, llmProvider: selection.instanceId.split(':')[0] ?? '', model: selection.model },
    ...(input.signal ? { signal: input.signal } : {}),
    purpose: 'title',
    task: 'chat_digest',
    system: input.system,
    prompt: input.prompt,
    maxChars: BOT_CHAT_DIGEST.digest * 8
  })).text
}
