import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LOCAL_STT_MODELS } from '../src/shared/dictation'
import { SpeechModelPicker, type LocalModelApi } from '../src/renderer/speechModels/SpeechModelPicker'

const api: LocalModelApi = {
  list: async () => [],
  download: async (modelId) => ({ modelId, state: { status: 'downloaded' } }),
  cancelDownload: async () => undefined,
  remove: async (modelId) => ({ modelId, state: { status: 'not-downloaded' } }),
  onStatus: () => () => undefined
}

const render = (providerModels: Parameters<typeof SpeechModelPicker>[0]['providerModels']) =>
  renderToStaticMarkup(
    createElement(SpeechModelPicker, {
      value: null,
      onSelect: () => undefined,
      tabsLabel: 'Dictation model source',
      radioName: 'dictation-model',
      providerModels,
      providerSelection: (model) => ({ source: 'provider', providerId: model.providerId, modelId: model.modelId, label: model.label }),
      localModels: LOCAL_STT_MODELS,
      localSelection: (model) => ({ source: 'local', modelId: model.id, label: model.label }),
      localApi: api,
      sameSelection: (a, b) => a === b,
      renderEmptyProviders: () => 'Nothing listed'
    })
  )

it('lists provider models under the Providers tab', () => {
  const html = render([{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'whisper-1', label: 'whisper-1' }])
  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="Dictation model source"')
  expect(html).toContain('name="dictation-model"')
  expect(html).toContain('whisper-1')
})

it('opens on the Local tab with the Moonshine model when no provider model exists', () => {
  const html = render([])
  for (const model of LOCAL_STT_MODELS) {
    expect(html).toContain(`Download ${model.label}`)
  }
  // Undownloaded models cannot be selected: one disabled radio per local model.
  expect(html.match(/<input type="radio"[^>]*disabled=""/g)).toHaveLength(LOCAL_STT_MODELS.length)
  expect(html).not.toContain('Nothing listed')
})

it('shows a loading state until provider models arrive', () => {
  expect(render(null)).toContain('Loading models')
})
