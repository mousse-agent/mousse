// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import { attachCommandShortcuts } from '../../src/renderer/commands/useCommandShortcuts'
import { forgetSendModes, setThreadSendMode, threadSendMode } from '../../src/renderer/lib/sendMode'
import { forgetSteerKey, steerKeyRecently, steersOnEnter, type SendMode } from '../../src/renderer/lib/steerKey'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { getCommand, resolveBinding } from '../../src/shared/commands'

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

const PROFILE = 'profile-1'
let root: Root
let host: HTMLElement
let detachKeys: () => void

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  Element.prototype.scrollIntoView ??= () => {}
  localStorage.clear()
  forgetSendModes()
  forgetSteerKey()
  useAppStore.setState({ profileId: PROFILE, activeThreadId: 'thread-a', appInfo: { platform: 'win32' } as never })
  // The thread composer sits in the chat's input area, which is where the shortcut dispatcher looks for it.
  host = document.createElement('div')
  host.className = 'chat-input-area'
  document.body.append(host)
  root = createRoot(host)
  detachKeys = attachCommandShortcuts(window)
})

afterEach(() => {
  detachKeys()
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAppStore.setState({ appInfo: null, activeThreadId: null })
  vi.unstubAllGlobals()
})

interface Options {
  input?: string
  loading?: boolean
  thread?: string
  sendLabel?: string
  onSteerQueued?: () => boolean
}

function render(options: Options = {}) {
  const onSend = vi.fn()
  function Harness() {
    const [input, setInput] = useState(options.input ?? 'use the smaller fixture')
    const props: ChatComposerProps = {
      input,
      onInputChange: setInput,
      attachedFiles: [],
      onAttachedFilesChange: () => {},
      voiceMessages: [],
      onVoiceMessagesChange: () => {},
      enabledSkills: [],
      loading: options.loading ?? true,
      onSend,
      ...(options.onSteerQueued ? { onSteerQueued: options.onSteerQueued } : {}),
      ...(options.sendLabel ? { sendLabel: options.sendLabel } : {}),
      ...('thread' in options ? (options.thread ? { sendModeThreadId: options.thread } : {}) : { sendModeThreadId: 'thread-a' })
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
  return { onSend }
}

function rerender(options: Options = {}) {
  act(() => root.unmount())
  root = createRoot(host)
  return render(options)
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const modeButton = () => host.querySelector<HTMLButtonElement>('.composer-send-mode-btn')
const sendButton = () => host.querySelector<HTMLButtonElement>('.composer-action-btn')!
const press = (init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  act(() => {
    box().focus()
    box().dispatchEvent(event)
  })
  return event
}
const steer = [undefined, { steer: true }]
const queue = [undefined]

describe('send mode keys', () => {
  it('Enter follows the mode, the chord does the other, Alt+Enter always steers, Shift+Enter never sends', () => {
    const enter = (init: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, mode: SendMode, platform = 'win32') =>
      steersOnEnter({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }, platform, mode)
    expect(enter({}, 'queue')).toBe(false)
    expect(enter({}, 'steer')).toBe(true)
    expect(enter({ ctrlKey: true }, 'queue')).toBe(true)
    expect(enter({ ctrlKey: true }, 'steer')).toBe(false)
    expect(enter({ metaKey: true }, 'queue', 'darwin')).toBe(true)
    expect(enter({ metaKey: true }, 'steer', 'darwin')).toBe(false)
    expect(enter({ altKey: true }, 'queue')).toBe(true)
    expect(enter({ altKey: true }, 'steer')).toBe(true)
    expect(enter({ shiftKey: true }, 'steer')).toBe(false)
    expect(enter({ ctrlKey: true, shiftKey: true }, 'queue')).toBe(false)
  })

  it('queues on Enter and steers on Ctrl+Enter in a thread set to Queue', () => {
    const { onSend } = render()
    press()
    expect(onSend.mock.lastCall).toEqual(queue)
    press({ ctrlKey: true })
    expect(onSend.mock.lastCall).toEqual(steer)
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('steers on Enter and queues on Ctrl+Enter (Cmd+Enter on a Mac) in a thread set to Steer', () => {
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    let { onSend } = render()
    expect(box().placeholder).toBe('Steer the reply · Ctrl+Enter queues')
    press()
    expect(onSend.mock.lastCall).toEqual(steer)
    press({ ctrlKey: true })
    expect(onSend.mock.lastCall).toEqual(queue)
    press({ altKey: true })
    expect(onSend.mock.lastCall).toEqual(steer)
    useAppStore.setState({ appInfo: { platform: 'darwin' } as never })
    ;({ onSend } = rerender())
    press({ metaKey: true })
    expect(onSend.mock.lastCall).toEqual(queue)
    press()
    expect(onSend.mock.lastCall).toEqual(steer)
  })

  it('the send button does what Enter does', () => {
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    const { onSend } = render()
    expect(sendButton().getAttribute('aria-label')).toBe('Steer message')
    expect(sendButton().title).toBe('Steer · Enter — Queue · Ctrl+Enter')
    act(() => sendButton().click())
    expect(onSend.mock.lastCall).toEqual(steer)
  })

  it('keeps the approval guard after the chord queues in Steer mode, and after Enter steers', () => {
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    render()
    press({ ctrlKey: true })
    expect(steerKeyRecently()).toBe(true)
    forgetSteerKey()
    press()
    expect(steerKeyRecently()).toBe(true)
  })

  it('the chord in an empty composer sends the next queued message now, in either mode', () => {
    const onSteerQueued = vi.fn(() => true)
    const { onSend } = render({ input: '', onSteerQueued })
    press({ ctrlKey: true })
    expect(onSteerQueued).toHaveBeenCalledTimes(1)
    expect(steerKeyRecently()).toBe(true)
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    rerender({ input: '', onSteerQueued })
    press({ ctrlKey: true })
    expect(onSteerQueued).toHaveBeenCalledTimes(2)
    // Plain Enter with nothing typed sends nothing, as before.
    press()
    expect(onSteerQueued).toHaveBeenCalledTimes(2)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('the chord with text typed steers that text, not a queued message, and with no run it does nothing to the queue', () => {
    const onSteerQueued = vi.fn(() => true)
    let { onSend } = render({ onSteerQueued })
    press({ ctrlKey: true })
    expect(onSend.mock.lastCall).toEqual(steer)
    expect(onSteerQueued).not.toHaveBeenCalled()
    ;({ onSend } = rerender({ input: '', loading: false, onSteerQueued }))
    press({ ctrlKey: true })
    expect(onSteerQueued).not.toHaveBeenCalled()
  })

  it('sends every Enter as a plain send with no run going, whatever the mode', () => {
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    const { onSend } = render({ loading: false })
    press()
    press({ ctrlKey: true })
    expect(onSend.mock.calls).toEqual([queue, queue])
  })
})

describe('send mode button and shortcut', () => {
  it('shows the mode left of send, names it and the keys in its tooltip, and uses Cmd on a Mac', () => {
    render()
    const buttons = [...host.querySelectorAll('.composer-footer-right button')].map((button) => button.getAttribute('aria-label'))
    expect(buttons.slice(-2)).toEqual(['Send mode: Queue', 'Queue message'])
    expect(modeButton()!.title).toBe('Queue · Ctrl+Enter steers · Ctrl+Shift+Enter switches')
    expect(modeButton()!.classList.contains('is-steer')).toBe(false)
    useAppStore.setState({ appInfo: { platform: 'darwin' } as never })
    rerender()
    expect(modeButton()!.title).toBe('Queue · ⌘↩ steers · ⌘⇧↩ switches')
  })

  it('switches on click, never sends, and keeps the caret in the box', () => {
    const { onSend } = render()
    box().focus()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => { modeButton()!.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    act(() => modeButton()!.click())
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Steer')
    expect(modeButton()!.classList.contains('is-steer')).toBe(true)
    expect(modeButton()!.title).toBe('Steer · Ctrl+Enter queues · Ctrl+Shift+Enter switches')
    act(() => modeButton()!.click())
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Queue')
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('use the smaller fixture')
  })

  it('switches with Ctrl+Shift+Enter from the box, never sends, and adds no new line', () => {
    expect(resolveBinding(getCommand('composer.switchSendMode').defaultBinding as string, 'win32')).toBe('Ctrl+Shift+Enter')
    const { onSend } = render()
    const event = press({ ctrlKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Steer')
    expect(threadSendMode(PROFILE, 'thread-a')).toBe('steer')
    press({ ctrlKey: true, shiftKey: true })
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Queue')
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('use the smaller fixture')
  })

  it('leaves Ctrl+Shift+Enter alone with no run going', () => {
    render({ loading: false })
    expect(press({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(threadSendMode(PROFILE, 'thread-a')).toBe('queue')
  })

  it('has no button when idle, in a bot chat, or while a card takes the message', () => {
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    render({ loading: false })
    expect(modeButton()).toBeNull()
    expect(box().placeholder).toBe('Ask anything · @ files · / commands')
    // A bot's chat never steers: its composer is given no thread for the mode.
    let { onSend } = rerender({ thread: undefined })
    expect(modeButton()).toBeNull()
    expect(box().placeholder).toBe('Queue a follow-up · Ctrl+Enter steers')
    press()
    expect(onSend.mock.lastCall).toEqual(queue)
    expect(readFileSync('src/renderer/components/bots/BotChatView.tsx', 'utf8')).not.toContain('sendModeThreadId')
    // An open question or a waiting approval answers with Enter; the mode does not apply there.
    ;({ onSend } = rerender({ sendLabel: 'Answer this question' }))
    expect(modeButton()).toBeNull()
    press()
    expect(onSend.mock.lastCall).toEqual(queue)
  })
})

describe('send mode storage', () => {
  it('belongs to each thread: new threads queue, and the mode outlives a restart', () => {
    render()
    act(() => modeButton()!.click())
    expect(threadSendMode(PROFILE, 'thread-a')).toBe('steer')
    rerender({ thread: 'thread-b' })
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Queue')
    // A restart reads the mode back from storage.
    forgetSendModes()
    rerender({ thread: 'thread-a' })
    expect(modeButton()!.getAttribute('aria-label')).toBe('Send mode: Steer')
    expect(threadSendMode(PROFILE, 'thread-b')).toBe('queue')
    // Another profile on this computer has its own.
    expect(threadSendMode('profile-2', 'thread-a')).toBe('queue')
    act(() => modeButton()!.click())
    forgetSendModes()
    expect(threadSendMode(PROFILE, 'thread-a')).toBe('queue')
  })

  it('reads unreadable storage as Queue', () => {
    localStorage.setItem(`mousse-profile-${PROFILE}-steerThreads.v1`, '{not json')
    forgetSendModes()
    expect(threadSendMode(PROFILE, 'thread-a')).toBe('queue')
    setThreadSendMode(PROFILE, 'thread-a', 'steer')
    expect(JSON.parse(localStorage.getItem(`mousse-profile-${PROFILE}-steerThreads.v1`)!)).toEqual(['thread-a'])
  })
})
