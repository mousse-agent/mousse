// @vitest-environment jsdom
/**
 * While the app is not connected to its background service, a composer says Connecting… in place of its placeholder,
 * its toolbar's controls (model, attach, dictate, send) are out of reach, the draft stays and can be edited, and
 * nothing is sent. The state comes from main through the window's bridge (`app.serviceConnection`,
 * `app.onServiceConnectionChanged`); a drop shorter than CONNECTING_SHOWN_AFTER_MS shows nothing.
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import type { ComposerRunProps } from '../../src/renderer/components/ComposerFooter'
import { CONNECTING_SHOWN_AFTER_MS, forgetServiceConnection } from '../../src/renderer/lib/serviceConnection'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The microphone pulls in audio worklets jsdom does not have; these tests never record.
vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: () => ({ isRecording: false, recordingPending: false, transcribing: false, recordingDuration: 0, levels: null, error: undefined, dismissError: () => {}, notice: null, start: () => {}, stop: () => {}, cancel: () => {} })
}))

const NORMAL_PLACEHOLDER = 'Ask anything · / commands and skills · @ files'

let root: Root
let host: HTMLElement
/** Main's change events, as the bridge delivers them. */
let changed: ((state: string) => void) | null

/** The window's bridge, with main answering `initial` when asked. */
function stubBridge(initial: string | Promise<string>): void {
  changed = null
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: {
      serviceConnection: vi.fn(async () => initial),
      onServiceConnectionChanged: (listener: (state: string) => void) => {
        changed = listener
        return () => { changed = null }
      }
    }
  }
}

const service = (state: string) => act(() => changed!(state))
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
const settle = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView ??= () => {}
  forgetServiceConnection()
  useAppStore.setState({ profileId: 'profile-1', activeThreadId: 'thread-a', appInfo: { platform: 'win32' } as never })
  host = document.createElement('div')
  host.className = 'chat-input-area'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  forgetServiceConnection()
  useAppStore.setState({ appInfo: null, activeThreadId: null })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function run(): ComposerRunProps {
  return {
    providers: [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }], caps: { toolControl: 'exact', autoPermissionMode: true, contextUsage: 'none' } } as never],
    selectedProviderId: 'claude-subscription',
    selectedModelId: 'opus',
    modelMenuOpen: false,
    onModelMenuOpenChange: () => {},
    onModelSelect: () => {},
    onOpenSettings: () => {},
    contextUsage: { used: 0, limit: 0, percent: 0 } as never,
    contextOpen: false,
    onContextOpenChange: () => {}
  }
}

/** The thread composer as the chat mounts it: a draft the parent keeps, the model picker, attach, dictate and send. */
function render(draft = 'check the release notes') {
  const onSend = vi.fn()
  function Harness() {
    const [input, setInput] = useState(draft)
    const props: ChatComposerProps = {
      input,
      onInputChange: setInput,
      attachedFiles: [],
      onAttachedFilesChange: () => {},
      voiceMessages: [],
      onVoiceMessagesChange: () => {},
      enabledSkills: [],
      run: run(),
      onSend
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
  return { onSend }
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea')!
/** The controls a person can reach: buttons by name, leaving out what is inert or hidden from assistive technology. */
const reachable = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
  .filter((button) => !button.closest('[inert], [aria-hidden="true"]'))
  .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
const statusText = () => [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(' ')
const press = () => act(() => {
  box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})
const type = (text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
  box().dispatchEvent(new Event('input', { bubbles: true }))
})

describe('the composer while the service is out of reach', () => {
  it('says Connecting…, hides its controls, keeps the draft and sends nothing; connected again, all of it returns', async () => {
    stubBridge('ready')
    const { onSend } = render()
    await settle()
    expect(box().placeholder).toBe(NORMAL_PLACEHOLDER)
    expect(reachable()).toEqual(expect.arrayContaining(['Model: Opus 5.5', 'Attach files', 'Dictate', 'Send message']))

    service('reconnecting')
    await wait(CONNECTING_SHOWN_AFTER_MS)
    expect(box().placeholder).toBe('Connecting…')
    // The draft hides the placeholder, so the toolbar's row says it.
    expect(statusText()).toContain('Connecting…')
    const controls = reachable()
    for (const name of ['Model: Opus 5.5', 'Attach files', 'Dictate', 'Send message']) expect(controls).not.toContain(name)
    expect(box().value).toBe('check the release notes')

    // The draft can still be edited; Enter sends nothing.
    type('check the release notes and the changelog')
    press()
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('check the release notes and the changelog')

    // A reconnect attempt that fails and the next one keep it showing.
    service('failed')
    service('reconnecting')
    expect(box().placeholder).toBe('Connecting…')

    service('ready')
    expect(box().placeholder).toBe(NORMAL_PLACEHOLDER)
    expect(statusText()).not.toContain('Connecting…')
    expect(reachable()).toEqual(expect.arrayContaining(['Model: Opus 5.5', 'Attach files', 'Dictate', 'Send message']))
    press()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(box().value).toBe('check the release notes and the changelog')
  })

  it('says it in the placeholder alone while the box is empty', async () => {
    stubBridge('ready')
    render('')
    await settle()
    service('connecting')
    await wait(CONNECTING_SHOWN_AFTER_MS)
    expect(box().placeholder).toBe('Connecting…')
    expect(statusText()).not.toContain('Connecting…')
  })

  it('shows nothing for a drop shorter than the delay', async () => {
    stubBridge('ready')
    const { onSend } = render()
    await settle()
    const placeholders: string[] = []
    const observer = new MutationObserver(() => placeholders.push(box().placeholder))
    observer.observe(host, { subtree: true, attributes: true, childList: true })
    service('reconnecting')
    await wait(CONNECTING_SHOWN_AFTER_MS - 100)
    service('ready')
    await wait(CONNECTING_SHOWN_AFTER_MS * 3)
    observer.disconnect()
    expect(placeholders).not.toContain('Connecting…')
    expect(box().placeholder).toBe(NORMAL_PLACEHOLDER)
    press()
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  // What main may answer when a window opens: only `ready` is connected.
  const OPENED_WHILE: Array<[string, boolean]> = [
    ['ready', false],
    ['idle', true],
    ['starting_daemon', true],
    ['connecting', true],
    ['reconnecting', true],
    ['failed', true],
    ['stopped', true]
  ]
  for (const [state, connecting] of OPENED_WHILE) {
    it(`a window opened while the service is ${state} ${connecting ? 'says Connecting…' : 'shows the composer as usual'}`, async () => {
      stubBridge(state)
      render()
      await settle()
      await wait(CONNECTING_SHOWN_AFTER_MS)
      expect(box().placeholder).toBe(connecting ? 'Connecting…' : NORMAL_PLACEHOLDER)
      expect(reachable().includes('Send message')).toBe(!connecting)
    })
  }

  it('a change heard before main answers the first ask wins over that answer', async () => {
    let answer!: (state: string) => void
    stubBridge(new Promise<string>((resolve) => { answer = resolve }))
    render()
    service('reconnecting')
    answer('ready')
    await settle()
    await wait(CONNECTING_SHOWN_AFTER_MS)
    expect(box().placeholder).toBe('Connecting…')
  })
})
