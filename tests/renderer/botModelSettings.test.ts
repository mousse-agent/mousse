// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { LlmProviderOption, SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLAUDE = { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet 5' }, { id: 'opus', label: 'Opus 5.5' }] } as LlmProviderOption
const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [CLAUDE], agentTypes: [], botProviders: [CLAUDE] }

describe('the bot model picker', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-bot-model-picker-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  /** Settings > Agents wired to a real settings store, the way Settings wires it to the daemon. */
  const show = (options: SettingsOptions = OPTIONS) => {
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options,
      projects: [],
      updateSettings: async (partial) => {
        store.set(partial)
        draw()
      }
    })))
    draw()
  }
  const picker = () => host.querySelector<HTMLButtonElement>('#agents-bot-model')!
  const row = () => picker().closest('.settings-row') ?? host

  it('starts on Automatic, saves a chosen model with its entry, and goes back to Automatic', () => {
    show()
    expect(picker().getAttribute('aria-label')).toBe('Bot model: Automatic')
    act(() => picker().click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.includes('Sonnet 5'))!
    act(() => option.click())
    expect(new SettingsStore(MousseConfigStore.load(home)).get().botModel).toEqual({ llmProvider: 'claude-subscription', model: 'sonnet', instanceId: 'claude' })
    expect(picker().getAttribute('aria-label')).toBe('Bot model: Sonnet 5')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Use automatic for bots"]')!.click())
    expect(new SettingsStore(MousseConfigStore.load(home)).get().botModel).toEqual({ llmProvider: '', model: '' })
    expect(picker().getAttribute('aria-label')).toBe('Bot model: Automatic')
  })

  it('says when the saved model cannot run bots now', () => {
    store.set({ botModel: { llmProvider: 'claude-subscription', model: 'opus', instanceId: 'claude' } })
    show({ ...OPTIONS, botProviders: [{ ...CLAUDE, models: [CLAUDE.models[0]!] }] })
    expect(row().textContent).toContain("can't run bots right now, so bots pick a model automatically")
  })
})
