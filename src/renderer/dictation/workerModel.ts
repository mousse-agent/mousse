import { findLocalSttModel, type LocalSttModel } from '../../shared/dictation'

/**
 * The model a speech-to-text worker was asked to serve. Each worker handles one runtime, and the
 * page names the model in its `init` message, so a worker given a model of another runtime (or an
 * unknown id) fails loudly instead of loading the wrong files.
 */
export function resolveWorkerModel<Runtime extends LocalSttModel['runtime']>(
  modelId: string,
  runtimes: readonly Runtime[]
): Extract<LocalSttModel, { runtime: Runtime }> {
  const model = findLocalSttModel(modelId)
  if (!model) throw new Error(`Unknown local dictation model: ${modelId}`)
  if (!(runtimes as readonly string[]).includes(model.runtime)) {
    throw new Error(`${model.label} does not run in this speech engine`)
  }
  return model as Extract<LocalSttModel, { runtime: Runtime }>
}
