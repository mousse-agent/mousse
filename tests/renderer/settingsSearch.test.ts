// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentSettingsAnchor, landOnSettingsAnchor, revealSettingsAnchor, searchIndex, searchSettings, settingsSearchEntry, SETTINGS_ANCHOR_ALIASES, SETTINGS_SEARCH_INDEX, SETTINGS_SECTION_IDS, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { SettingsRow } from '../../src/renderer/components/settings/SettingsRow'
import { RunSettingsGroup } from '../../src/renderer/components/settings/RunSettingsGroup'
import { NotificationSettingsGroup } from '../../src/renderer/components/settings/NotificationSettingsGroup'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGES: SettingsSearchPage[] = [
  { id: 'general', label: 'General', keywords: ['notification'] },
  { id: 'appearance', label: 'Appearance', keywords: ['theme'] },
  { id: 'chat', label: 'Chat', keywords: ['conversation', 'composer', 'width'] },
  { id: 'activity', label: 'Activity', keywords: ['heatmap'] },
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

  it('finds the Agents groups, the automation limits and the read-only rows', () => {
    for (const title of ['Models', 'Context', 'Access', 'Subagents', 'Automations']) {
      expect(searchSettings(title, PAGES).find((result) => result.section === 'agents')?.title, title).toBe(title)
    }
    expect(searchSettings('at most', PAGES)[0]).toEqual({ title: 'At most', section: 'agents', anchor: 'agents-automations-active' })
    expect(searchSettings('minutes apart', PAGES)[0]).toMatchObject({ title: 'At least', anchor: 'agents-automations-interval' })
    expect(searchSettings('end after', PAGES)[0]).toMatchObject({ title: 'End after', anchor: 'agents-automations-lifetime' })
    expect(searchSettings('cache time', PAGES)[0]).toMatchObject({ title: 'Cache time', anchor: 'agents-cache-time' })
    expect(searchSettings('capped', PAGES)[0]).toMatchObject({ title: 'Capped threads', anchor: 'agents-capped-threads' })
    // Old titles still find the renamed rows.
    expect(searchSettings('agent access', PAGES)[0]).toMatchObject({ anchor: 'agents-access' })
    expect(searchSettings('own worktree', PAGES)[0]).toMatchObject({ title: 'Worktree per subagent' })
  })

  it('finds a provider’s update, models, Claude settings and sign-in', () => {
    // Mousse's own update stays first; the provider's is offered too.
    expect(searchSettings('upgrade', PAGES)).toContainEqual({ title: 'Update', section: 'providers', anchor: 'providers-update' })
    expect(searchSettings('cli update', PAGES)[0]).toMatchObject({ anchor: 'providers-update' })
    expect(searchSettings('favorites', PAGES)[0]).toEqual({ title: 'Models', section: 'providers', anchor: 'providers-models' })
    expect(searchSettings('custom model', PAGES)[0]).toMatchObject({ anchor: 'providers-models' })
    expect(searchSettings('settings.json', PAGES)[0]).toEqual({ title: 'Claude settings', section: 'providers', anchor: 'providers-claude-settings' })
    expect(searchSettings('sign in', PAGES)[0]).toMatchObject({ title: 'Sign in', section: 'providers', anchor: 'providers-status' })
    expect(searchSettings('prompt cache', PAGES).map((result) => result.title)).toContain('Keep prompt cache 1 hour')
  })

  it('lands on each automation limit', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    document.body.append(host)
    act(() => root.render(createElement(AgentsSettings, { settings: getDefaultSettings(), options: { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }, projects: [], updateSettings: async () => {} })))
    for (const anchor of ['agents-automations-active', 'agents-automations-interval', 'agents-automations-lifetime', 'agents-automations', 'agents-subagents', 'agents-capped-threads']) {
      expect(revealSettingsAnchor(host, anchor), anchor).toBe(true)
    }
    act(() => root.unmount())
    host.remove()
  })

  it('has one anchor per setting, on a page that exists, and each anchor is on a row or group in the app', () => {
    const anchors = SETTINGS_SEARCH_INDEX.map((entry) => entry.anchor)
    expect(new Set(anchors).size).toBe(anchors.length)
    const sources = rendererSources().join('\n')
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(SETTINGS_SECTION_IDS).toContain(entry.section)
      expect(entry.anchor).toMatch(/^[a-z][a-z-]*$/)
      // On a row (`anchor="…"`), or in a list of rows that passes it on (`anchor: '…'`).
      expect(sources.includes(`anchor="${entry.anchor}"`) || sources.includes(`anchor: '${entry.anchor}'`), entry.anchor).toBe(true)
      if (entry.needs) expect(sources, entry.needs.anchor).toContain(`anchor="${entry.needs.anchor}"`)
    }
  })

  it('has an entry for every anchor a row or group in the app sets', () => {
    const indexed = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.anchor))
    const sources = rendererSources().join('\n')
    const anchors = new Set([...sources.matchAll(/\banchor(?:="|: ')([a-z][a-z-]*)['"]/g)].map((match) => match[1]))
    expect(anchors.size).toBeGreaterThan(40)
    expect([...anchors].filter((anchor) => !indexed.has(anchor))).toEqual([])
  })

  it('matches the start of a word only', () => {
    const titles = (query: string) => searchSettings(query, PAGES).map((result) => result.title)
    expect(titles('back')).not.toContain('Reduce background noise')
    expect(titles('ring')[0]).toBe('Context ring')
    expect(titles('ring')).not.toContain('Let my other devices work here')
    expect(titles('ground')).toEqual([])
    expect(titles('backg')).toEqual(['Reduce background noise'])
    expect(titles('noise')).toEqual(['Reduce background noise'])
    // A whole word with a plural ending still counts as whole.
    expect(titles('notification')).toEqual(expect.arrayContaining(['Finished', 'Needs you', 'Stopped', 'General']))
  })

  it('titles a result as its page does', () => {
    expect(searchSettings('finished', PAGES)[0]).toMatchObject({ title: 'Finished', anchor: 'general-notify-finished' })
    expect(searchSettings('needs you', PAGES)[0]).toMatchObject({ title: 'Needs you' })
    expect(searchSettings('stopped', PAGES)[0]).toMatchObject({ title: 'Stopped' })
    expect(searchSettings('updates', PAGES)[0]).toMatchObject({ title: 'Updates', anchor: 'general-updates' })
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

  it('lands on each notification event\'s row, and on the remote threads row', () => {
    act(() => root.render(createElement(NotificationSettingsGroup, { notifications: getDefaultSettings().notifications, onUpdate: async () => {} })))
    for (const anchor of ['general-notify-finished', 'general-notify-needs-you', 'general-notify-stopped', 'general-remote-notifications']) {
      expect(revealSettingsAnchor(host, anchor), anchor).toBe(true)
      expect(host.querySelector(`[data-settings-anchor="${anchor}"]`)?.contains(document.activeElement), anchor).toBe(true)
      // The result's title is the row's title, so the result and the row read the same.
      const title = host.querySelector(`[data-settings-anchor="${anchor}"] .settings-item-title`)?.textContent
      expect(SETTINGS_SEARCH_INDEX.find((entry) => entry.anchor === anchor)?.title, anchor).toBe(title)
    }
  })

  it('lands on a setting by an old anchor it moved from', () => {
    expect(currentSettingsAnchor('appearance-old-ring', { 'appearance-old-ring': 'chat-context-ring' })).toBe('chat-context-ring')
    expect(currentSettingsAnchor('appearance-theme', { 'appearance-old-ring': 'chat-context-ring' })).toBe('appearance-theme')
    expect(currentSettingsAnchor('toString')).toBe('toString')
    const anchors = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.anchor))
    for (const [from, to] of Object.entries(SETTINGS_ANCHOR_ALIASES)) {
      expect(anchors.has(from), from).toBe(false)
      expect(anchors.has(to), to).toBe(true)
      expect(settingsSearchEntry(from)?.anchor).toBe(to)
    }
  })

  it('lands on a Chat setting by its old Appearance anchor', () => {
    for (const [from, to] of [
      ['appearance-chat-width', 'chat-width'],
      ['appearance-render-math', 'chat-render-math'],
      ['appearance-reply-pacing', 'chat-reply-pacing'],
      ['appearance-turn-changed-files', 'chat-turn-changed-files'],
      ['appearance-context-ring', 'chat-context-ring'],
      ['appearance-frosted-composer', 'chat-frosted-composer']
    ]) expect(settingsSearchEntry(from), from).toMatchObject({ anchor: to, section: 'chat' })
    act(() => root.render(createElement(SettingsRow, {
      title: 'Context ring',
      anchor: 'chat-context-ring',
      control: createElement('button', { type: 'button' }, 'On')
    })))
    const done = vi.fn()
    landOnSettingsAnchor(host, 'appearance-context-ring', { onMissing: vi.fn(), onFound: vi.fn(), onDone: done })
    expect(done).toHaveBeenCalledOnce()
    expect(document.activeElement?.textContent).toBe('On')
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

describe('the settings sidebar', () => {
  it('finds Providers by sign in, account, cache, update and telemetry', () => {
    const source = readFileSync(join(__dirname, '../../src/renderer/components/SettingsPage.tsx'), 'utf8')
    const line = source.split('\n').find((text) => text.includes("id: 'providers'"))!
    const keywords = [...line.slice(line.indexOf('keywords:')).matchAll(/'([^']+)'/g)].map((match) => match[1])
    const pages: SettingsSearchPage[] = [{ id: 'providers', label: 'Providers', keywords }]
    for (const query of ['sign in', 'account', 'cache', 'update', 'telemetry']) {
      expect(searchSettings(query, pages, []), query).toEqual([{ title: 'Providers', section: 'providers' }])
    }
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
      'Remove merged worktrees'
    ])
  })
})
