// @vitest-environment jsdom
/**
 * The bar beside text selected in a conversation: Read aloud always, Reply only where the conversation has a composer.
 * Read aloud keeps the selection, so the bar stays and turns to Stop while the text plays; the bar keeps inside the
 * window by its own width.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUOTE_SOURCE_ATTRIBUTE, SelectionReplyButton, selectionSpeechKey } from '../../src/renderer/components/SelectionReplyButton'
import { COMPOSER_QUOTE_EVENT } from '../../src/renderer/lib/composerQuotes'
import { useReadAloudStore } from '../../src/renderer/readAloud/readAloudStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TEXT = 'the flaky test fails on seed 42'
let host: HTMLDivElement
let root: Root
let chat: HTMLDivElement
const rect = (left: number, right: number) => ({ left, right, top: 100, bottom: 116, width: right - left, height: 16, x: left, y: 100, toJSON: () => ({}) }) as DOMRect

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  // jsdom lays nothing out: the selection ends at x=900, and the conversation fills the window.
  ;(Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [rect(800, 900)]
  ;(Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => rect(800, 900)
  useReadAloudStore.setState({ activeKey: null, status: 'idle', pending: null, pickerOpen: false, selection: null, error: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(SelectionReplyButton)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  chat?.remove()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A conversation with `TEXT` in it, with or without a composer, and the text selected. */
function select({ composer }: { composer: boolean }) {
  chat = document.createElement('div')
  const transcript = document.createElement('div')
  transcript.setAttribute(QUOTE_SOURCE_ATTRIBUTE, '')
  transcript.getBoundingClientRect = () => ({ ...rect(0, 1024), top: 0, bottom: 768 })
  const paragraph = document.createElement('p')
  paragraph.textContent = TEXT
  transcript.append(paragraph)
  chat.append(transcript)
  if (composer) {
    const input = document.createElement('textarea')
    input.className = 'composer-input'
    chat.append(input)
  }
  document.body.append(chat)
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  act(() => {
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}
const bar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Selected text actions"]')
const button = (name: string) => bar()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null

describe('the selected text bar', () => {
  it('offers Read aloud without Reply where there is no composer', () => {
    select({ composer: false })
    expect(button('Read aloud')).not.toBeNull()
    expect(button('Reply to the selected text')).toBeNull()
  })

  it('offers Read aloud and Reply where the conversation has a composer; Reply quotes the text', () => {
    select({ composer: true })
    expect(button('Read aloud')).not.toBeNull()
    const quoted = vi.fn()
    window.addEventListener(COMPOSER_QUOTE_EVENT, quoted)
    act(() => button('Reply to the selected text')!.click())
    window.removeEventListener(COMPOSER_QUOTE_EVENT, quoted)
    expect((quoted.mock.calls[0]![0] as CustomEvent).detail.text).toBe(TEXT)
    expect(bar()).toBeNull()
  })

  it('Read aloud reads the selection and keeps the bar, which turns to Stop while it plays', () => {
    select({ composer: false })
    act(() => button('Read aloud')!.click())
    expect(useReadAloudStore.getState().pending).toMatchObject({ key: selectionSpeechKey(TEXT), text: TEXT })
    expect(window.getSelection()!.toString()).toBe(TEXT)
    act(() => useReadAloudStore.setState({ activeKey: selectionSpeechKey(TEXT), status: 'playing', pickerOpen: false }))
    expect(button('Stop reading')?.textContent).toBe('Stop')
  })

  it('stays inside the window by its measured width', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180)
    select({ composer: true })
    // The selection ends at 900 in a 1024-wide window: a 180-wide bar starts at 1024 - 180 - 8.
    expect(window.innerWidth).toBe(1024)
    expect(bar()!.style.left).toBe('836px')
  })
})
