import { createInterface } from 'node:readline'
import type { PiWorkerMessage, PiWorkerRequest } from './workerProtocol'

/**
 * Pi's single-request worker (`pi:worker`): one pi-ai Bedrock request with no tool, in a process of its own, started by
 * `drivers/pi/workerOneShot.ts` in the request's place on the sealed launch and ended with it. It loads only pi-ai's
 * Bedrock stream and the AWS SDK under it: none of Pi's agent, settings or extensions.
 *
 * The AWS SDK reads `AWS_MAX_ATTEMPTS` and `AWS_RETRY_MODE` when its client is made, and pi-ai makes the client with no
 * `maxAttempts` of its own, so the launch sets both in this process's environment: the client sends a failed request
 * once. The SDK's config files are looked for in the place (its home is there), and the request carries the only
 * credentials it may use.
 *
 * It speaks NDJSON on stdin/stdout (`workerProtocol.ts`): `ready`, one request line, events, one `end`, then it exits.
 */

function send(message: PiWorkerMessage, then?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, then)
}

async function run(request: PiWorkerRequest): Promise<void> {
  const [{ streamSimple }, { normalizeContext }] = await Promise.all([import('@earendil-works/pi-ai/api/bedrock-converse-stream'), import('@earendil-works/pi-ai/utils/transcript')])
  const controller = new AbortController()
  // The parent closing stdin is a stop: the request ends with it.
  process.stdin.on('end', () => controller.abort())
  const model = request.model as unknown as Parameters<typeof streamSimple>[0]
  const stream = streamSimple(
    model,
    // No tool: the context offers none, so the request declares none.
    normalizeContext({ systemPrompt: request.system, messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }] }),
    {
      signal: controller.signal,
      ...(request.reasoning ? { reasoning: request.reasoning as never } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.bearerToken ? { apiKey: request.bearerToken } : {}),
      ...(request.env ? { env: request.env } : {})
    }
  )
  for await (const event of stream) {
    if (event.type === 'text_delta') send({ event: 'text', text: event.delta })
    else if (event.type === 'toolcall_start') {
      const block = event.partial.content[event.contentIndex] as { name?: unknown } | undefined
      send({ event: 'tool', name: typeof block?.name === 'string' && block.name ? block.name : 'a tool' })
    } else send({ event: 'activity' })
  }
  const message = await stream.result()
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  const failed = message.errorMessage && message.stopReason !== 'aborted'
  send({ event: 'end', text, ...(failed ? { error: message.errorMessage, provider: message.provider } : {}) }, () => process.exit(0))
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let started = false
lines.on('line', (line) => {
  if (started) return
  started = true
  let request: PiWorkerRequest
  try {
    request = JSON.parse(line) as PiWorkerRequest
  } catch {
    send({ event: 'end', text: '', error: 'The worker could not read its request.' }, () => process.exit(1))
    return
  }
  run(request).catch((error: unknown) => {
    send({ event: 'end', text: '', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
  })
})
send({ event: 'ready' })
