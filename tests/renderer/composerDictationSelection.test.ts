// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stands in for the microphone: the test decides when recording finishes and with what text.
const dictation = vi.hoisted(() => ({ onTranscript: (_text: string) => {}, start: vi.fn(), stop: vi.fn() }))
vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: ({ onTranscript }: { onTranscript: (text: string) => void }) => {
    dictation.onTranscript = onTranscript
    return { isRecording: false, recordingPending: false, transcribing: false, recordingDuration: 0, levels: null, error: undefined, dismissError: () => {}, notice: null, start: dictation.start, stop: dictation.stop }
  }
}))

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root
let host: HTMLElement
let value = ''
let frames: FrameRequestCallback[] = []

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  Element.prototype.scrollIntoView ??= () => {}
  dictation.start.mockReset()
  useAppStore.setState({ profileId: 'profile-1', appInfo: { platform: 'darwin' } as never })
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
      onSend: () => {}
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const dictate = () => host.querySelector<HTMLButtonElement>('.composer-dictate-btn')!

/** Presses the microphone the way a mouse does: mousedown, then click. Returns whether focus was kept. */
function pressDictate(): boolean {
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  act(() => {
    dictate().dispatchEvent(down)
    dictate().click()
  })
  return down.defaultPrevented
}

/** The recording finishes with `text`; the next frame then runs, after React has drawn the new value. */
function finish(text: string): void {
  act(() => dictation.onTranscript(text))
  act(() => frames.splice(0).forEach((frame) => frame(0)))
}

describe('dictation and the composer selection', () => {
  it('replaces exactly the text selected before dictation started, even after the caret moved', () => {
    render('fix the parser bug today')
    box().focus()
    box().setSelectionRange(8, 14) // "parser"
    expect(pressDictate()).toBe(true)
    expect(dictation.start).toHaveBeenCalledTimes(1)
    // While recording the user clicks elsewhere in the box; the dictated text still goes over "parser".
    box().setSelectionRange(0, 0)
    finish('lexer')
    expect(value).toBe('fix the lexer bug today')
    expect(box().selectionStart).toBe('fix the lexer'.length)
  })

  it('with no selection inserts at the caret', () => {
    render('fix the bug')
    box().focus()
    box().setSelectionRange(7, 7)
    pressDictate()
    finish('parser')
    expect(value).toBe('fix the parser bug')
  })

  it('goes at the current caret when the text changed while recording', () => {
    render('fix the bug')
    box().focus()
    box().setSelectionRange(4, 7) // "the"
    pressDictate()
    act(() => {
      box().value = 'fix a bug'
      box().setSelectionRange(9, 9)
    })
    finish('now')
    expect(value).toBe('fix a bug now')
  })
})
