import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { LOCAL_STT_MODELS, RECOMMENDED_STT_MODEL_ID } from '../src/shared/dictation'
import type { LocalModelApi, SpeechSelection } from '../src/renderer/speechModels/SpeechModelPicker'
import { SpeechModelSetting } from '../src/renderer/speechModels/SpeechModelSetting'
import { dictationComparison } from '../src/renderer/speechModels/modelComparison'

// The themed select renders options only while open; the stub lists them as markup.
vi.mock('../src/renderer/components/ui/Select', () => import('./support/selectStub'))

const api: LocalModelApi = {
  list: async () => [],
  download: async (modelId) => ({ modelId, state: { status: 'downloaded' } }),
  cancelDownload: async () => undefined,
  remove: async (modelId) => ({ modelId, state: { status: 'not-downloaded' } }),
  onStatus: () => () => undefined
}

const render = (value: SpeechSelection | null, providerModels: Parameters<typeof SpeechModelSetting>[0]['providerModels']) =>
  renderToStaticMarkup(
    createElement(SpeechModelSetting, {
      title: 'Model',
      description: 'Turns speech into text.',
      dialogTitle: 'Dictation models',
      addLabel: 'Add a dictation model',
      value,
      onSelect: () => undefined,
      providerModels,
      providerSelection: (model) => ({ source: 'provider', providerId: model.providerId, modelId: model.modelId, label: model.label }),
      localModels: LOCAL_STT_MODELS,
      localSelection: (model) => ({ source: 'local', modelId: model.id, label: model.label }),
      localApi: api,
      comparison: dictationComparison(RECOMMENDED_STT_MODEL_ID)
    })
  )

it('lists provider models in the select and keeps downloads behind Get more models', () => {
  const html = render(null, [{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'whisper-1', label: 'whisper-1' }])
  expect(html).toContain('<optgroup label="OpenAI">')
  expect(html).toContain('value="provider:openai:whisper-1"')
  expect(html).toContain('Get more models')
  // Models that are not on this computer only appear in the dialog.
  expect(html).not.toContain('Moonshine Base')
})

it('offers one add action instead of a dead select when no model is ready', () => {
  const html = render(null, [])
  expect(html).not.toContain('<select')
  expect(html).not.toContain('Get more models')
  expect(html).toMatch(/<button[^>]*aria-label="Add a dictation model"[^>]*>.*Add model<\/button>/)
})

it('keeps the select while provider models are still loading, with no loading words', () => {
  const html = render(null, null)
  expect(html).toMatch(/<select[^>]*disabled=""/)
  // The loader appears only after a short delay (tests/renderer/speechModelsPending.test.ts).
  expect(html).not.toContain('Loading models')
  expect(html).not.toContain('Add model')
})

it('keeps a saved choice visible when its model is no longer listed', () => {
  const html = render({ source: 'local', modelId: 'moonshine-base', label: 'Moonshine Base' }, [])
  expect(html).toContain('Moonshine Base')
  expect(html).not.toMatch(/<select[^>]*disabled=""/)
})
