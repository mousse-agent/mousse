import type { Api, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai'
import { harnessAppError } from '../../../../shared/harness/types'
import { parseThinkingSuffixFromModelId } from '../../../../shared/modelVariants'
import { customModelDefinition } from '../../catalog'
import type { OneShotSpec } from '../../driver'
import { PI_AWS_RETRY_ENV } from '../../pi/launch'
import { assertAssistantResponseSucceeded, consumeAssistantStream, getCacheSessionId, getReasoningStreamOptions } from './stream'

/** What a pi one-shot reads of the profile's pi-ai models: the catalogue, credentials and transport. */
export type PiOneShotModels = Pick<Models, 'getModel' | 'getModels' | 'getAuth' | 'stream' | 'streamSimple'>

/**
 * One pi-ai request with no tools, in Mousse's process (a chat title): the provider's catalogue model
 * (or the user's custom model on the provider's transport), its credentials as `ProviderAuthService`
 * keeps and refreshes them, and the reply's text. Not a loop: one request, no retry.
 */
export async function runPiOneShot(models: PiOneShotModels, providerId: string, spec: OneShotSpec, signal: AbortSignal): Promise<{ text: string }> {
  const { baseId, effort } = parseThinkingSuffixFromModelId(spec.model)
  const model = models.getModel(providerId, baseId) ?? customModel(models, providerId, spec)
  if (!model)
    throw harnessAppError({ code: 'model_unavailable', message: `${baseId} is not a model of this provider. Refresh models or choose another one.` })
  // Reading the credentials may refresh a sign-in over the network: the timeout and a stop bound it too.
  if (!(await untilAborted(models.getAuth(model), signal)))
    throw harnessAppError({ code: 'signed_out', message: 'This provider is not signed in. Sign in or choose another model.' })
  const context = {
    systemPrompt: spec.system,
    messages: [{ role: 'user' as const, content: spec.prompt, timestamp: Date.now() }]
  }
  if (model.api === 'bedrock-converse-stream') holdBedrockToOneAttempt()
  const reasoning = (spec.effort ?? effort ?? 'off') as ThinkingLevel
  const options = getReasoningStreamOptions(model.api, reasoning, signal, getCacheSessionId(spec.sessionKey), providerId)
  spec.onActivity()
  const stream = model.api === 'openai-codex-responses'
    ? models.stream(model, context, options)
    : models.streamSimple(model, context, options as { reasoning: ThinkingLevel })
  const message = await consumeAssistantStream(stream, {}, { signal, onProgress: () => spec.onActivity() })
  assertAssistantResponseSucceeded(message)
  return { text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') }
}

/**
 * One HTTP attempt per Bedrock request, as the Pi RPC child has (`PI_AWS_RETRY_ENV`). pi-ai builds its
 * AWS client with no `maxAttempts` and takes no per-call setting for it, so the AWS SDK reads
 * `AWS_MAX_ATTEMPTS` (before the shared config file's `max_attempts`) when the request goes out;
 * `options.maxRetries` does not reach it. Mousse's process is set to one attempt and never set
 * back, so no request running at the same time reads another value. This also holds the legacy
 * loop's Bedrock requests to one SDK attempt.
 */
function holdBedrockToOneAttempt(): void {
  for (const [name, value] of Object.entries(PI_AWS_RETRY_ENV)) process.env[name] = value
}

/** `promise`, or an `AbortError` as soon as `signal` aborts (the promise itself is left to settle). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** A custom model added to the provider runs with the transport of the provider's first listed model. */
function customModel(models: PiOneShotModels, providerId: string, spec: OneShotSpec): Model<Api> | undefined {
  const template = spec.customModel ? models.getModels(providerId)[0] : undefined
  return spec.customModel && template ? customModelDefinition(template, spec.customModel) : undefined
}
