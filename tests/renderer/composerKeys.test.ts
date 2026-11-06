// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The microphone pulls in audio worklets jsdom does not have; these tests never record.
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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  Element.prototype.scrollIntoView ??= () => {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(options: { input?: string; loading?: boolean; lastPrompt?: string; placeholder?: string; disabled?: boolean } = {}) {
  const onSend = vi.fn()
  const onInput = vi.fn()
  function Harness() {
    const [input, setInput] = useState(options.input ?? '')
    const props: ChatComposerProps = {
      input,
      onInputChange: (value) => { onInput(value); setInput(value) },
      attachedFiles: [],
      onAttachedFilesChange: () => {},
      voiceMessages: [],
      onVoiceMessagesChange: () => {},
      enabledSkills: [],
      providers: [],
      selectedProviderId: '',
      selectedModelId: '',
      modelMenuOpen: false,
      onModelMenuOpenChange: () => {},
      onModelSelect: () => {},
      onOpenSettings: () => {},
      contextUsage: { used: 0, limit: 0, percent: 0 } as unknown as ChatComposerProps['contextUsage'],
      contextOpen: false,
      onContextOpenChange: () => {},
      loading: options.loading ?? false,
      disabled: options.disabled ?? false,
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      onSend,
      lastPrompt: () => options.lastPrompt
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
  return { onSend, onInput }
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { box().dispatchEvent(event) })
  return event
}

describe('composer keys', () => {
  it('steers with Alt+Enter during a run, and queues with Enter', () => {
    const { onSend } = render({ input: 'use pnpm', loading: true })
    press('Enter', { altKey: true })
    expect(onSend).toHaveBeenLastCalledWith(undefined, { steer: true })
    press('Enter')
    expect(onSend).toHaveBeenLastCalledWith(undefined)
  })

  it('sends normally with Alt+Enter when no run is going', () => {
    const { onSend } = render({ input: 'hello' })
    press('Enter', { altKey: true })
    expect(onSend).toHaveBeenCalledWith(undefined)
  })

  it('leaves Alt+Enter to an input method that is composing', () => {
    const { onSend } = render({ input: 'にほん', loading: true })
    press('Enter', { altKey: true, isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('brings back the last prompt with Up in an empty box, and Escape clears it again', () => {
    render({ lastPrompt: 'hello' })
    const up = press('ArrowUp')
    expect(up.defaultPrevented).toBe(true)
    expect(box().value).toBe('hello')
    press('Escape')
    expect(box().value).toBe('')
  })

  it('leaves Up alone when the box has text or there is nothing to recall', () => {
    const { onInput } = render({ input: 'draft', lastPrompt: 'hello' })
    expect(press('ArrowUp').defaultPrevented).toBe(false)
    expect(box().value).toBe('draft')
    act(() => root.unmount())
    root = createRoot(host)
    render({})
    expect(press('ArrowUp').defaultPrevented).toBe(false)
    expect(onInput).not.toHaveBeenCalled()
  })

  it('never takes Up from an open slash command list', () => {
    render({ input: '/', lastPrompt: 'hello' })
    expect(host.querySelector('[aria-label="Slash command suggestions"]')).not.toBeNull()
    press('ArrowUp')
    expect(box().value).toBe('/')
  })

  it('says what Enter does in the placeholder', () => {
    render({})
    expect(box().placeholder).toBe('Ask anything · @ files · / commands')
    act(() => root.unmount())
    root = createRoot(host)
    render({ loading: true })
    expect(box().placeholder).toBe('Queue a follow-up · Alt+Enter steers')
    act(() => root.unmount())
    root = createRoot(host)
    render({ disabled: true, placeholder: '' })
    expect(box().placeholder).toBe('')
  })
})
