import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ReplayMismatchError, type ReplayTransport } from './ReplayTransport'

/**
 * Agent SDK boundary: the `query()` seam of `ClaudeSubscriptionProviderService`
 * (`dependencies.query`). The SDK's own process protocol sits below it, so frames are SDK values:
 *
 * - out `{ kind: 'query', prompt, options }`: the user messages streamed in (role and content) and
 *   the options that change the session (model, effort, resume, permission mode, MCP servers).
 *   Paths, environment, hooks and callbacks are left out.
 * - in: an `SDKMessage` the query yields. The query ends where the next outbound frame is another
 *   `query` (or the transcript ends).
 * - out `{ kind: 'interrupt' }`: `Query.interrupt()` (steer delivery).
 * - in `{ kind: 'throw', message }`: the query's iterator throws.
 */
export const SDK_QUERY_BOUNDARY = 'Agent SDK query() seam: request projection out; SDK messages in'

type QueryInput = { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }

const isQueryFrame = (frame: unknown): boolean =>
  Boolean(frame && typeof frame === 'object' && (frame as { kind?: unknown }).kind === 'query')

async function promptMessages(prompt: QueryInput['prompt']): Promise<unknown[]> {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }]
  const messages: unknown[] = []
  for await (const message of prompt) messages.push({ role: message.message.role, content: message.message.content })
  return messages
}

export function replaySdkQuery(transport: ReplayTransport): (input: QueryInput) => Query {
  return ({ prompt, options }) => {
    let closed = false
    const messages = (async function* (): AsyncGenerator<SDKMessage> {
      transport.send({
        kind: 'query',
        prompt: await promptMessages(prompt),
        options: {
          model: options.model,
          effort: options.effort,
          resume: options.resume,
          permissionMode: options.permissionMode,
          mcpServers: options.mcpServers
        }
      })
      for (;;) {
        if (closed) return
        const frame = await transport.receive(isQueryFrame)
        if (frame === undefined || closed) return
        if ((frame as { kind?: unknown }).kind === 'throw')
          throw new Error(String((frame as { message?: unknown }).message ?? 'Replayed SDK failure'))
        yield frame as SDKMessage
      }
    })()
    return Object.assign(messages, {
      close: (): void => {
        closed = true
      },
      interrupt: async (): Promise<void> => {
        if (closed) throw new ReplayMismatchError('interrupt() after close()')
        transport.send({ kind: 'interrupt' })
      }
    }) as unknown as Query
  }
}
