import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '@earendil-works/pi-ai'
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import type { OneShotEvents } from '../oneShot/route'
import { assertAssistantResponseSucceeded, consumeAssistantStream } from '../drivers/pi/stream'

/** xAI's API, where Grok sends a request made with an xAI API key. */
export const XAI_API_BASE_URL = 'https://api.x.ai/v1'

/**
 * The default model Grok's own config names: `default` in the `[models]` table of `<home>/config.toml`. Undefined when
 * the file or the key is missing.
 */
export function grokConfiguredDefault(home: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
  let table = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const header = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line)
    if (header) {
      table = header[1]!
      continue
    }
    const value = table === 'models' ? /^default\s*=\s*"([^"]+)"$/.exec(line) : undefined
    if (value?.[1]?.trim()) return value[1].trim()
    const dotted = table === '' ? /^models\.default\s*=\s*"([^"]+)"$/.exec(line) : undefined
    if (dotted?.[1]?.trim()) return dotted[1].trim()
  }
  return undefined
}

/** pi-ai's Responses transport; tests substitute it. */
export type GrokDirectStream = typeof responsesStream

/**
 * `grok:direct`: a single request as one direct request with no tools to xAI's API, for a Grok entry signed in with an
 * xAI API key, in Mousse's process. Mousse builds it (its system text and one user message), so nothing of Grok's setup
 * is in it: its config, instructions, rules and MCP servers are never read. The key is only sent as the request's
 * credential, never kept, logged or written. One attempt (no retry in pi-ai or the OpenAI client; counted at a stub),
 * stopped by `signal`.
 */
export async function runGrokDirectOneShot(
  request: { model: string; key: string; system: string; prompt: string; events: Pick<OneShotEvents, 'activity' | 'text' | 'sending'>; baseUrl?: string },
  signal: AbortSignal,
  send: GrokDirectStream = responsesStream
): Promise<string> {
  const { events } = request
  const { baseId, effort } = parseThinkingSuffixFromModelId(request.model)
  const model: Model<'openai-responses'> = {
    id: baseId,
    name: baseId,
    api: 'openai-responses',
    provider: 'xai',
    baseUrl: request.baseUrl ?? XAI_API_BASE_URL,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // No reasoning field unless a level is named: the model then uses its own default.
    reasoning: Boolean(effort),
    contextWindow: 0,
    maxTokens: 0
  }
  const context = normalizeContext({
    systemPrompt: request.system,
    messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }]
  })
  events.activity()
  events.sending()
  const stream = send(model, context, {
    apiKey: request.key,
    signal,
    maxRetries: 0,
    cacheRetention: 'none',
    ...(effort ? { reasoningEffort: effort as never } : {})
  })
  // Each new part of the text as it streams, for the runner's cap: the events carry each block's text so far.
  const seen = new Map<number, number>()
  const onText = (event: { phase: string; content: string; contentIndex: number }) => {
    if (event.phase !== 'delta') return
    const before = seen.get(event.contentIndex) ?? 0
    seen.set(event.contentIndex, event.content.length)
    if (event.content.length > before) events.text(event.content.slice(before))
  }
  const message = await consumeAssistantStream(stream, { onText }, { signal, onProgress: () => events.activity() })
  signal.throwIfAborted()
  assertAssistantResponseSucceeded(message)
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}
