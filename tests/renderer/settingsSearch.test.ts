// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { landOnSettingsAnchor, revealSettingsAnchor, searchIndex, searchSettings, SETTINGS_SEARCH_INDEX, SETTINGS_SECTION_IDS, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { SettingsRow } from '../../src/renderer/components/settings/SettingsRow'
import { RunSettingsGroup } from '../../src/renderer/components/settings/RunSettingsGroup'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGES: SettingsSearchPage[] = [
  { id: 'general', label: 'General', keywords: ['notification'] },
  { id: 'appearance', label: 'Appearance', keywords: ['theme'] },
  { id: 'account', label: 'Account', keywords: ['mousse id'] },
  { id: 'providers', label: 'Providers', keywords: ['api key', 'subscription'] },
  { id: 'agents', label: 'Agents', keywords: ['context'] },
  { id: 'integrations', label: 'Skills & MCP', keywords: ['skills', 'mcp'] },
  { id: 'speech', label: 'Speech', keywords: ['voice'] },
  { id: 'shortcuts', label: 'Shortcuts', keywords: ['keyboard', 'hotkeys'] },
  { id: 'connections', label: 'Devices', keywords: ['network', 'pair'] },
  { id: 'storage', label: 'Storage', keywords: ['trash', 'disk'] }
]

/** Every renderer source file, to check that each search anchor is on a real row. */
function rendererSources(dir = join(__dirname, '../../src/renderer')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rendererSources(path)
    return /\.tsx$/.test(name) ? [readFileSync(path, 'utf8')] : []
  })
}

describe('the settings search', () => {
  it('finds a setting by its title, naming its page and where it lands', () => {
    expect(searchSettings('telemetry', PAGES)[0]).toEqual({ title: 'Telemetry', section: 'providers', anchor: 'providers-telemetry' })
    expect(searchSettings('compact context', PAGES)[0]).toEqual({ title: 'Compact context', section: 'agents', anchor: 'agents-context-compaction' })
    expect(searchSettings('worktree folder', PAGES)[0]).toEqual({ title: 'Worktree folder', section: 'storage', anchor: 'storage-worktree-folder' })
    expect(searchSettings('Glass', PAGES)[0]).toMatchObject({ title: 'Glass intensity', section: 'appearance' })
  })

  it('finds a setting by another word for it, and every word must match', () => {
    expect(searchSettings('latex', PAGES).map((result) => result.title)).toEqual(['Render math'])
    expect(searchSettings('noise dictation', PAGES)[0]).toMatchObject({ title: 'Reduce background noise' })
    expect(searchSettings('telemetry nonsense', PAGES)).toEqual([])
  })

  it('still finds whole pages by their name and words, after the settings that match better', () => {
    expect(searchSettings('hotkeys', PAGES)).toEqual([{ title: 'Shortcuts', section: 'shortcuts' }])
    const devices = searchSettings('devices', PAGES)
    expect(devices).toContainEqual({ title: 'Devices', section: 'connections' })
    expect(searchSettings('', PAGES)).toEqual([])
  })

  it('has one anchor per setting, on a page that exists, and each anchor is on a row or group in the app', () => {
    const anchors = SETTINGS_SEARCH_INDEX.map((entry) => entry.anchor)
    expect(new Set(anchors).size).toBe(anchors.length)
    const sources = rendererSources().join('\n')
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(SETTINGS_SECTION_IDS).toContain(entry.section)
      expect(entry.anchor).toMatch(/^[a-z][a-z-]*$/)
      expect(sources, entry.anchor).toContain(`anchor="${entry.anchor}"`)
      if (entry.needs) expect(sources, entry.needs.anchor).toContain(`anchor="${entry.needs.anchor}"`)
    }
  })
})

describe('landing on a search result', () => {
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

  const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

  it('focuses the setting’s control', () => {
    act(() => root.render(createElement(AgentsSettings, { settings: getDefaultSettings(), options: OPTIONS, projects: [], updateSettings: async () => {} })))
    expect(revealSettingsAnchor(host, 'agents-context-compaction')).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Compact context"]'))
  })

  it('focuses the row when its control is disabled, and says so when the setting is not on the page', () => {
    act(() => root.render(createElement(SettingsRow, {
      title: 'Voice',
      anchor: 'speech-voice',
      control: createElement('button', { type: 'button', disabled: true }, 'Play sample')
    })))
    expect(revealSettingsAnchor(host, 'speech-voice')).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('[data-settings-anchor="speech-voice"]'))
    expect(revealSettingsAnchor(host, 'providers-telemetry')).toBe(false)
  })

  it('opens the disclosure a setting sits in', () => {
    act(() => root.render(createElement('details', null,
      createElement('summary', null, 'Advanced'),
      createElement(RunSettingsGroup, { runs: getDefaultSettings().runs, onUpdate: async () => {} }))))
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(revealSettingsAnchor(host, 'general-resume')).toBe(true)
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Resume after usage limits reset"]'))
  })
})

describe('a search result whose setting is not on its page', () => {
  let host: HTMLElement

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
  })

  const landing = () => ({ onMissing: vi.fn(), onFound: vi.fn(), onDone: vi.fn() })
  /** The Dictation group with no model chosen: its only control adds a model, and Vocabulary is not shown. */
  const dictationWithoutModel = () => {
    host.innerHTML = '<section data-settings-anchor="speech-dictation"><h3>Dictation</h3><button type="button">Add a dictation model</button></section>'
    return host.querySelector('button')!
  }

  it('lands on what the setting needs and says why, once the page has settled', () => {
    const add = dictationWithoutModel()
    const events = landing()
    landOnSettingsAnchor(host, 'speech-vocabulary', events, { quietMs: 50, waitMs: 200 })
    expect(events.onMissing).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(events.onMissing).toHaveBeenCalledExactlyOnceWith('Vocabulary appears once you choose a dictation model that uses it, such as Parakeet.', true)
    expect(document.activeElement).toBe(add)
    vi.advanceTimersByTime(150)
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(events.onFound).not.toHaveBeenCalled()
  })

  it('moves to the setting when the page shows it after all', async () => {
    dictationWithoutModel()
    const events = landing()
    landOnSettingsAnchor(host, 'speech-vocabulary', events, { quietMs: 50, waitMs: 200 })
    vi.advanceTimersByTime(50)
    host.insertAdjacentHTML('beforeend', '<div data-settings-anchor="speech-vocabulary"><div class="settings-item-control"><button type="button">No terms</button></div></div>')
    await Promise.resolve()
    expect(events.onFound).toHaveBeenCalledOnce()
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(document.activeElement?.textContent).toBe('No terms')
    vi.advanceTimersByTime(500)
    expect(events.onMissing).toHaveBeenCalledOnce()
    expect(events.onDone).toHaveBeenCalledOnce()
  })

  it('keeps waiting while the page is still changing', async () => {
    dictationWithoutModel()
    const events = landing()
    landOnSettingsAnchor(host, 'speech-noise', events, { quietMs: 50, waitMs: 200 })
    vi.advanceTimersByTime(40)
    host.append(document.createElement('p'))
    await Promise.resolve()
    vi.advanceTimersByTime(40)
    expect(events.onMissing).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    expect(events.onMissing).toHaveBeenCalledWith('Reduce background noise appears once you choose a dictation model.', true)
  })

  it('names the setting and leaves focus to the page when nothing it needs is known', () => {
    const events = landing()
    landOnSettingsAnchor(host, 'agents-context-compaction', events, { quietMs: 50, waitMs: 200 })
    vi.advanceTimersByTime(200)
    expect(events.onMissing).toHaveBeenCalledExactlyOnceWith('Compact context isn’t on this page right now.', false)
    expect(events.onDone).toHaveBeenCalledOnce()
  })

  it('lands at once, with no note, when the setting is there', () => {
    host.innerHTML = '<div data-settings-anchor="speech-noise"><div class="settings-item-control"><button type="button">On</button></div></div>'
    const events = landing()
    landOnSettingsAnchor(host, 'speech-noise', events)
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(events.onMissing).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('On')
  })
})

describe('the search results list', () => {
  it('leaves Mousse ID out when this build has no Mousse ID service', () => {
    const titles = (available: boolean) => searchSettings('mousse id', PAGES, searchIndex(available)).map((result) => result.title)
    expect(titles(true)).toContain('Mousse ID')
    expect(titles(false)).not.toContain('Mousse ID')
    expect(searchSettings('phones', PAGES, searchIndex(false))).toEqual([])
  })

  it('shows each result’s whole title, so results that differ only at the end stay apart', () => {
    const css = readFileSync(join(__dirname, '../../src/renderer/styles/settings.css'), 'utf8')
    const rule = css.match(/\.settings-nav-result-title\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toBe('')
    expect(rule).not.toMatch(/nowrap|ellipsis/)
    const removal = searchSettings('remove worktrees', PAGES).map((result) => result.title)
    expect(removal).toEqual([
      'Remove worktrees inactive for',
      'Remove worktrees whose work is merged into the default branch'
    ])
  })
})
