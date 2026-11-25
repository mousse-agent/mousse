// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

// The Claude Code list as a gateway reports it: Opus first, then models a person rarely means to pick.
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const catalog = (): LlmProviderOption[] => [{
  id: 'claude-subscription',
  label: 'Claude Code',
  models: [
    { id: 'opus', label: 'Opus 5.5', efforts },
    { id: 'claude-fable-5', label: 'Claude Fable 5', efforts },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', efforts },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', efforts },
    { id: 'claude-fable-5-dd-weiver-otua-xedoc', label: 'Codex Auto Review', efforts },
    { id: 'claude-fable-5-dd-los-2.6-tpg', label: 'GPT 6.2 Sol', efforts }
  ]
} as unknown as LlmProviderOption]
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode: 'accept_edits' },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)

const now = new Date().toISOString()
const thread = (model: string, effort?: string): Thread => ({
  id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0,
  modelOverride: { llmProvider: 'claude-subscription', model, ...(effort ? { effort } : {}) }
}) as unknown as Thread

let root: Root
let host: HTMLElement
let setModel: ReturnType<typeof vi.fn>

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
    threads: section({ setModel: (...args: unknown[]) => setModel(...args) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await wait(0) }

const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.model-picker-row')].find((entry) => entry.querySelector('.model-picker-row-title')!.textContent === name)!
const column = () => document.querySelector<HTMLElement>('.model-picker-run')!
const columnFor = () => document.querySelector('.model-picker-run [role="menu"]')?.getAttribute('aria-label')
const saved = () => setModel.mock.calls.map(([, override]) => ({ model: override.model, effort: override.effort }))

let under: Element | null = null
/** Moves the pointer onto `target` at (x, y), as the browser reports it: out of the last element, over this one, a move. */
async function pointTo(target: Element, x: number, y: number): Promise<void> {
  await act(async () => {
    if (under && under !== target) under.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: target, clientX: x, clientY: y }))
    if (under !== target) target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: under, clientX: x, clientY: y }))
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }))
  })
  under = target
}

async function openPicker(): Promise<void> {
  await act(async () => { host.querySelector<HTMLButtonElement>('.composer-model-btn')!.click() })
  await settle(2)
}

async function clickLevel(name: string): Promise<void> {
  const level = [...document.querySelectorAll<HTMLElement>('.model-picker-level')].find((button) => button.firstElementChild?.textContent === name)!
  await act(async () => { level.click() })
  await settle(3)
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  under = null
  setModel = vi.fn(async (_id: string, override: { model: string; effort?: string }) => thread(override.model, override.effort))
  stubBridge()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, settingsOpen: false,
    activeThreadId: 'thread-a', threads: [thread('claude-fable-5-dd-los-2.6-tpg', 'high')],
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }]
  })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
  await openPicker()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Moves the pointer down and right from Opus 5.5 across the rows under it, resting on each, then onto the levels. */
async function driftFromOpusToTheLevels(): Promise<void> {
  for (const [step, name] of ['Opus 5.5', 'Fable 5', 'Fable 5.1', 'Fable 5.2', 'Codex Auto Review'].entries()) {
    await pointTo(row(name), 100 + step * 40, 60 + step * 30)
    await wait(300)
  }
  await pointTo(column(), 320, 190)
}

// The reported case: on GPT 6.2 Sol at High, the pointer crossed Opus 5.5 and the rows under it on the way to
// Extra high, and the thread was saved as Codex Auto Review at Extra high.
it('hovering other models on the way to a level leaves the column on the selected model, and the level applies to it', async () => {
  expect(columnFor()).toBe('Reasoning for GPT 6.2 Sol')
  await driftFromOpusToTheLevels()
  expect(columnFor()).toBe('Reasoning for GPT 6.2 Sol')

  await clickLevel('Extra high')
  expect(saved()).toEqual([{ model: 'claude-fable-5-dd-los-2.6-tpg', effort: 'xhigh' }])
  expect(host.querySelector('.composer-model-btn')?.getAttribute('aria-label')).toBe('Model: GPT 6.2 Sol Extra high')
})

it('clicking Opus 5.5 selects Opus 5.5 at Medium, its listing naming no default level', async () => {
  await act(async () => { row('Opus 5.5').querySelector<HTMLButtonElement>('.model-picker-row-main')!.click() })
  await settle(3)
  expect(saved()).toEqual([{ model: 'opus', effort: 'medium' }])
  expect(host.querySelector('.composer-model-btn')?.getAttribute('aria-label')).toBe('Model: Opus 5.5 Medium')
})
