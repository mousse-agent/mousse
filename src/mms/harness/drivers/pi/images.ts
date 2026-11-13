import type { AssistantImages, ImageApi, ImageModel, Models } from '@earendil-works/pi-ai'
import { harnessAppError } from '../../../../shared/harness/types'
import { ImageRequestError, type GeneratedImage, type ImageFailureKind, type ImageModelFacts, type ImageRequestSpec } from '../../driver'

/** What a pi image request reads of the profile's pi-ai models: the image catalogue, credentials and the request. */
export type PiImageModels = Pick<Models, 'getModelsOfType' | 'getModelOfType' | 'getAuth' | 'generateImages'>

/**
 * Image models that choose another model themselves (OpenRouter's `openrouter/auto`): never offered, since a bot's
 * picture runs on the model its owner picked or not at all.
 */
function routes(model: Pick<ImageModel<ImageApi>, 'id'>): boolean {
  return /^openrouter\//.test(model.id) || /(^|\/)auto(-[a-z]+)?$/.test(model.id)
}

/**
 * The provider's image models in pi-ai's catalogue (#1088): only those whose output is a picture, without models that
 * route to another one, with USD per token from the catalogue (per million there).
 */
export function piImageModels(models: Pick<Models, 'getModelsOfType'>, providerId: string): ImageModelFacts[] {
  let listed: readonly ImageModel<ImageApi>[]
  try {
    listed = models.getModelsOfType('image', providerId)
  } catch {
    return []
  }
  return listed
    .filter((model) => model.output.includes('image') && !routes(model))
    .map((model) => ({ id: model.id, label: model.name || model.id, price: { input: (model.cost?.input ?? 0) / 1e6, output: (model.cost?.output ?? 0) / 1e6 } }))
}

/** The shapes `make_image` takes, as OpenRouter's aspect ratio (`image_config`); a model that has none ignores it. */
const ASPECT: Record<NonNullable<ImageRequestSpec['shape']>, string> = { square: '1:1', landscape: '16:9', portrait: '9:16' }

/** The longest an image request may take before it is given up. */
export const PI_IMAGE_TIMEOUT_MS = 180_000

/**
 * One picture on a provider's image model in Mousse's process (#1088): the catalogue's model, its credentials as
 * `ProviderAuthService` keeps them, one request and no retry. The first picture the provider sends is the answer; a
 * request that made none throws `ImageRequestError` with its kind, the provider's own words kept for the log.
 */
export async function runPiImage(models: PiImageModels, providerId: string, spec: ImageRequestSpec, signal: AbortSignal): Promise<GeneratedImage> {
  const model = models.getModelOfType('image', providerId, spec.model)
  if (!model || routes(model))
    throw harnessAppError({ code: 'model_unavailable', message: `${spec.model} is not an image model of this provider.` })
  if (!(await models.getAuth(model))) throw harnessAppError({ code: 'signed_out', message: 'This provider is not signed in.' })
  const aspect = spec.shape ? ASPECT[spec.shape] : undefined
  const result: AssistantImages = await models.generateImages(model, { input: [{ type: 'text', text: spec.prompt }] }, {
    signal,
    maxRetries: 0,
    timeoutMs: PI_IMAGE_TIMEOUT_MS,
    ...(aspect ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), image_config: { aspect_ratio: aspect } }) } : {})
  })
  if (result.stopReason !== 'stop') {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    throw new ImageRequestError(failureKind(result.errorMessage ?? ''), result.errorMessage ?? '')
  }
  const text = result.output.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim()
  const image = result.output.find((block) => block.type === 'image')
  if (!image || image.type !== 'image') throw new ImageRequestError(text ? 'refused' : 'no_image', text)
  const usage = result.usage ? { input: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite, output: result.usage.output, usd: result.usage.cost.total } : undefined
  return { mimeType: image.mimeType, data: image.data, ...(text ? { text } : {}), ...(usage ? { usage } : {}) }
}

/**
 * A failed request's kind, from the status its text starts with ("402: …", "429 Too many requests") and a few words:
 * a refusal (a content check, 400 or 403 about safety or policy), a sign-in or key refused (401, 403), no credit (402),
 * busy or at a limit (429, 503), no answer (a timeout or the network), else failed.
 */
export function failureKind(text: string): ImageFailureKind {
  const status = Number(/^\D{0,40}?\b([1-5]\d\d)\b/.exec(text)?.[1] ?? NaN)
  const policy = /safety|moderat|policy|content.?filter|flagged|not allowed|prohibited|refus/i.test(text)
  if ((status === 400 || status === 403) && policy) return 'refused'
  if (status === 401 || status === 403) return 'signed_out'
  if (status === 402 || /insufficient.{0,20}(credit|fund|balance)|quota/i.test(text)) return 'no_credit'
  if (status === 429 || status === 503 || status === 529) return 'busy'
  if (status === 408 || status === 504 || /timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(text)) return 'no_answer'
  if (policy) return 'refused'
  return 'failed'
}
