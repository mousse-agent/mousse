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
import { getDefaultSettings, type LlmProviderOption, type SettingsOptions } from '../../src/shared/settings'
import { TITLE_SYSTEM_PROMPT } from '../../src/shared/threadTitleText'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLAUDE = { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', oneShot: true, models: [{ id: 'haiku', label: 'Haiku 5.5' }] } as LlmProviderOption
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
