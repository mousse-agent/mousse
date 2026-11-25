// @vitest-environment jsdom
/**
 * The setup card a thread's agent opened with `computer_use_request`, above OrchestratorChat's composer: it shows what the
 * service holds for the thread (not the transcript), stays after the turn, and acts on this computer only through
 * `computerUse.*` and the computer use switch: Install & enable installs first and turns computer use on only once the
 * driver runs, then looks again; a failed installer is said and turns nothing on; Not now closes it; another window's
 * change shows at once.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MousseSettings } from '../../src/shared/settings'
import type { ChatMessage, Thread } from '../../src/shared/types'
import type { ComputerUseSetupRequestView, ComputerUseStatus } from '../../src/shared/computerUse'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and what sits above it.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const now = new Date().toISOString()
const THREAD: Thread = { id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, modelOverride: { llmProvider: 'claude-subscription', model: 'opus' } } as unknown as Thread
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode: 'accept_edits' },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)

const OPEN: ComputerUseSetupRequestView = { requestId: 'cur_1', threadId: 'thread-a', originThreadId: 'thread-a', hostName: 'Ada', reason: 'Open Figma to export the logo', createdAt: now }
const missing: ComputerUseStatus = { state: 'missing', enabled: false, installable: true }
const found: ComputerUseStatus = { state: 'found', enabled: false, installable: true, source: 'default', path: '/bin/cua-driver' }

/** This computer's service as the card reaches it, and everything the window asked of it, in order. */
interface Service {
  request: ComputerUseSetupRequestView | null
  status: ComputerUseStatus
  install: () => ComputerUseStatus
  log: Array<[string, unknown]>
  changed: Array<(payload: { threadId: string }) => void>
}
let service: Service
let root: Root
let host: HTMLElement

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
  const answer = async (method: string, params: Record<string, unknown>) => {
    if (!method.startsWith('computerUse.')) return pending()
    service.log.push([method, params])
    if (method === 'computerUse.setupRequest.get') return { request: params.threadId === service.request?.threadId ? service.request : null }
    if (method === 'computerUse.status') return service.status
    if (method === 'computerUse.install') return (service.status = service.install())
    if (method === 'computerUse.setupRequest.dismiss') {
      service.request = null
      return { dismissed: true }
    }
    return pending()
  }
  const sections: Record<string, unknown> = {
    settings: section({
      get: () => Promise.resolve(settings()),
      getOptions: () => Promise.resolve({ themes: [], accentColors: [], llmProviders: [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }], agentTypes: [] }),
      onChanged: () => () => undefined,
      set: async (partial: { agentAccess?: { computerUse?: boolean } }) => {
        service.log.push(['settings.set', partial])
        if (partial.agentAccess?.computerUse === true) service.status = { ...service.status, enabled: true }
        return settings()
      }
    }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    platformRequest: section({ request: answer }),
    orchestrator: section({
      onComputerUseSetupRequestChanged: (listener: (payload: { threadId: string }) => void) => {
        service.changed.push(listener)
        return () => { service.changed = service.changed.filter((entry) => entry !== listener) }
      }
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

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function renderChat(messages: ChatMessage[] = [{ id: 'm-1', role: 'user', content: 'Export the logo', timestamp: now } as ChatMessage]): Promise<void> {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({ profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, settingsOpen: false, activeThreadId: THREAD.id, threads: [THREAD], messages })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

const card = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Set up computer use"]')
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label)
const click = async (label: string) => {
  const target = button(label)
  if (!target) throw new Error(`no ${label} button in: ${host.textContent}`)
  await act(async () => { target.click() })
  await settle()
}
const changed = async (threadId = THREAD.id) => {
  await act(async () => { for (const listener of service.changed) listener({ threadId }) })
  await settle()
}
const asked = (method: string) => service.log.filter(([name]) => name === method)
const turnedOn = () => service.log.filter(([name, partial]) => name === 'settings.set' && (partial as { agentAccess?: unknown }).agentAccess)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  service = { request: OPEN, status: found, install: () => found, log: [], changed: [] }
  stubBridge()
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

describe('the computer use setup card above the composer', () => {
  it("shows the agent's reason, says it applies to the whole profile, and Not now closes it for this thread", async () => {
    await renderChat()
    expect(card()?.textContent).toContain('Open Figma to export the logo')
    expect(card()?.textContent).toContain('Applies to all agents in this profile.')
    expect(button('Enable')).toBeDefined()
    // It is the composer's, not a transcript row's: it stays as the thread's turn ends with the agent's reply.
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await act(async () => useAppStore.setState({ messages: [...useAppStore.getState().messages, { id: 'm-2', role: 'assistant', content: 'I asked for computer use; carrying on.', timestamp: now } as ChatMessage] }))
    await settle()
    expect(card()?.textContent).toContain('Open Figma to export the logo')
    await click('Not now')
    expect(asked('computerUse.setupRequest.dismiss')).toEqual([['computerUse.setupRequest.dismiss', { threadId: 'thread-a', requestId: 'cur_1' }]])
    expect(card()).toBeNull()
    expect(turnedOn()).toEqual([])
  })

  it('Install & enable installs, then turns computer use on, then looks at the driver again', async () => {
    service.status = missing
    service.install = () => found
    await renderChat()
    await click('Install & enable')
    const order = service.log.map(([name, params]) => (name === 'computerUse.status' ? `status${(params as { refresh?: boolean }).refresh ? ' refresh' : ''}` : name)).filter((name) => name !== 'computerUse.setupRequest.get')
    expect(order.slice(order.indexOf('computerUse.install'))).toEqual(['computerUse.install', 'settings.set', 'status refresh'])
    expect(turnedOn()).toEqual([['settings.set', { agentAccess: { computerUse: true } }]])
    expect(host.textContent).toContain('Computer use is enabled')
  })

  it("Enable on a driver that runs turns computer use on and looks again", async () => {
    await renderChat()
    await click('Enable')
    expect(turnedOn()).toHaveLength(1)
    expect(asked('computerUse.status').at(-1)).toEqual(['computerUse.status', { refresh: true }])
    expect(host.textContent).toContain('Computer use is enabled')
  })

  it('an installer that failed while a driver was already there is said, kept through a refresh, and turns nothing on', async () => {
    service.status = missing
    service.install = () => ({ ...found, error: 'The installer failed: network down' })
    await renderChat()
    await click('Install & enable')
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain('The installer failed: network down')
    expect(turnedOn()).toEqual([])
    expect(host.textContent).not.toContain('Computer use is enabled')
    // The service's next look no longer carries the error; the card still says it.
    service.status = found
    await changed()
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain('The installer failed: network down')
    expect(turnedOn()).toEqual([])
  })

  it("follows another window: a card opened or closed there shows here at once, and another thread's change reads nothing", async () => {
    service.request = null
    await renderChat()
    expect(card()).toBeNull()
    service.request = OPEN
    const reads = asked('computerUse.setupRequest.get').length
    await changed('thread-b')
    expect(asked('computerUse.setupRequest.get')).toHaveLength(reads)
    await changed()
    expect(card()?.textContent).toContain('Open Figma to export the logo')
    service.request = null
    await changed()
    expect(card()).toBeNull()
  })

  it('a past or refused computer_use_request in the transcript offers nothing without an open card', async () => {
    service.request = null
    const row = {
      id: 'tool-1', role: 'assistant', content: '', timestamp: now,
      toolCall: { title: 'computer_use_request', summary: '', details: [], toolName: 'mcp__mousse__computer_use_request', status: 'complete' },
      activity: { id: 'a1', callId: 'c1', kind: 'generic', toolName: 'mcp__mousse__computer_use_request', status: 'done', startedAt: now, output: '[computer-use:setup_needed] Computer use is not set up on Ada: Cua Driver needs installing.' }
    } as unknown as ChatMessage
    await renderChat([row])
    expect(card()).toBeNull()
    for (const label of ['Not now', 'Enable', 'Install & enable', 'Install', 'Reinstall']) expect(button(label)).toBeUndefined()
    expect(host.textContent).not.toMatch(/asked to set up computer use/)
  })
})
