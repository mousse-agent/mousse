import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { LOCAL_STT_MODELS } from '../src/shared/dictation'
import type { LocalModelApi, SpeechSelection } from '../src/renderer/speechModels/SpeechModelPicker'
import { SpeechModelSetting } from '../src/renderer/speechModels/SpeechModelSetting'

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
      value,
      onSelect: () => undefined,
      providerModels,
      providerSelection: (model) => ({ source: 'provider', providerId: model.providerId, modelId: model.modelId, label: model.label }),
      localModels: LOCAL_STT_MODELS,
      localSelection: (model) => ({ source: 'local', modelId: model.id, label: model.label }),
      localApi: api
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

it('shows an empty, disabled select when no model is ready', () => {
  const html = render(null, [])
  expect(html).toMatch(/<select[^>]*disabled=""/)
  expect(html).toContain('No models yet')
})

it('keeps a saved choice visible when its model is no longer listed', () => {
  const html = render({ source: 'local', modelId: 'moonshine-base', label: 'Moonshine Base' }, [])
  expect(html).toContain('Moonshine Base')
  expect(html).not.toMatch(/<select[^>]*disabled=""/)
})
