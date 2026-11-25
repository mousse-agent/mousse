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
    { id: 'claude-fable-5-dd-weiver-otua-xedoc', label: 'Codex Auto Review', efforts }
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

// Where the reasoning column sits beside the list; jsdom has no layout.
const COLUMN = { left: 300, right: 456, top: 40, bottom: 240 }

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
  const rect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('model-picker-run')) return { ...COLUMN, x: COLUMN.left, y: COLUMN.top, width: COLUMN.right - COLUMN.left, height: COLUMN.bottom - COLUMN.top, toJSON: () => ({}) } as DOMRect
    return rect.call(this)
  })
  under = null
  setModel = vi.fn(async (_id: string, override: { model: string; effort?: string }) => thread(override.model, override.effort))
  stubBridge()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, settingsOpen: false,
    activeThreadId: 'thread-a', threads: [thread('claude-fable-5-1', 'high')],
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

/** Rests on Opus, then drifts down and right across the rows under it, lingering on each as a slow hand does. */
async function driftFromOpusTowardsTheLevels(names: string[]): Promise<void> {
  await pointTo(row('Opus 5.5'), 100, 60)
  await wait(150)
  expect(columnFor()).toBe('Reasoning for Opus 5.5')
  for (const [step, name] of names.entries()) {
    await pointTo(row(name), 140 + step * 40, 90 + step * 30)
    await wait(150)
  }
}

it('a level picked after crossing other models on the way to it is the level of the model the pointer left', async () => {
  await driftFromOpusTowardsTheLevels(['Fable 5', 'Fable 5.1', 'Fable 5.2', 'Codex Auto Review'])
  await pointTo(column(), 320, 190)
  expect(columnFor()).toBe('Reasoning for Opus 5.5')

  await clickLevel('Extra high')
  expect(saved()).toEqual([{ model: 'opus', effort: 'xhigh' }])
  expect(host.querySelector('.composer-model-btn')?.getAttribute('aria-label')).toBe('Model: Opus 5.5 Extra high')
})

it('the column follows the pointer down the list when it is not heading for the levels', async () => {
  await pointTo(row('Opus 5.5'), 100, 60)
  await wait(150)
  await pointTo(row('Fable 5'), 100, 90)
  await pointTo(row('Fable 5.2'), 100, 150)
  await wait(150)
  expect(columnFor()).toBe('Reasoning for Fable 5.2')
})

it('a model the pointer stops on, on the way to the levels, shows its levels once it rests', async () => {
  await driftFromOpusTowardsTheLevels(['Fable 5', 'Fable 5.2'])
  expect(columnFor()).toBe('Reasoning for Opus 5.5')
  await wait(300)
  expect(columnFor()).toBe('Reasoning for Fable 5.2')
})
