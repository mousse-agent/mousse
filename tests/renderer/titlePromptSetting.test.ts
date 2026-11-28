// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import type { OneShotRequest } from '../../src/mms/harness/gateway'
import { getDefaultSettings, type LlmProviderOption, type SettingsOptions, type TitleOptions } from '../../src/shared/settings'
import { TITLE_SYSTEM_PROMPT } from '../../src/shared/threadTitleText'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLAUDE = { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'haiku', label: 'Haiku 5.5', title: { state: 'held', route: 'claude:cli' } }] } as LlmProviderOption
const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [CLAUDE], agentTypes: [], botProviders: [CLAUDE] }

describe('the title prompt row', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-title-prompt-'))
    store = new SettingsStore(MousseConfigStore.load(home))
    store.set({ title: { llmProvider: 'claude-subscription', model: 'haiku', instanceId: 'claude' } })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  /** Settings > Agents wired to a real settings store, the way Settings wires it to the daemon. */
  const show = () => {
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options: OPTIONS,
      updateSettings: async (partial) => {
        store.set(partial)
        draw()
      }
    })))
    draw()
  }
  const box = () => host.querySelector<HTMLTextAreaElement>('#agents-title-prompt')
  const add = () => [...host.querySelectorAll<HTMLButtonElement>('[data-settings-anchor="agents-title-prompt"] button')].find((button) => button.textContent === 'Add')
  const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().title.prompt
  const type = (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(box()!, text)
      box()!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const blur = () => act(() => box()!.blur())

  it('shows only Add while empty, saves what is typed when the box loses focus, and keeps the box while it has text', () => {
    show()
    expect(box()).toBeNull()
    act(() => add()!.click())
    expect(document.activeElement).toBe(box())
    type('  Start each title with an emoji  ')
    blur()
    expect(saved()).toBe('Start each title with an emoji')
    expect(box()!.value).toBe('Start each title with an emoji')
    expect(add()).toBeUndefined()
  })

  it('removes the prompt when its text is cleared, and goes back to Add', () => {
    store.set({ title: { prompt: 'Always in English' } })
    show()
    act(() => box()!.focus())
    type('')
    blur()
    expect(saved()).toBeUndefined()
    expect(box()).toBeNull()
    expect(add()).toBeDefined()
  })

  it('Escape leaves the saved prompt as it was', () => {
    store.set({ title: { prompt: 'Always in English' } })
    show()
    act(() => box()!.focus())
    type('Something else')
    act(() => { box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(saved()).toBe('Always in English')
    expect(box()!.value).toBe('Always in English')
  })

  it('keeps the prompt when the title model changes or goes back to Automatic', () => {
    store.set({ title: { prompt: 'Always in English' } })
    store.set({ title: { llmProvider: '', model: '' } })
    expect(saved()).toBe('Always in English')
    store.set({ title: { llmProvider: 'claude-subscription', model: 'haiku', instanceId: 'claude' } })
    expect(saved()).toBe('Always in English')
  })
})

describe('First line only', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-title-mode-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  /** Settings > Agents over a real settings store, with `providers` connected. */
  const show = (providers: LlmProviderOption[] = [CLAUDE]) => {
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options: { ...OPTIONS, llmProviders: providers, botProviders: providers },
      updateSettings: async (partial) => {
        store.set(partial)
        draw()
      }
    })))
    draw()
  }
  /** The title settings as a restarted daemon reads them from disk. */
  const reloaded = () => new SettingsStore(MousseConfigStore.load(home)).get().title
  const picker = () => host.querySelector<HTMLButtonElement>('#agents-title-model')!
  const firstLineOnly = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'First line only')
  const useAutomatic = () => host.querySelector<HTMLButtonElement>('button[aria-label="Use automatic"]')
  const promptRow = () => host.querySelector<HTMLElement>('[data-settings-anchor="agents-title-prompt"]')!
  const mouseDown = (target: Element) => act(() => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })

  it('is offered with no connected model, in a menu at the picker that an outside click closes, and is saved', () => {
    show([])
    expect(picker().disabled).toBe(false)
    act(() => picker().click())
    const choice = firstLineOnly()!
    // The menu is its own floating layer, outside the settings page, as the picker's menu is with models listed.
    expect(host.contains(choice)).toBe(false)
    // A click inside the menu keeps it open; one outside closes it.
    mouseDown(choice)
    expect(firstLineOnly()).toBeDefined()
    mouseDown(document.body)
    expect(firstLineOnly()).toBeUndefined()

    act(() => picker().click())
    act(() => firstLineOnly()!.click())
    expect(reloaded().mode).toBe('off')
    expect(picker().getAttribute('aria-label')).toContain('First line only')
  })

  it('Use automatic leaves First line only and keeps the title prompt', () => {
    store.set({ title: { prompt: 'Always in English' } })
    store.set({ title: { llmProvider: '', model: '', mode: 'off' } })
    show()
    act(() => useAutomatic()!.click())
    expect(reloaded()).toMatchObject({ prompt: 'Always in English' })
    expect(reloaded().mode).toBeUndefined()
    expect(useAutomatic()).toBeNull()
  })

  it('a chosen model replaces First line only, and clearing it later goes back to Automatic', () => {
    store.set({ title: { llmProvider: '', model: '', mode: 'off' } })
    store.set({ title: { llmProvider: 'claude-subscription', model: 'haiku', instanceId: 'claude' } })
    store.set({ title: { llmProvider: '', model: '' } })
    expect(reloaded().mode).toBeUndefined()
  })

  it('turns the title prompt off only for First line only', () => {
    store.set({ title: { prompt: 'Always in English' } })
    show()
    expect(host.querySelector<HTMLTextAreaElement>('#agents-title-prompt')!.disabled).toBe(false)
    store.set({ title: { prompt: '' } })
    show()
    expect(promptRow().querySelector('button')!.disabled).toBe(false)

    store.set({ title: { llmProvider: '', model: '', mode: 'off' } })
    show()
    expect(promptRow().querySelector('button')!.disabled).toBe(true)
    store.set({ title: { prompt: 'Always in English' } })
    show()
    expect(host.querySelector<HTMLTextAreaElement>('#agents-title-prompt')!.disabled).toBe(true)
    // The text is kept for when a model names threads again.
    expect(reloaded().prompt).toBe('Always in English')
  })
})

describe('a title request with a title prompt', () => {
  const messages = [{ id: 'm1', role: 'user', content: 'Fix the OAuth callback retries in the login flow', timestamp: 1 }] as ChatMessage[]

  function orchestrator(prompt?: string) {
    const settings = { ...getDefaultSettings(), title: { llmProvider: 'claude-subscription', model: 'haiku', instanceId: 'claude', ...(prompt ? { prompt } : {}) } }
    const oneShot = vi.fn(async (_request: OneShotRequest) => ({ text: 'Fix OAuth callback retries' }))
    const orch = Object.assign(Object.create(OrchestratorService.prototype), {
      settingsStore: { get: () => settings },
      harness: { oneShot },
      threadScope: () => undefined
    }) as OrchestratorService
    return { orch, oneShot }
  }

  it('sends the person\'s prompt after the rules, and not as part of the model selection', async () => {
    const { orch, oneShot } = orchestrator('Start each title with an emoji')
    await orch.generateThreadTitle(messages, 't1')
    const request = oneShot.mock.calls[0]![0]
    expect(request.system.startsWith(TITLE_SYSTEM_PROMPT)).toBe(true)
    expect(request.system.endsWith('Start each title with an emoji')).toBe(true)
    expect(request.selection).not.toHaveProperty('prompt')
  })

  it('sends the rules alone without one', async () => {
    const { orch, oneShot } = orchestrator()
    await orch.generateThreadTitle(messages, 't1')
    expect(oneShot.mock.calls[0]![0].system).toBe(TITLE_SYSTEM_PROMPT)
  })
})

describe('the Thread titles row with Antigravity connected', () => {
  const ANTIGRAVITY = { id: 'antigravity', instanceId: 'antigravity', label: 'Antigravity', models: [{ id: 'gemini-flash', label: 'Gemini Flash', title: { state: 'best_effort', route: 'acp:antigravity', facts: ['Its own tools could still run before Mousse stops them.'] } }] } as LlmProviderOption
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const note = (providers: LlmProviderOption[], title: Partial<ReturnType<typeof getDefaultSettings>['title']> = {}) => {
    const settings = getDefaultSettings()
    act(() => root.render(createElement(AgentsSettings, {
      settings: { ...settings, title: { ...settings.title, ...title } },
      options: { ...OPTIONS, llmProviders: providers },
      updateSettings: async () => {}
    })))
    return [...host.querySelectorAll<HTMLElement>('[data-settings-anchor="agents-title-model"] span[title]')].find((span) => span.textContent?.includes('best-effort'))
  }

  it('says Antigravity naming is best-effort, with why in its tooltip, when Automatic may pick it or it is chosen', () => {
    expect(note([CLAUDE, ANTIGRAVITY])?.title).toContain('could still run')
    expect(note([CLAUDE, ANTIGRAVITY], { llmProvider: 'antigravity', instanceId: 'antigravity', model: 'gemini-flash' })).toBeDefined()
  })

  it('says nothing of it when Antigravity cannot name threads: not connected, another model chosen, or First line only', () => {
    expect(note([CLAUDE])).toBeUndefined()
    expect(note([CLAUDE, ANTIGRAVITY], { llmProvider: 'claude-subscription', instanceId: 'claude', model: 'haiku' })).toBeUndefined()
    expect(note([CLAUDE, ANTIGRAVITY], { mode: 'off' })).toBeUndefined()
  })
})

describe('the Thread titles row reads the cached title listing', () => {
  const AGENT = {
    id: 'acp:scripted', instanceId: 'acp:scripted', label: 'Scripted agent',
    models: [{ id: 'default', label: 'Agent default', title: { state: 'best_effort', route: 'acp:generic', facts: ['The agent has tools of its own.'] } }]
  } as LlmProviderOption
  const UNABLE = { ...AGENT, id: 'acp:other', instanceId: 'acp:other', label: 'Other agent', models: [{ id: 'default', label: 'Agent default', title: { state: 'unavailable', reason: 'Other agent has not been checked yet.' } }] } as LlmProviderOption
  const OFF = { instanceId: 'acp:off', driver: 'acp', label: 'Turned-off agent', models: [], reason: 'Turned-off agent is turned off.' }
  let root: Root
  let host: HTMLElement
  const mousse = (globalThis as { window: { mousse?: unknown } }).window
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete mousse.mousse
  })
  /** Settings → Agents with the daemon's cached listing (`settings.titleOptions`); `getOptions` still waits on checks. */
  const show = async (titleOptions: TitleOptions, title: Partial<ReturnType<typeof getDefaultSettings>['title']> = {}) => {
    const getTitleOptions = vi.fn(async () => titleOptions)
    mousse.mousse = { settings: { getTitleOptions } }
    const settings = getDefaultSettings()
    await act(async () => root.render(createElement(AgentsSettings, {
      settings: { ...settings, title: { ...settings.title, ...title } },
      // The slow listing has nothing yet: the row reads the cached one alone.
      options: { ...OPTIONS, llmProviders: [] },
      updateSettings: async () => {}
    })))
    const row = host.querySelector<HTMLElement>('[data-settings-anchor="agents-title-model"]')!
    return { row, spans: [...row.querySelectorAll<HTMLElement>('span[title]')], getTitleOptions }
  }

  it('a best-effort model says so, with the facts behind it in its tooltip, from the cached listing alone', async () => {
    const { spans, getTitleOptions } = await show({ llmProviders: [CLAUDE, AGENT] }, { llmProvider: 'acp:scripted', instanceId: 'acp:scripted', model: 'default' })
    expect(getTitleOptions).toHaveBeenCalled()
    expect(spans.find((span) => span.textContent?.includes('best-effort'))?.title).toBe('The agent has tools of its own.')
  })

  it('entries that cannot name threads are listed in the picker with their reason', async () => {
    const entries = [{ instanceId: 'acp:other', driver: 'acp', label: 'Other agent', models: [{ id: 'default', label: 'Agent default', state: 'unavailable' as const, reason: 'Other agent has not been checked yet.' }] }, OFF]
    const { row } = await show({ llmProviders: [CLAUDE, UNABLE], titleListing: { entries } })
    await act(async () => row.querySelector<HTMLButtonElement>('#agents-title-model')!.click())
    const disabled = [...document.querySelectorAll<HTMLElement>('[role="option"][aria-disabled="true"]')].map((option) => option.title)
    expect(disabled).toEqual(expect.arrayContaining(['Other agent has not been checked yet.', 'Turned-off agent is turned off.']))
  })

  it("a model whose request runs as another names that model in its row's tooltip", async () => {
    const GROK = { id: 'grok', instanceId: 'grok', label: 'Grok', models: [{ id: 'default', label: 'Agent default', title: { state: 'held', route: 'grok:direct', runsAs: 'grok-4.7' } }] } as LlmProviderOption
    // One provider: the menu shows a single list, with no rail to choose from.
    const { row } = await show({ llmProviders: [GROK] })
    await act(async () => row.querySelector<HTMLButtonElement>('#agents-title-model')!.click())
    const titles = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.title)
    expect(titles).toEqual([expect.stringContaining('Runs as grok-4.7')])
  })

  it('a saved choice that cannot name threads shows its exact reason; a reason read for an earlier choice is not shown', async () => {
    const saved = { instanceId: 'acp:other', model: 'default', label: 'Other default', state: 'unavailable' as const, reason: 'Other agent has not been checked yet.' }
    const listing = { llmProviders: [CLAUDE, UNABLE], titleListing: { entries: [], saved } }
    const now = await show(listing, { llmProvider: 'acp:other', instanceId: 'acp:other', model: 'default' })
    expect(now.row.textContent).toContain("Other default can't name threads here")
    expect(now.spans.some((span) => span.title === 'Other agent has not been checked yet.')).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    // Haiku chosen since: the listing read before still describes the old choice.
    const later = await show(listing, { llmProvider: 'claude-subscription', instanceId: 'claude', model: 'haiku' })
    expect(later.row.textContent).not.toContain("can't name threads")
  })
})
