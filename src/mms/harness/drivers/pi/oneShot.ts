import type { Api, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai'
import { harnessAppError } from '../../../../shared/harness/types'
import { parseThinkingSuffixFromModelId } from '../../../../shared/modelVariants'
import { customModelDefinition } from '../../catalog'
import type { OneShotSpec } from '../../driver'
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
  // pi-ai builds its AWS client without `maxAttempts` and takes no per-call setting, so the AWS SDK
  // would retry below Mousse in this process. Bedrock one-shots wait until they run in a process
  // Mousse configures (the Pi RPC child holds Bedrock to one attempt).
  if (model.api === 'bedrock-converse-stream')
    throw harnessAppError({ code: 'unsupported', message: 'Bedrock models cannot name chats yet. Choose another model for chat titles, or Automatic.' })
  // Reading the credentials may refresh a sign-in over the network: the timeout and a stop bound it too.
  if (!(await untilAborted(() => models.getAuth(model), signal)))
    throw harnessAppError({ code: 'signed_out', message: 'This provider is not signed in. Sign in or choose another model.' })
  const context = {
    systemPrompt: spec.system,
    messages: [{ role: 'user' as const, content: spec.prompt, timestamp: Date.now() }]
  }
  const reasoning = (spec.effort ?? effort ?? 'off') as ThinkingLevel
  const options = getReasoningStreamOptions(model.api, reasoning, signal, getCacheSessionId(spec.sessionKey), providerId)
  spec.onActivity()
  const stream = models.streamSimple(model, context, options as { reasoning: ThinkingLevel })
  const message = await consumeAssistantStream(stream, {}, { signal, onProgress: () => spec.onActivity() })
  assertAssistantResponseSucceeded(message)
  return { text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') }
}

/**
 * `start()`, or an `AbortError` as soon as `signal` aborts. Nothing starts once `signal` has aborted,
 * and a started promise always has a handler, so a failure after the abort is never unhandled.
 */
function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    let promise: Promise<T>
    try {
      promise = start()
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      reject(error)
      return
    }
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** A custom model added to the provider runs with the transport of the provider's first listed model. */
function customModel(models: PiOneShotModels, providerId: string, spec: OneShotSpec): Model<Api> | undefined {
  const template = spec.customModel ? models.getModels(providerId)[0] : undefined
  return spec.customModel && template ? customModelDefinition(template, spec.customModel) : undefined
}
