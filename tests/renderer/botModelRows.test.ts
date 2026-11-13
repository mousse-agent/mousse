// @vitest-environment jsdom
/**
 * A bot's model rows (#673) in About and New bot: one control per row, the app's own model picker
 * (`SettingsModelPicker`), fed only the bot's choices. No Automatic, no second dropdown for the level; a row with no
 * pick says Pick a model; Advanced shows each kind of work and closes only by putting Medium work's pick on all work.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotShownRows } from '../../src/shared/bots/personal/methods'
import type { LlmProviderOption } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotModelRows, botRowTitle } = await import('../../src/renderer/components/bots/BotRunsOn')

/** Two entries offering the same model, as `bots.model.choices` sends them for the picker. */
const PROVIDERS: LlmProviderOption[] = [
  { id: 'claude', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }] },
  { id: 'pi', instanceId: 'pi:key', label: 'Anthropic API', models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'], thinkingOff: false }] }
]
const EMPTY: BotShownRows = { talk: null, light: null, medium: null, hard: null }

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

const render = (slots: BotShownRows, extra: { named?: Record<string, string> } = {}) => {
  const onPick = vi.fn()
  const onOneWork = vi.fn()
  act(() => root.render(createElement(BotModelRows, { name: 'Pip', providers: PROVIDERS, slots, onPick, onOneWork, ...extra })))
  return { onPick, onOneWork }
}
const rows = () => [...host.querySelectorAll<HTMLElement>('.bot-model-row')]
const pickerOf = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="Pip's ${label} model"]`)!

/** Opens a row's picker and picks the model the entry named offers. */
function pick(label: string, entry: string) {
  act(() => pickerOf(label).click())
  const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.title.includes(entry))
  if (!option()) act(() => document.querySelector<HTMLElement>(`[role="tab"][aria-label="${entry}"]`)!.click())
  act(() => option()!.click())
}

describe('a bot\'s model rows', () => {
  it('are Talk and Work, each one control: the app\'s model picker, with no Automatic and no second dropdown', () => {
    render(EMPTY)
    expect(rows().map((row) => row.querySelector('.bot-model-row-label')!.textContent)).toEqual(['Talk', 'Work'])
    for (const row of rows()) {
      expect(row.querySelectorAll('button')).toHaveLength(1)
      expect(row.querySelector('.settings-model-picker')).not.toBeNull()
      expect(row.querySelector('.ui-select')).toBeNull()
    }
    expect(pickerOf('Talk').getAttribute('aria-label')).toBe('Pip\'s Talk model: Pick a model')
    act(() => pickerOf('Talk').click())
    expect(document.body.textContent).not.toMatch(/Automatic|By usage/)
  })

  it('a pick names its entry; Work puts it on all three kinds of work', () => {
    const { onPick } = render(EMPTY)
    pick('Talk', 'Anthropic API')
    expect(onPick).toHaveBeenLastCalledWith(['talk'], { instanceId: 'pi:key', model: 'opus' })
    pick('Work', 'Claude Code')
    expect(onPick).toHaveBeenLastCalledWith(['light', 'medium', 'hard'], { instanceId: 'claude', model: 'opus' })
  })

  it('shows a pick with its level, and its entry beside it while two entries offer models; one not offered now says so', () => {
    render({ talk: { instanceId: 'pi:key', model: 'opus', effort: 'high' }, light: { instanceId: 'pi:gone', model: 'opus' }, medium: { instanceId: 'pi:gone', model: 'opus' }, hard: { instanceId: 'pi:gone', model: 'opus' } })
    expect(pickerOf('Talk').getAttribute('aria-label')).toBe('Pip\'s Talk model: Opus 5.5 · High on Anthropic API')
    // The entry is in the closed control, muted, beside the model; each part is cut with an ellipsis on its own.
    const label = pickerOf('Talk').querySelector('.settings-model-btn-label')!
    expect(label.querySelector('.settings-model-btn-model')!.textContent).toBe('Opus 5.5 · High')
    expect(label.querySelector('.settings-model-btn-entry')!.textContent).toBe('· Anthropic API')
    expect(pickerOf('Talk').title).toBe('Opus 5.5 on Anthropic API')
    expect(pickerOf('Work').getAttribute('aria-label')).toBe('Pip\'s Work model: opus · not available')
    expect(pickerOf('Work').title).toBe('Not available now. Pick another model.')
  })

  it('with one entry, a closed row shows the model alone', () => {
    act(() => root.render(createElement(BotModelRows, { name: 'Pip', providers: [PROVIDERS[0]!], slots: { talk: { instanceId: 'claude', model: 'opus' }, light: null, medium: null, hard: null }, onPick: vi.fn(), onOneWork: vi.fn() })))
    expect(pickerOf('Talk').getAttribute('aria-label')).toBe('Pip\'s Talk model: Opus 5.5 · Medium')
    expect(pickerOf('Talk').querySelector('.settings-model-btn-entry')).toBeNull()
  })

  it('on a bot from before picks, Pick a model says Mousse chooses until then', () => {
    render(EMPTY, { named: { talk: 'opus' } })
    expect(pickerOf('Talk').title).toBe('Mousse runs opus by name, on any entry, until you pick one.')
    expect(botRowTitle(PROVIDERS, null)).toBeUndefined()
  })

  it('Advanced shows Light, Medium and Hard work, each starting from Work\'s pick; closing it puts Medium work\'s on all work', () => {
    const opus = { instanceId: 'claude', model: 'opus' }
    const { onOneWork } = render({ talk: opus, light: opus, medium: opus, hard: opus })
    const advanced = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!
    act(() => advanced().click())
    expect(rows().map((row) => row.querySelector('.bot-model-row-label')!.textContent)).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
    expect(pickerOf('Hard work').getAttribute('aria-label')).toBe('Pip\'s Hard work model: Opus 5.5 · Medium on Claude Code')
    // Rows the same as Medium's: closing changes nothing.
    act(() => advanced().click())
    expect(onOneWork).not.toHaveBeenCalled()
    // Rows that differ open it, and closing puts Medium work's pick on all work.
    const differing = render({ talk: opus, light: { ...opus, effort: 'low' }, medium: opus, hard: opus })
    expect(rows()).toHaveLength(4)
    act(() => advanced().click())
    expect(differing.onOneWork).toHaveBeenCalledTimes(1)
  })

  describe('the Images row (#1088)', () => {
    const IMAGE_PROVIDERS: LlmProviderOption[] = [
      { id: 'openrouter', instanceId: 'pi:openrouter', label: 'OpenRouter', models: [{ id: 'google/gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' }] }
    ]
    const opus = { instanceId: 'claude', model: 'opus' }
    const SAME: BotShownRows = { talk: opus, light: opus, medium: opus, hard: opus }
    const renderImage = (image: { providers?: LlmProviderOption[]; pick?: { instanceId: string; model: string } | null; missing?: string }) => {
      const onImage = vi.fn()
      act(() => root.render(createElement(BotModelRows, {
        name: 'Pip', providers: PROVIDERS, slots: SAME, onPick: vi.fn(), onOneWork: vi.fn(),
        image: { providers: image.providers ?? IMAGE_PROVIDERS, pick: image.pick ?? null, ...(image.missing ? { missing: image.missing } : {}), usage: { today: 3, perDay: 20, perTurn: 4 }, onPick: onImage }
      })))
      return onImage
    }
    const advanced = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!

    it('sits under the work rows in Advanced, one control like the others, starting at None', () => {
      const onImage = renderImage({})
      expect(host.querySelector('[data-testid="bot-model-row-image"]')).toBeNull()
      act(() => advanced().click())
      expect(rows().map((row) => row.querySelector('.bot-model-row-label')!.textContent)).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work', 'Images'])
      const row = host.querySelector('[data-testid="bot-model-row-image"]')!
      expect(row.querySelectorAll('button')).toHaveLength(1)
      expect(row.querySelector('.settings-model-picker')).not.toBeNull()
      expect(pickerOf('Images').getAttribute('aria-label')).toBe('Pip\'s Images model: None')
      pick('Images', 'OpenRouter')
      expect(onImage).toHaveBeenLastCalledWith({ instanceId: 'pi:openrouter', model: 'google/gemini-3.1-flash-image' })
    })

    it('opens with a pick, names it with today\'s pictures, and None in the menu takes it away', () => {
      const onImage = renderImage({ pick: { instanceId: 'pi:openrouter', model: 'google/gemini-3.1-flash-image' } })
      expect(pickerOf('Images').getAttribute('aria-label')).toBe('Pip\'s Images model: Gemini 3.1 Flash Image')
      expect(pickerOf('Images').title).toBe('Gemini 3.1 Flash Image on OpenRouter · 3 of 20 today')
      act(() => pickerOf('Images').click())
      act(() => [...document.querySelectorAll<HTMLButtonElement>('.model-picker-clear')].find((button) => button.textContent === 'None')!.click())
      expect(onImage).toHaveBeenLastCalledWith(null)
    })

    it('says so in one line while no entry can make pictures, with what to add in its tooltip', () => {
      renderImage({ providers: [], missing: 'Add an OpenRouter entry with an API key in Settings → Providers to pick an image model.' })
      act(() => advanced().click())
      expect(pickerOf('Images').getAttribute('aria-label')).toBe('Pip\'s Images model: None available')
      expect(pickerOf('Images').title).toMatch(/^Add an OpenRouter entry/)
      expect(pickerOf('Images').disabled).toBe(true)
    })

    it('a pick no entry offers any more can still be set to None', () => {
      const onImage = renderImage({ providers: [], pick: { instanceId: 'pi:openrouter', model: 'google/gemini-3.1-flash-image' } })
      expect(pickerOf('Images').getAttribute('aria-label')).toBe("Pip's Images model: google/gemini-3.1-flash-image · not available")
      act(() => pickerOf('Images').click())
      act(() => [...document.querySelectorAll<HTMLButtonElement>('.model-picker-clear')].find((button) => button.textContent === 'None')!.click())
      expect(onImage).toHaveBeenLastCalledWith(null)
    })
  })

  it('Advanced can\'t close while the rows differ and Medium work has no pick', () => {
    render({ talk: null, light: { instanceId: 'claude', model: 'opus' }, medium: null, hard: null })
    const advanced = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(advanced.disabled).toBe(true)
    expect(host.querySelector('.bot-model-advanced span')!.getAttribute('title')).toBe('Pick a model for Medium work first')
  })
})
