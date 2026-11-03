// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { LOCAL_STT_MODELS, RECOMMENDED_STT_MODEL_ID, type LocalSttModel } from '../src/shared/dictation'
import { LOCAL_TTS_MODELS, RECOMMENDED_TTS_MODEL_ID } from '../src/shared/readAloud'
import type { LocalModelManifest, LocalModelState, LocalModelStatus } from '../src/shared/localModels'
import type { LocalModelApi } from '../src/renderer/speechModels/SpeechModelPicker'
import { SpeechModelsDialog } from '../src/renderer/speechModels/SpeechModelSetting'
import { dictationComparison, readAloudComparison } from '../src/renderer/speechModels/modelComparison'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let api: { [K in keyof LocalModelApi]: ReturnType<typeof vi.fn> }
let onUse: Mock<(model: LocalModelManifest) => void>
let onStatus: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    list: vi.fn(async () => []),
    download: vi.fn(async (modelId: string) => ({ modelId, state: { status: 'downloaded' } })),
    cancelDownload: vi.fn(async () => undefined),
    remove: vi.fn(async (modelId: string) => ({ modelId, state: { status: 'not-downloaded' } })),
    onStatus: vi.fn(() => () => undefined)
  }
  onUse = vi.fn<(model: LocalModelManifest) => void>()
  onStatus = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function renderDictation(states: Record<string, LocalModelState>, inUseId: string | null = null): void {
  act(() =>
    root.render(
      createElement(SpeechModelsDialog<LocalSttModel>, {
        title: 'Dictation models',
        localModels: LOCAL_STT_MODELS,
        comparison: dictationComparison(RECOMMENDED_STT_MODEL_ID),
        states,
        api: api as unknown as LocalModelApi,
        onStatus: onStatus as (status: LocalModelStatus) => void,
        inUseId,
        onUse,
        onClose: () => undefined
      })
    )
  )
}

const columnNames = (): string[] =>
  [...host.querySelectorAll('[role="columnheader"] .speech-compare-name')].map((item) => item.textContent ?? '')
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent) === name)
  if (!found) throw new Error(`No button "${name}"`)
  return found
}
const click = async (name: string): Promise<void> => {
  await act(async () => button(name).click())
}

it('compares three models: the recommended one, the fewest wrong words and the most languages', () => {
  renderDictation({})
  expect(columnNames()).toEqual(['Parakeet TDT 110M', 'Parakeet TDT 0.6B v3', 'Whisper Base'])
  const tags = [...host.querySelectorAll('.speech-compare-head .speech-models-tag')].map((item) => item.textContent)
  expect(tags).toEqual(['Recommended', 'Fewest wrong words', 'Most languages'])
  const rows = [...host.querySelectorAll('[role="rowheader"]')].map((item) => item.textContent)
  expect(rows).toContain('Wrong words')
  expect(rows).toContain('Languages')
  // 6.32% is about 1 in 16 words; Whisper Base has no published figure.
  const cells = [...host.querySelectorAll('[role="cell"]')].map((item) => item.textContent)
  expect(cells).toContain('1 in 16')
  expect(cells).toContain('—')
  // Measured waits: Parakeet 110M 127 ms, v3 216 ms, Whisper Base about 3 s.
  expect(cells.slice(0, 3)).toEqual(['No wait', 'Under 1 s', '3 s'])
  expect(host.querySelector('.speech-compare-cell.best')?.textContent).toBeTruthy()
})

it('opens every model from "more models" and goes back', async () => {
  renderDictation({})
  await click('2 more models')
  expect(host.querySelector('h3')?.textContent).toBe('All dictation models')
  const titles = [...host.querySelectorAll('.settings-item-title')].map((item) => item.textContent)
  expect(titles).toEqual(['Moonshine Tiny', 'Moonshine Base', 'Parakeet TDT 110M', 'Whisper Base', 'Parakeet TDT 0.6B v3'])
  expect(host.textContent).toContain('No wait · 1 in 8 words wrong · 32 MB')
  await click('Back')
  expect(columnNames()).toHaveLength(3)
})

it('marks the model in use and uses a downloaded one', async () => {
  renderDictation({ 'parakeet-tdt-110m': { status: 'downloaded' }, 'whisper-base': { status: 'downloaded' } }, 'parakeet-tdt-110m')
  expect(host.querySelector('.speech-models-in-use')?.textContent).toBe('In use')
  await click('Use Whisper Base')
  expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'whisper-base' }))
})

it('downloads from the comparison and deletes from the list', async () => {
  renderDictation({ 'moonshine-tiny': { status: 'downloaded' } })
  await click('Download Parakeet TDT 0.6B v3')
  expect(api.download).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3')
  expect(onStatus).toHaveBeenCalledWith({ modelId: 'parakeet-tdt-0.6b-v3', state: { status: 'downloaded' } })

  await click('2 more models')
  await click('Delete Moonshine Tiny')
  expect(api.remove).toHaveBeenCalledWith('moonshine-tiny')
})

it('shows download progress with cancel, and a retry after a failure', async () => {
  renderDictation({
    'parakeet-tdt-110m': { status: 'downloading', receivedBytes: 50, totalBytes: 100 },
    'whisper-base': { status: 'error', message: 'Network error' }
  })
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  await click('Cancel downloading Parakeet TDT 110M')
  expect(api.cancelDownload).toHaveBeenCalledWith('parakeet-tdt-110m')
  await click('Retry downloading Whisper Base')
  expect(api.download).toHaveBeenCalledWith('whisper-base')
})

it('compares read aloud models by languages and voices', () => {
  act(() =>
    root.render(
      createElement(SpeechModelsDialog<(typeof LOCAL_TTS_MODELS)[number]>, {
        title: 'Read aloud models',
        localModels: LOCAL_TTS_MODELS,
        comparison: readAloudComparison(RECOMMENDED_TTS_MODEL_ID),
        states: {},
        api: api as unknown as LocalModelApi,
        onStatus: () => undefined,
        inUseId: null,
        onUse,
        onClose: () => undefined
      })
    )
  )
  expect(columnNames()).toEqual(['Kokoro 82M', 'Supertonic 3', 'Kitten TTS Nano'])
  const rows = [...host.querySelectorAll('[role="rowheader"]')].map((item) => item.textContent).filter(Boolean)
  expect(rows).toEqual(['Languages', 'Voices', 'Download'])
  expect(host.textContent).toContain(`${LOCAL_TTS_MODELS.length - 3} more models`)
})
