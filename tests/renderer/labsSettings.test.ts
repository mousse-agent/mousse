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
import { SETTINGS_SEARCH_INDEX } from '../../src/renderer/lib/settingsSearch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('shows only the Profiler switch, off, until it is turned on, and asks the service nothing', () => {
    show()
    expect(titles()).toEqual(['Profiler'])
    expect(toggle('Profiler')!.getAttribute('aria-checked')).toBe('false')
    expect(memoryStatus).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('About')
  })

  it('nests the memory table, notices, heap snapshot and agent access under it; the tools only under agent access', () => {
    show()
    act(() => toggle('Profiler')!.click())
    expect(store.get().experimental.profiler.enabled).toBe(true)
    expect(titles()).toEqual(['Profiler', 'Memory', 'Memory notices', 'Heap snapshot', 'Agent access'])
    expect(memoryStatus).toHaveBeenCalled()
    // Nested rows are indented, with no side bars.
    for (const anchor of ['labs-profiler-memory', 'labs-memory-notices', 'labs-heap-snapshot', 'labs-profiler-agents']) {
      expect(host.querySelector(`[data-settings-anchor="${anchor}"]`)!.classList.contains('indent')).toBe(true)
    }
    expect(host.querySelector('[data-settings-anchor="labs-heap-snapshot"]')!.textContent).toMatch(/thread text, prompts, paths and tokens/)
    expect(toggle('Agent access')!.getAttribute('aria-checked')).toBe('false')

    act(() => toggle('Agent access')!.click())
    expect(store.get().experimental.profiler.agentAccess).toBe(true)
    const tools = PROFILER_TOOL_NAMES.map((name) => PROFILER_TOOL_LABELS[name].label)
    expect(titles()).toEqual(['Profiler', 'Memory', 'Memory notices', 'Heap snapshot', 'Agent access', ...tools])
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
    expect(titles()).toEqual(['Profiler'])
    expect(store.get().experimental.profiler).toMatchObject({ enabled: false, agentAccess: true, tools: { profiler_watch: false } })
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

  it('the settings search finds the profiler on Labs, and the rows under it once it is on', () => {
    const labs = SETTINGS_SEARCH_INDEX.filter((entry) => entry.section === 'labs')
    expect(labs.map((entry) => entry.anchor)).toEqual(['labs-profiler', 'labs-profiler-memory', 'labs-memory-notices', 'labs-heap-snapshot', 'labs-profiler-agents'])
    for (const entry of labs.slice(1)) expect(entry.needs?.anchor).toBe('labs-profiler')
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
