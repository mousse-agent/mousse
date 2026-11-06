// @vitest-environment jsdom
/** While provider models load, the model select holds the shared delayed loader instead of loading words. */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOCAL_STT_MODELS, RECOMMENDED_STT_MODEL_ID } from '../../src/shared/dictation'
import type { LocalModelApi, SpeechProviderModel } from '../../src/renderer/speechModels/SpeechModelPicker'
import { MODELS_PENDING_DELAY_MS, SpeechModelSetting } from '../../src/renderer/speechModels/SpeechModelSetting'
import { dictationComparison } from '../../src/renderer/speechModels/modelComparison'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api: LocalModelApi = {
  list: async () => [],
  download: async (modelId) => ({ modelId, state: { status: 'downloaded' } }),
  cancelDownload: async () => undefined,
  remove: async (modelId) => ({ modelId, state: { status: 'not-downloaded' } }),
  onStatus: () => () => undefined
}

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const mount = async (providerModels: SpeechProviderModel[] | null) => {
  await act(async () => root.render(createElement(SpeechModelSetting, {
    title: 'Model',
    description: 'Turns speech into text.',
    dialogTitle: 'Dictation models',
    addLabel: 'Add a dictation model',
    value: null,
    onSelect: () => undefined,
    providerModels,
    providerSelection: (model) => ({ source: 'provider', providerId: model.providerId, modelId: model.modelId, label: model.label }),
    localModels: LOCAL_STT_MODELS,
    localSelection: (model) => ({ source: 'local', modelId: model.id, label: model.label }),
    localApi: api,
    comparison: dictationComparison(RECOMMENDED_STT_MODEL_ID)
  })))
}

const trigger = () => host.querySelector<HTMLButtonElement>('button[role="combobox"]')!
const loader = () => host.querySelector('[role="status"][aria-label="Loading models"]')

it('shows an empty disabled select at first, then the small loader, and never loading words', async () => {
  await mount(null)
  expect(trigger().disabled).toBe(true)
  expect(loader()).toBeNull()
  expect(host.textContent).not.toContain('Loading')
  await act(async () => { vi.advanceTimersByTime(MODELS_PENDING_DELAY_MS) })
  expect(loader()).not.toBeNull()
  expect(trigger().contains(loader())).toBe(true)
  expect(host.textContent).not.toContain('Loading')
})

it('drops the loader once the models arrive', async () => {
  await mount(null)
  await act(async () => { vi.advanceTimersByTime(MODELS_PENDING_DELAY_MS) })
  await mount([{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'whisper-1', label: 'whisper-1' }])
  expect(loader()).toBeNull()
  expect(trigger().disabled).toBe(false)
  expect(trigger().textContent).toContain('Choose a model')
})
