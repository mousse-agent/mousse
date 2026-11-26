// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LabsSettings } from '../../src/renderer/components/settings/LabsSettings'
import { readWindowCounters, registerWindowCache } from '../../src/renderer/lib/windowCounters'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { PROFILER_TOOL_LABELS, PROFILER_TOOL_NAMES } from '../../src/shared/diagnostics/profiler'
import { normalizeExperimentalSettings } from '../../src/shared/settings'
import { SETTINGS_SEARCH_INDEX } from '../../src/renderer/lib/settingsSearch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The rows Labs always shows, in order. */
const LABS_TOP = ['Mousse ID (legacy)', 'Performance', 'Sidebar animations', 'New chat animations', 'Shimmer animations', 'Hide permissions while running', 'Profiler']

describe('Settings → Labs', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore
  const memoryStatus = vi.fn(async () => ({ sample: null, detail: null, trend: [], growthMbPerHour: null, baselineMb: null, breaches: [], notice: null, logFile: 'diagnostics/memory.jsonl' }))

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-labs-settings-'))
    store = new SettingsStore(MousseConfigStore.load(home))
    memoryStatus.mockClear()
    ;(window as unknown as { mousse: unknown }).mousse = { diagnostics: { memoryStatus, heapSnapshot: vi.fn() } }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  const show = () => {
    const draw = () => act(() => root.render(createElement(LabsSettings, {
      settings: store.get(),
      onUpdate: async (partial) => {
        store.set(partial)
        draw()
      }
    })))
    draw()
  }
  const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)
  const titles = () => Array.from(host.querySelectorAll('.settings-item-title')).map((title) => title.textContent?.trim())

  it('shows Mousse ID (legacy) on and the Profiler switch off, and asks the service nothing', () => {
    show()
    expect(titles()).toEqual(LABS_TOP)
    expect(toggle('Mousse ID (legacy)')!.getAttribute('aria-checked')).toBe('true')
    expect(toggle('Profiler')!.getAttribute('aria-checked')).toBe('false')
    expect(memoryStatus).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('About')
  })

  it('keeps the memory table in view and folds notices, heap snapshot and agent access under Advanced; the tools only under agent access', () => {
    show()
    act(() => toggle('Profiler')!.click())
    expect(store.get().experimental.profiler.enabled).toBe(true)
    expect(titles()).toEqual([...LABS_TOP, 'Memory', 'Memory notices', 'Heap snapshot', 'Agents can read the profiler'])
    expect(memoryStatus).toHaveBeenCalled()
    // Memory sits under the switch; the rest is in a closed Advanced disclosure.
    expect(host.querySelector('[data-settings-anchor="labs-profiler-memory"]')!.closest('details')).toBeNull()
    const advanced = host.querySelector<HTMLDetailsElement>('details.settings-advanced')!
    expect(advanced.open).toBe(false)
    expect(advanced.querySelector('summary')!.textContent).toBe('Advanced')
    for (const anchor of ['labs-memory-notices', 'labs-heap-snapshot', 'labs-profiler-agents']) {
      expect(advanced.querySelector(`[data-settings-anchor="${anchor}"]`)).not.toBeNull()
    }
    expect(host.querySelector('[data-settings-anchor="labs-heap-snapshot"]')!.textContent).toMatch(/thread text, prompts, paths and tokens/)
    expect(toggle('Agents can read the profiler')!.getAttribute('aria-checked')).toBe('false')

    act(() => toggle('Agents can read the profiler')!.click())
    expect(store.get().experimental.profiler.agentAccess).toBe(true)
    const tools = PROFILER_TOOL_NAMES.map((name) => PROFILER_TOOL_LABELS[name].label)
    expect(titles()).toEqual([...LABS_TOP, 'Memory', 'Memory notices', 'Heap snapshot', 'Agents can read the profiler', ...tools])
    for (const name of PROFILER_TOOL_NAMES) {
      expect(toggle(PROFILER_TOOL_LABELS[name].label)!.getAttribute('aria-checked')).toBe(name === 'profiler_heap_summary' ? 'false' : 'true')
      // What a tool is for is in its tooltip.
      expect(host.querySelector(`[title="${PROFILER_TOOL_LABELS[name].detail}"]`)).not.toBeNull()
    }
    act(() => toggle(PROFILER_TOOL_LABELS.profiler_watch.label)!.click())
    expect(store.get().experimental.profiler.tools.profiler_watch).toBe(false)
    expect(store.get().experimental.profiler.tools.profiler_overview).toBe(true)

    // Notices keep their switch where earlier builds kept it.
    act(() => toggle('Memory notices')!.click())
    expect(store.get().notifications.memoryNotices).toBe(false)

    // Off hides everything again and keeps the choices below it.
    act(() => toggle('Profiler')!.click())
    expect(titles()).toEqual(LABS_TOP)
    expect(host.querySelector('details.settings-advanced')).toBeNull()
    expect(store.get().experimental.profiler).toMatchObject({ enabled: false, agentAccess: true, tools: { profiler_watch: false } })
  })

  it('Performance is off at first, says what it does, and stores the 2D hybrid bot faces choice', () => {
    show()
    expect(toggle('Performance')!.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('[data-settings-anchor="labs-hybrid-bot-faces"]')!.textContent).toContain('Bots use less GPU using 2D hybrid rendering')
    act(() => toggle('Performance')!.click())
    expect(store.get().experimental.hybridBotFaces).toBe(true)
    expect(toggle('Performance')!.getAttribute('aria-checked')).toBe('true')
    act(() => toggle('Performance')!.click())
    expect(store.get().experimental.hybridBotFaces).toBe(false)
  })

  it('saves the animation switches independently for the profile', () => {
    show()
    const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().experimental
    const sidebar = toggle('Sidebar animations')!
    const newChat = toggle('New chat animations')!
    const shimmer = toggle('Shimmer animations')!
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    expect(newChat.getAttribute('aria-checked')).toBe('true')
    expect(shimmer.getAttribute('aria-checked')).toBe('true')

    act(() => sidebar.click())
    expect(saved()).toMatchObject({ sidebarAnimations: false, newChatAnimations: true })
    act(() => newChat.click())
    expect(saved()).toMatchObject({ sidebarAnimations: false, newChatAnimations: false })
    act(() => sidebar.click())
    expect(saved()).toMatchObject({ sidebarAnimations: true, newChatAnimations: false, shimmerAnimations: true })
    act(() => shimmer.click())
    expect(saved()).toMatchObject({ sidebarAnimations: true, newChatAnimations: false, shimmerAnimations: false })
  })

  it('turns Mousse ID (legacy) off and on for the profile, leaving the profiler alone', () => {
    show()
    act(() => toggle('Mousse ID (legacy)')!.click())
    expect(store.get().experimental.plusLegacy).toBe(false)
    expect(toggle('Mousse ID (legacy)')!.getAttribute('aria-checked')).toBe('false')
    expect(store.get().experimental.profiler.enabled).toBe(false)
    // Saved with the profile: a store read again from disk keeps it off.
    expect(new SettingsStore(MousseConfigStore.load(home)).get().experimental.plusLegacy).toBe(false)
    act(() => toggle('Mousse ID (legacy)')!.click())
    expect(store.get().experimental.plusLegacy).toBe(true)
  })

  it('keeps Hide permissions while running on by default and persists turning it off and back on', () => {
    expect(normalizeExperimentalSettings({}).hidePermissionsWhileRunning).toBe(true)
    expect(normalizeExperimentalSettings({ hidePermissionsWhileRunning: false }).hidePermissionsWhileRunning).toBe(false)
    show()
    const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().experimental.hidePermissionsWhileRunning
    expect(toggle('Hide permissions while running')!.getAttribute('aria-checked')).toBe('true')
    expect(saved()).toBe(true)

    act(() => toggle('Hide permissions while running')!.click())
    expect(toggle('Hide permissions while running')!.getAttribute('aria-checked')).toBe('false')
    expect(saved()).toBe(false)

    act(() => toggle('Hide permissions while running')!.click())
    expect(toggle('Hide permissions while running')!.getAttribute('aria-checked')).toBe('true')
    expect(saved()).toBe(true)
  })

  it('asks before writing a heap snapshot', async () => {
    store.set({ experimental: { ...store.get().experimental, profiler: { ...store.get().experimental.profiler, enabled: true } } })
    show()
    const heapSnapshot = (window as unknown as { mousse: { diagnostics: { heapSnapshot: ReturnType<typeof vi.fn> } } }).mousse.diagnostics.heapSnapshot
    heapSnapshot.mockResolvedValue({ file: 'diagnostics/heap-snapshots/heap-1.heapsnapshot', mb: 70 })
    const row = () => host.querySelector('[data-settings-anchor="labs-heap-snapshot"]')!
    const button = (text: string) => Array.from(row().querySelectorAll('button')).find((b) => b.textContent === text)
    act(() => button('Write…')!.click())
    expect(heapSnapshot).not.toHaveBeenCalled()
    expect(button('Write anyway')).toBeDefined()
    await act(async () => { button('Write anyway')!.click() })
    expect(heapSnapshot).toHaveBeenCalledTimes(1)
  })

  it('the settings search finds Mousse ID (legacy) and the profiler on Labs, and the rows under the profiler once it is on', () => {
    const labs = SETTINGS_SEARCH_INDEX.filter((entry) => entry.section === 'labs')
    expect(labs.map((entry) => entry.anchor)).toEqual(['labs-plus-legacy', 'labs-hybrid-bot-faces', 'labs-sidebar-animations', 'labs-new-chat-animations', 'labs-shimmer-animations', 'labs-hide-permissions-while-running', 'labs-profiler', 'labs-profiler-memory', 'labs-memory-notices', 'labs-heap-snapshot', 'labs-profiler-agents'])
    for (const entry of labs.slice(0, 7)) expect(entry.needs).toBeUndefined()
    for (const entry of labs.slice(7)) expect(entry.needs?.anchor).toBe('labs-profiler')
    expect(SETTINGS_SEARCH_INDEX.some((entry) => entry.anchor.startsWith('general-memory'))).toBe(false)
  })
})

describe('window counters', () => {
  it('counts mounted turns and rows, and reads each registered cache only when asked', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="group/assistant-turn"><p data-message-id="a"></p></div><div class="group/assistant-turn"><p data-message-id="b"></p><p data-message-id="c"></p></div>'
    const read = vi.fn(() => ({ entries: 7, limit: 100 }))
    registerWindowCache('codeHighlight', read)
    registerWindowCache('broken', () => { throw new Error('x') })
    expect(read).not.toHaveBeenCalled()
    expect(readWindowCounters(root)).toEqual({ mountedTurns: 2, mountedRows: 3, caches: { codeHighlight: { entries: 7, limit: 100 } } })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
