// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { runCommand } from '../../src/renderer/commands/commandRegistry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stands in for the microphone: the test decides when recording finishes and with what text.
const dictation = vi.hoisted(() => ({ onTranscript: (_text: string) => {}, recording: false, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }))
vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: ({ onTranscript }: { onTranscript: (text: string) => void }) => {
    dictation.onTranscript = onTranscript
    return { isRecording: dictation.recording, recordingPending: false, transcribing: false, recordingDuration: 7, levels: null, error: undefined, dismissError: () => {}, notice: null, start: dictation.start, stop: dictation.stop, cancel: dictation.cancel }
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
  dictation.stop.mockReset()
  dictation.cancel.mockReset()
  dictation.recording = false
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

describe('the composer while recording', () => {
  const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  /** Presses a button the way a mouse does; returns whether the box kept focus. */
  function press(target: HTMLButtonElement): boolean {
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      target.dispatchEvent(down)
      target.click()
    })
    return down.defaultPrevented
  }

  it('shows the time with Cancel and Done in place of Send, and keeps the typed text', () => {
    dictation.recording = true
    render('fix the bug')
    expect(host.querySelector('[role="group"][aria-label="Recording"]')?.textContent).toContain('0:07')
    expect(button('Cancel recording')).not.toBeNull()
    expect(button('Finish recording')).not.toBeNull()
    expect(button('Send message')).toBeNull()
    expect(button('Dictate')).toBeNull()
    expect(box().value).toBe('fix the bug')
  })

  it('Cancel throws the recording away; Done finishes it; both leave focus in the box', () => {
    dictation.recording = true
    render('fix the bug')
    box().focus()
    expect(press(button('Cancel recording')!)).toBe(true)
    expect(dictation.cancel).toHaveBeenCalledTimes(1)
    expect(dictation.stop).not.toHaveBeenCalled()
    expect(press(button('Finish recording')!)).toBe(true)
    expect(dictation.stop).toHaveBeenCalledTimes(1)
    expect(dictation.cancel).toHaveBeenCalledTimes(1)
  })
})

describe('the dictation shortcut', () => {
  it('starts dictation over the selection, and pressed again while recording finishes it', () => {
    render('fix the parser bug')
    box().focus()
    box().setSelectionRange(8, 14) // "parser"
    expect(dictate().title).toBe('Dictate · ⌘⇧Space')
    let ran = false
    act(() => {
      ran = runCommand('composer.dictate', 'key')
    })
    expect(ran).toBe(true)
    expect(dictation.start).toHaveBeenCalledTimes(1)
    box().setSelectionRange(0, 0)
    finish('lexer')
    expect(value).toBe('fix the lexer bug')
  })

  it('while recording, the key is Done: the text goes in, nothing is thrown away', () => {
    dictation.recording = true
    render('fix the bug')
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Finish recording"]')!.title).toBe('Done · insert the text · ⌘⇧Space')
    let ran = false
    act(() => {
      ran = runCommand('composer.dictate', 'key')
    })
    expect(ran).toBe(true)
    expect(dictation.stop).toHaveBeenCalledTimes(1)
    expect(dictation.start).not.toHaveBeenCalled()
    expect(dictation.cancel).not.toHaveBeenCalled()
  })

})

describe('dictation while a run can be stopped', () => {
  // Every state in which the composer shows Stop: the message dictated there is steered or queued.
  const states: Array<[string, Pick<ChatComposerProps, 'loading' | 'stoppable'>, string]> = [
    ['a reply runs', { loading: true }, 'Queue message'],
    ['the run waits on an approval or an answer', { loading: false, stoppable: true }, 'Send message']
  ]
  function renderRunning(initial: string, state: Pick<ChatComposerProps, 'loading' | 'stoppable'>, onSend: () => void) {
    function Running() {
      const [input, setInput] = useState(initial)
      value = input
      const props: ChatComposerProps = { input, onInputChange: setInput, attachedFiles: [], onAttachedFilesChange: () => {}, voiceMessages: [], onVoiceMessagesChange: () => {}, enabledSkills: [], onSend, ...state }
      return createElement(ChatComposer, props)
    }
    act(() => root.render(createElement(Running)))
  }

  it.each(states)('while %s, the microphone records and its text goes in the box to send', (_name, state, sendLabel) => {
    const onSend = vi.fn()
    renderRunning('also check', state, onSend)
    expect(host.querySelector('button[aria-label="Stop run"]')).not.toBeNull()
    box().focus()
    box().setSelectionRange(10, 10)
    expect(pressDictate()).toBe(true)
    expect(dictation.start).toHaveBeenCalledTimes(1)
    finish('the tests')
    expect(value).toBe('also check the tests')
    act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${sendLabel}"]`)!.click())
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it.each(states)('while %s, the dictation key starts recording', (_name, state) => {
    renderRunning('', state, () => {})
    box().focus()
    let ran = false
    act(() => {
      ran = runCommand('composer.dictate', 'key')
    })
    expect(ran).toBe(true)
    expect(dictation.start).toHaveBeenCalledTimes(1)
  })
})
