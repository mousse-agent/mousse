// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationSelection } from '../../src/shared/dictation'
import type { DictationVocabularyTerm } from '../../src/shared/dictationVocabulary'
import { VocabularySetting, usesVocabulary, vocabularyFromDrafts } from '../../src/renderer/speech/VocabularySetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const parakeet: DictationSelection = { source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet' }
const whisper: DictationSelection = { source: 'local', modelId: 'whisper-base', label: 'Whisper' }

let host: HTMLDivElement
let root: Root
const onChange = vi.fn<(vocabulary: DictationVocabularyTerm[]) => void>()

async function render(vocabulary: DictationVocabularyTerm[], selection: DictationSelection | null = parakeet) {
  await act(async () => root.render(createElement(VocabularySetting, { vocabulary, selection, onChange })))
}

const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label) as HTMLButtonElement
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const inputs = () => [...document.querySelectorAll<HTMLInputElement>('.speech-vocab-row input')]

beforeEach(() => {
  onChange.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('Settings, Speech: Vocabulary', () => {
  it('shows how many terms there are', async () => {
    await render([])
    expect(button('Add terms')).toBeTruthy()
    await render([{ term: 'Grok', soundsLike: [] }, { term: 'Vite', soundsLike: [] }])
    expect(button('2 terms')).toBeTruthy()
  })

  it('opens on one empty row and saves the typed terms on Done', async () => {
    await render([])
    await act(async () => button('Add terms').click())
    expect(inputs()).toHaveLength(2)
    await type(inputs()[0], 'OpenCode')
    await type(inputs()[1], 'open code, oh pen code')
    await act(async () => button('Add term').click())
    await type(inputs()[2], '  ')
    await act(async () => button('Done').click())
    expect(onChange).toHaveBeenCalledWith([{ term: 'OpenCode', soundsLike: ['open code', 'oh pen code'] }])
    expect(document.querySelector('.speech-vocab-row')).toBeNull()
  })

  it('removes a term', async () => {
    await render([{ term: 'Grok', soundsLike: [] }, { term: 'Vite', soundsLike: ['vit'] }])
    await act(async () => button('2 terms').click())
    await act(async () => (document.querySelector('[aria-label="Remove Grok"]') as HTMLButtonElement).click())
    await act(async () => button('Done').click())
    expect(onChange).toHaveBeenCalledWith([{ term: 'Vite', soundsLike: ['vit'] }])
  })

  it('says when the chosen model does not use the list', async () => {
    await render([], whisper)
    expect(host.textContent).toContain('Only Parakeet models use them.')
    await render([], parakeet)
    expect(host.textContent).not.toContain('Only Parakeet')
  })
})

describe('which models use the vocabulary', () => {
  it('is the local Parakeet models only', () => {
    expect(usesVocabulary(parakeet)).toBe(true)
    expect(usesVocabulary(whisper)).toBe(false)
    expect(usesVocabulary({ source: 'provider', providerId: 'openai', modelId: 'whisper-1', label: 'Whisper' })).toBe(false)
    expect(usesVocabulary(null)).toBe(false)
  })

  it('merges rows typed twice', () => {
    expect(vocabularyFromDrafts([{ term: 'Grok', soundsLike: 'grock' }, { term: 'grok', soundsLike: 'groc' }])).toEqual([{ term: 'Grok', soundsLike: ['grock', 'groc'] }])
  })
})
