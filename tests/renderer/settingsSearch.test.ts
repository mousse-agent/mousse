// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { revealSettingsAnchor, searchSettings, SETTINGS_SEARCH_INDEX, SETTINGS_SECTION_IDS, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { RunSettingsGroup } from '../../src/renderer/components/settings/RunSettingsGroup'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGES: SettingsSearchPage[] = [
  { id: 'general', label: 'General', keywords: ['appearance', 'notification'] },
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
    expect(searchSettings('Glass', PAGES)[0]).toMatchObject({ title: 'Glass intensity', section: 'general' })
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
    act(() => root.render(createElement(AgentsSettings, { settings: getDefaultSettings(), options: OPTIONS, projects: [], updateSettings: async () => {} })))
    // With no providers the model pickers are disabled.
    expect(revealSettingsAnchor(host, 'agents-default-model')).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('[data-settings-anchor="agents-default-model"]'))
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
