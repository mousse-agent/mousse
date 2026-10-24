import { describe, expect, it } from 'vitest'
import {
  LOCAL_STT_MODELS,
  MOONSHINE_BASE,
  MOONSHINE_TINY,
  PARAKEET_TDT_06B_V3,
  PARAKEET_TDT_110M,
  WHISPER_BASE,
  findLocalSttModel,
  type LocalSttModelId
} from '../src/shared/dictation'
import { localModelBytes, localModelFileUrl } from '../src/shared/localModels'
import { resolveWorkerModel } from '../src/renderer/dictation/workerModel'

const ALL_IDS: LocalSttModelId[] = ['moonshine-tiny', 'moonshine-base', 'whisper-base', 'parakeet-tdt-110m', 'parakeet-tdt-0.6b-v3']

describe('local dictation model list', () => {
  it('offers every model once, each findable by id', () => {
    expect(LOCAL_STT_MODELS.map((model) => model.id)).toEqual(ALL_IDS)
    for (const model of LOCAL_STT_MODELS) expect(findLocalSttModel(model.id)).toBe(model)
    expect(findLocalSttModel('whisper-large-v3-turbo')).toBeUndefined()
    expect(findLocalSttModel('whisper-small')).toBeUndefined()
  })

  it.each(LOCAL_STT_MODELS.map((model) => [model.id, model] as const))('%s has a pinned revision and verifiable files', (_id, model) => {
    expect(model.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(model.homepage).toMatch(/^https:\/\/huggingface\.co\//)
    expect(model.label && model.description && model.parameters && model.license).toBeTruthy()
    expect(new Set(model.files.map((file) => file.path)).size).toBe(model.files.length)
    for (const file of model.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.size).toBeGreaterThan(0)
    }
    expect(localModelBytes(model)).toBeGreaterThan(0)
    expect(localModelFileUrl(model, model.files[0].path)).toBe(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.files[0].path}`)
  })

  it('lists the files transformers.js reads for each Moonshine and Whisper model', () => {
    for (const model of [MOONSHINE_TINY, MOONSHINE_BASE, WHISPER_BASE]) {
      const paths = model.files.map((file) => file.path)
      for (const path of ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']) {
        expect(paths, `${model.id} ${path}`).toContain(path)
      }
      // q8 selects the `_quantized` export of each component.
      for (const [component, dtype] of Object.entries(model.dtype)) {
        expect(dtype).toBe('q8')
        expect(paths, `${model.id} ${component}`).toContain(`onnx/${component}_quantized.onnx`)
      }
      expect(Object.keys(model.dtype).sort()).toEqual(['decoder_model_merged', 'encoder_model'])
      expect(paths.filter((path) => path.endsWith('.onnx'))).toHaveLength(2)
    }
  })

  it('describes the multilingual models and the English-only ones', () => {
    expect(MOONSHINE_TINY.runtime).toBe('moonshine')
    expect(WHISPER_BASE.runtime).toBe('whisper')
    expect(WHISPER_BASE.description).toMatch(/languages/)
    expect(PARAKEET_TDT_06B_V3.description).toMatch(/25 European languages/)
    expect(WHISPER_BASE.maxSegmentSeconds).toBe(30)
    expect(WHISPER_BASE.sampleRate).toBe(16000)
  })

  it('gives Parakeet 0.6B v3 its own shape: 128 mel bins and a two-layer prediction network', () => {
    expect(PARAKEET_TDT_06B_V3).toMatchObject({ runtime: 'nemo-transducer', featureSize: 128, predictorSize: 640, predictorLayers: 2 })
    expect(PARAKEET_TDT_110M).toMatchObject({ featureSize: 80, predictorSize: 640, predictorLayers: 1 })
    const paths = PARAKEET_TDT_06B_V3.files.map((file) => file.path)
    for (const path of [PARAKEET_TDT_06B_V3.encoder, PARAKEET_TDT_06B_V3.decoder, PARAKEET_TDT_06B_V3.joiner, PARAKEET_TDT_06B_V3.tokens]) {
      expect(paths).toContain(path)
    }
  })
})

describe('resolveWorkerModel', () => {
  it('returns the model of the requested runtime', () => {
    expect(resolveWorkerModel('whisper-base', ['whisper'])).toBe(WHISPER_BASE)
    expect(resolveWorkerModel('moonshine-tiny', ['moonshine'])).toBe(MOONSHINE_TINY)
    expect(resolveWorkerModel('parakeet-tdt-0.6b-v3', ['nemo-transducer'])).toBe(PARAKEET_TDT_06B_V3)
  })

  it('rejects unknown models and models of another runtime', () => {
    expect(() => resolveWorkerModel('nope', ['whisper'])).toThrow('Unknown local dictation model: nope')
    expect(() => resolveWorkerModel('moonshine-base', ['whisper'])).toThrow('Moonshine Base does not run in this speech engine')
    expect(() => resolveWorkerModel('whisper-base', ['moonshine', 'nemo-transducer'])).toThrow(/Whisper Base/)
  })
})
