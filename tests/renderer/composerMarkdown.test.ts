// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: () => ({ isRecording: false, recordingPending: false, transcribing: false, recordingDuration: 0, levels: null, error: undefined, dismissError: () => {}, notice: null, start: () => {}, stop: () => {} })
}))

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root
let host: HTMLElement
let value = ''
const onSend = vi.fn()

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  onSend.mockReset()
  useAppStore.setState({ profileId: 'profile-1', appInfo: { platform: 'linux' } as never })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ appInfo: null })
  vi.unstubAllGlobals()
})

function render(initial: string) {
  function Harness() {
    const [input, setInput] = useState(initial)
    value = input
    const props: ChatComposerProps = {
      input,
      onInputChange: setInput,
      attachedFiles: [],
      onAttachedFilesChange: () => {},
      voiceMessages: [],
      onVoiceMessagesChange: () => {},
      enabledSkills: [],
      loading: false,
      onSend
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const backdrop = () => host.querySelector<HTMLElement>('.composer-input-backdrop')!

function press(key: string, options: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  act(() => { box().dispatchEvent(event) })
  return event.defaultPrevented
}

describe('Markdown in the composer', () => {
  it('Shift+Enter at the end of a numbered item starts the next number, caret after it', () => {
    render('1. first')
    box().focus()
    box().setSelectionRange(8, 8)
    expect(press('Enter', { shiftKey: true })).toBe(true)
    expect(value).toBe('1. first\n2. ')
    expect(box().selectionStart).toBe(value.length)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Shift+Enter on an empty item ends the list; on plain text the textarea adds the line itself', () => {
    render('- one\n- ')
    box().focus()
    box().setSelectionRange(8, 8)
    press('Enter', { shiftKey: true })
    expect(value).toBe('- one\n')
    render('plain')
    box().setSelectionRange(5, 5)
    expect(press('Enter', { shiftKey: true })).toBe(false)
  })

  it('Enter in a list item still sends', () => {
    render('1. first')
    box().focus()
    box().setSelectionRange(8, 8)
    press('Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('the painted draft shows bold text and list markers, every character exactly once', () => {
    const draft = 'Do **this** now\n1. item'
    render(draft)
    expect(backdrop().querySelector('.composer-md-bold:not(.composer-md-marker)')?.textContent).toBe('this')
    expect(backdrop().querySelector('.composer-md-list')?.textContent).toBe('1.')
    expect(backdrop().textContent).toBe(draft)
  })
})
