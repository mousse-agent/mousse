// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guiSendFailureAnswer } from '../../src/main/mms/requestErrors'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The composer's draft as it is saved for the next start, when the app quits while a reply streams.
// The transcript is not part of this check: the shell shows the composer only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const PROFILE = 'prf_quit'
const THREAD = 'thread-1'
const catalog = (): LlmProviderOption[] => [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }]
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode: 'accept_edits' },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)
const thread: Thread = {
  id: THREAD, name: 'New Chat', createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z', settingsRevision: 1,
  modelOverride: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
} as Thread

let root: Root
let host: HTMLElement
/** The send that is waiting for its turn, answered by the test. */
let answerSend: ((answer: unknown) => void) | undefined
let sent: string[]

/** `window.mousse` for the composer: settings answer, a send waits for its turn, any other call stays pending. */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    settings: section({
      get: () => Promise.resolve(settings()),
      getOptions: () => Promise.resolve({ themes: [], accentColors: [], llmProviders: catalog(), agentTypes: [] })
    }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    // The thread is new: its first send applies the composer's workspace to it, then is bound to its settings.
    threads: section({
      get: () => Promise.resolve(thread),
      setWorktreeEnabled: () => Promise.resolve(thread),
      applySettings: () => Promise.resolve({ ok: true, thread }),
      select: () => Promise.resolve()
    }),
    orchestrator: section({
      // A send is answered when its turn ends: the whole reply streams while it waits.
      sendToThread: (_threadId: string, request: { content: string }) => {
        sent.push(request.content)
        return new Promise((resolve) => { answerSend = resolve })
      },
      isTurnActive: () => Promise.resolve(true)
    })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Starts the app: the profile's saved workspace is read, and the thread is open. */
async function start() {
  vi.resetModules()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.getState().activateProfile(PROFILE)
  useAppStore.setState({ workspaceReady: true, threads: [thread], activeThreadId: THREAD, messages: [] })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
  return useAppStore
}

/** Quits the app: the window goes, and only what was saved stays. */
function quit(): void {
  act(() => root.unmount())
  host.remove()
}

const composer = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function send(text: string): Promise<void> {
  await type(text)
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

const savedDraft = () => (JSON.parse(window.localStorage.getItem(`mousse-profile-${PROFILE}-workspace`) ?? '{}') as { composerDrafts?: Record<string, string> }).composerDrafts?.[THREAD]

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.localStorage.clear()
  answerSend = undefined
  sent = []
  stubBridge()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the composer draft when the app quits during a reply', () => {
  it('does not bring a sent prompt back after a quit while its reply streams', async () => {
    await start()
    await send('Write the report')
    expect(sent).toEqual(['Write the report'])
    expect(composer().value).toBe('')
    expect(savedDraft()).toBeUndefined()

    // Quitting closes the app's connection while the send waits for its turn; main answers the window as it does then.
    await act(async () => { answerSend!(guiSendFailureAnswer(new Error('Client closed')).answer) })
    await settle()
    expect(composer().value).toBe('')
    expect(savedDraft()).toBeUndefined()

    quit()
    const store = await start()
    expect(store.getState().composerDrafts[THREAD]).toBeUndefined()
    expect(composer().value).toBe('')
    quit()
  })

  it('keeps a typed prompt that was not sent across a quit', async () => {
    await start()
    await type('Half a thought')
    expect(savedDraft()).toBe('Half a thought')
    quit()

    const store = await start()
    expect(store.getState().composerDrafts[THREAD]).toBe('Half a thought')
    expect(composer().value).toBe('Half a thought')
    expect(sent).toEqual([])
    quit()
  })

  it('still gives back a prompt the service refused', async () => {
    await start()
    await send('Run it now')
    await act(async () => { answerSend!({ message: '', actions: [], requestAcknowledged: false, error: { code: 'thread_busy', message: 'Busy' } }) })
    await settle()
    expect(composer().value).toBe('Run it now')
    quit()
  })
})
