import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDialog } from '../src/renderer/components/ui/Modal'
import { PaletteList, type PaletteListGroup } from '../src/renderer/components/CommandPalette'
import {
  currentContext,
  isCommandRegistered,
  pushOverlay,
  registerCommand,
  runCommand,
  setRecording,
  useCommandRegistry
} from '../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../src/renderer/commands/useCommandShortcuts'
import { chooseCommandPaletteItem, closePalette, dismissPalette, openPalette, togglePalette } from '../src/renderer/commands/paletteActions'
import { buildPaletteGroups, eligibleCommands, flattenGroups, type PaletteItem } from '../src/renderer/commands/paletteItems'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { KeyInput } from '../src/shared/commands'
import type { Project, Thread } from '../src/shared/types'

const globals = globalThis as { window?: unknown; document?: unknown }
const original = { window: globals.window, document: globals.document }

type FakeElement = { closest(selector: string): unknown; focus: () => void }
type FakeWindow = EventTarget & { mousse: { platform: string; threads: { select: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } } }

/** Records every focus call, in order, across all fake elements. */
let focusLog: string[] = []
const element = (name: string, closest: (selector: string) => unknown = () => null): FakeElement => ({
  closest,
  focus: () => void focusLog.push(name)
})
const composer = () => element('composer', (selector) => (selector.includes('textarea') ? {} : null))
const terminal = () => element('terminal', (selector) => (selector.includes('textarea') || selector === '.xterm' ? {} : null))

function stubWindow(activeElement: FakeElement | null) {
  const win = new EventTarget() as FakeWindow
  win.mousse = { platform: 'win32', threads: { select: vi.fn(async () => undefined), create: vi.fn() } }
  const doc = new EventTarget() as EventTarget & { activeElement: FakeElement | null }
  doc.activeElement = activeElement
  globals.window = win
  globals.document = doc
  return { win, doc }
}

function keydown(win: EventTarget, init: Partial<KeyInput> & { key: string }) {
  const event = Object.assign(
    new Event('keydown', { cancelable: true }),
    { code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, keyCode: 0 },
    init
  )
  win.dispatchEvent(event)
  return event
}

const ctrlK = { key: 'k', code: 'KeyK', ctrlKey: true }

function thread(id: string, name: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    order: 0,
    ...over
  }
}

let stopOverlaySync: (() => void) | null = null

/**
 * The palette component pushes its overlay while open (`useCommandOverlay`). Components do not render
 * in these tests, so the same push and pop follow the store.
 */
function syncPaletteOverlay() {
  let pop: (() => void) | null = null
  const apply = (open: boolean) => {
    if (open && !pop) pop = pushOverlay('palette')
    if (!open && pop) {
      pop()
      pop = null
    }
  }
  const unsubscribe = useAppStore.subscribe((state) => apply(state.paletteOpen))
  stopOverlaySync = () => {
    unsubscribe()
    pop?.()
  }
}

beforeEach(() => {
  focusLog = []
  useCommandRegistry.setState({ handlers: new Map(), recording: false, overlays: [] })
  useAppStore.setState({
    shortcuts: {},
    paletteOpen: false,
    settingsOpen: false,
    threadSearchOpen: false,
    activeThreadId: 'thread-1',
    threads: [],
    projects: [],
    turnStates: { 'thread-1': { threadId: 'thread-1', phase: 'streaming' } as never },
    mainAreaOpen: true,
    sidebarMode: 'projects',
    appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' }
  })
  syncPaletteOverlay()
})

afterEach(() => {
  stopOverlaySync?.()
  stopOverlaySync = null
  useAppStore.setState({ paletteOpen: false })
  globals.window = original.window
  globals.document = original.document
})

/** The shell's own registration of Ctrl/Cmd+K, as `useAppCommands` makes it. */
function registerPaletteToggle() {
  registerCommand('palette.open', { run: togglePalette, enabled: () => !useAppStore.getState().settingsOpen })
}

describe('opening and closing with Ctrl+K', () => {
  it('opens from the keyboard, also while typing in the composer, and consumes the key', () => {
    const { win } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    const event = keydown(win, ctrlK)
    expect(useAppStore.getState().paletteOpen).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  it('closes with the same chord and gives focus back to where it was', () => {
    const { win, doc } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    keydown(win, ctrlK)
    // The palette's own input takes focus while it is open.
    doc.activeElement = element('palette-input', (selector) => (selector.includes('input') ? {} : null))
    focusLog = []
    const event = keydown(win, ctrlK)

    expect(event.defaultPrevented).toBe(true)
    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(focusLog).toEqual(['composer'])
    expect(useCommandRegistry.getState().overlays).toEqual([])
  })

  it('closes on Escape without running anything, and focus returns to the opener', () => {
    stubWindow(composer())
    const run = vi.fn()
    registerCommand('thread.new', { run })
    openPalette()
    expect(useAppStore.getState().paletteOpen).toBe(true)

    dismissPalette()
    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(focusLog).toEqual(['composer'])
    expect(run).not.toHaveBeenCalled()
  })

  it('toggles', () => {
    stubWindow(composer())
    togglePalette()
    expect(useAppStore.getState().paletteOpen).toBe(true)
    togglePalette()
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })
})

describe('where Ctrl+K stands down', () => {
  it('does not fire in a terminal, and leaves the key to the shell', () => {
    const { win } = stubWindow(terminal())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    const event = keydown(win, ctrlK)
    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not fire under a dialog or the thread search dialog, and works again once they close', () => {
    const { win } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    const release = registerDialog({} as HTMLElement)
    expect(keydown(win, ctrlK).defaultPrevented).toBe(false)
    release()

    const pop = pushOverlay('thread-search')
    expect(keydown(win, ctrlK).defaultPrevented).toBe(false)
    pop()
    expect(useAppStore.getState().paletteOpen).toBe(false)

    expect(keydown(win, ctrlK).defaultPrevented).toBe(true)
    expect(useAppStore.getState().paletteOpen).toBe(true)
  })

  it('does not fire while the settings page makes the app inert, or while the Shortcuts recorder listens', () => {
    const { win } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    useAppStore.setState({ settingsOpen: true })
    expect(keydown(win, ctrlK).defaultPrevented).toBe(false)
    useAppStore.setState({ settingsOpen: false })

    setRecording(true)
    expect(keydown(win, ctrlK).defaultPrevented).toBe(false)
    setRecording(false)
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })

  it('does not fire for another chord, a composing key or a different modifier', () => {
    const { win } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()

    for (const init of [
      { key: 'k', code: 'KeyK' },
      { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true },
      { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true },
      { key: 'k', code: 'KeyK', ctrlKey: true, keyCode: 229 }
    ]) {
      expect(keydown(win, init).defaultPrevented).toBe(false)
    }
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })

  it('stays out of the palette itself: other global chords do nothing while it is open, Stop run still works', () => {
    const { win } = stubWindow(composer())
    attachCommandShortcuts(win as never)
    registerPaletteToggle()
    const created = vi.fn()
    const stop = vi.fn()
    registerCommand('thread.new', { run: created })
    registerCommand('run.stop', { run: stop })

    keydown(win, ctrlK)
    keydown(win, { key: 'n', code: 'KeyN', ctrlKey: true })
    expect(created).not.toHaveBeenCalled()
    keydown(win, { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true })
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('closePalette', () => {
  it('restores focus to the opener before it runs what was chosen', () => {
    const order: string[] = []
    closePalette({
      opener: { focus: () => void order.push('opener') },
      then: () => void order.push('then'),
      setOpen: (open) => void order.push(`open:${open}`)
    })
    expect(order).toEqual(['open:false', 'opener', 'then'])
  })

  it('leaves focus where a focus-changing command put it', () => {
    let focused = ''
    closePalette({
      opener: { focus: () => void (focused = 'opener') },
      then: () => void (focused = 'composer'),
      setOpen: () => undefined
    })
    expect(focused).toBe('composer')
  })

  it('leaves focus on the opener when nothing was chosen, and copes with no opener', () => {
    let focused = ''
    closePalette({ opener: { focus: () => void (focused = 'opener') }, setOpen: () => undefined })
    expect(focused).toBe('opener')
    expect(() => closePalette({ opener: null, setOpen: () => undefined })).not.toThrow()
  })
})

const commandRow = (id: string): PaletteItem => {
  const row = eligibleCommands(currentContext('palette'), isCommandRegistered).find((item) => item.kind === 'command' && item.id === id)
  if (!row) throw new Error(`${id} is not offered`)
  return row
}

describe('running a command from the palette', () => {
  it('closes the palette, restores focus, then runs the command', () => {
    stubWindow(composer())
    const order: string[] = []
    registerCommand('thread.new', { run: () => void order.push('run') })
    openPalette()
    const row = commandRow('thread.new')

    chooseCommandPaletteItem(row)
    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(focusLog).toEqual(['composer'])
    expect(order).toEqual(['run'])
  })

  it('lets Focus composer keep the focus it takes', () => {
    stubWindow(element('sidebar-button'))
    registerCommand('composer.focus', { run: () => void focusLog.push('composer') })
    openPalette()

    chooseCommandPaletteItem(commandRow('composer.focus'))
    // The opener is restored first; the command then focuses the composer, and nothing moves focus later.
    expect(focusLog).toEqual(['sidebar-button', 'composer'])
  })

  it('offers and runs a text-denied command even though the opener was a text field', () => {
    stubWindow(composer())
    const open = vi.fn()
    registerCommand('surface.browser', { run: open })
    openPalette()

    // Typing `b` in the composer would not run it; the palette row does.
    chooseCommandPaletteItem(commandRow('surface.browser'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not list a command whose rule has turned false, and refuses it if chosen late', () => {
    stubWindow(composer())
    const stop = vi.fn()
    registerCommand('run.stop', { run: stop })
    const row = commandRow('run.stop')

    useAppStore.setState({ turnStates: { 'thread-1': { threadId: 'thread-1', phase: 'completed' } as never } })
    expect(eligibleCommands(currentContext('palette'), isCommandRegistered)).toEqual([])
    chooseCommandPaletteItem(row)
    expect(stop).not.toHaveBeenCalled()
  })

  it('does not list a command that is registered but disabled', () => {
    stubWindow(composer())
    registerCommand('thread.new', { run: vi.fn(), enabled: () => false })
    expect(eligibleCommands(currentContext('palette'), isCommandRegistered)).toEqual([])
  })
})

describe('opening a thread from the palette', () => {
  it('closes the palette and selects the thread', async () => {
    const { win } = stubWindow(composer())
    useAppStore.setState({ threads: [thread('t1', 'Fix login'), thread('t2', 'Release notes')] })
    openPalette()

    const groups = buildPaletteGroups({ query: 'release', commands: [], threads: useAppStore.getState().threads, projects: [] })
    const [row] = flattenGroups(groups)
    expect(row).toMatchObject({ kind: 'thread', id: 't2' })
    chooseCommandPaletteItem(row!)

    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(focusLog).toEqual(['composer'])
    await vi.waitFor(() => expect(win.mousse.threads.select).toHaveBeenCalledWith('t2'))
    expect(useAppStore.getState().activeThreadId).toBe('t2')
  })

  it('opens the newest thread of a chosen project', async () => {
    const { win } = stubWindow(composer())
    chooseCommandPaletteItem({ kind: 'project', key: 'project:p1', id: 'p1', title: 'Mousse', detail: 'Project', threadId: 't9' })
    await vi.waitFor(() => expect(win.mousse.threads.select).toHaveBeenCalledWith('t9'))
  })

  it('starts a thread in a chosen project that has none', async () => {
    const { win } = stubWindow(composer())
    const draft = thread('draft-1', 'New Thread', { projectId: 'p1', startedAt: undefined })
    win.mousse.threads.create.mockResolvedValue(draft)

    chooseCommandPaletteItem({ kind: 'project', key: 'project:p1', id: 'p1', title: 'Mousse', detail: 'Project' })
    await vi.waitFor(() => expect(win.mousse.threads.select).toHaveBeenCalledWith('draft-1'))
    expect(win.mousse.threads.create).toHaveBeenCalledWith(undefined, 'p1')
  })
})

describe('the palette list', () => {
  const groups: PaletteListGroup[] = [
    {
      label: 'Commands',
      items: [
        { key: 'command:thread.new', title: 'New thread', detail: 'Thread', shortcut: 'Ctrl+N' },
        { key: 'command:run.stop', title: 'Stop run', detail: 'Thread' }
      ]
    },
    { label: 'Threads', items: [{ key: 'thread:t1', title: 'Fix login', detail: 'Mousse' }] }
  ]
  const render = (activeIndex: number, list = groups) =>
    renderToStaticMarkup(
      createElement(PaletteList, { groups: list, activeIndex, listId: 'list', emptyLabel: 'No results', onActivate: () => undefined, onChoose: () => undefined })
    )

  it('marks exactly one row as selected, counting across groups', () => {
    const html = render(2)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toMatch(/id="list-option-2"[^>]*aria-selected="true"/)
    expect(html.match(/palette-result active/g)).toHaveLength(1)
    expect(render(0)).toMatch(/id="list-option-0"[^>]*aria-selected="true"/)
  })

  it('shows group labels, details and the shortcut of a command', () => {
    const html = render(0)
    expect(html).toContain('Commands')
    expect(html).toContain('Threads')
    expect(html).toContain('Fix login')
    expect(html).toContain('<kbd class="palette-result-shortcut">Ctrl+N</kbd>')
    expect(html.match(/palette-result-shortcut/g)).toHaveLength(1)
  })

  it('says so when nothing matches', () => {
    expect(render(0, [])).toContain('No results')
  })

  it('highlights the selected row with a background only, never an edge bar', () => {
    const css = readFileSync(new URL('../src/renderer/styles/thread-search.css', import.meta.url), 'utf8')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /\.active|\.palette-result/.test(selector!))
    expect(rules.length).toBeGreaterThan(0)
    for (const [, , body] of rules) expect(body).not.toMatch(/border-(left|right|inline)|box-shadow\s*:\s*inset|outline/)
  })
})

describe('the palette and the threads of other computers', () => {
  const row = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
    ({ id, name, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', order: 0, startedAt: '2026-01-01T00:00:01.000Z', ...over }) as Thread

  it('finds a thread of another computer by name and opens it by its qualified id', () => {
    const threads = [row('mine', 'Fix the login'), row('nod_other:remote', 'Fix the build', { node: 'nod_other' })]
    const found = flattenGroups(buildPaletteGroups({ query: 'fix', commands: [], threads, projects: [] }))
    expect(found.map((item) => [item.kind, item.id])).toEqual(
      expect.arrayContaining([['thread', 'mine'], ['thread', 'nod_other:remote']])
    )
    // A subagent of the other computer stays under its parent, as a local one does.
    const withChild = [
      ...threads,
      row('nod_other:child', 'Fix the build, part two', {
        node: 'nod_other',
        lineage: { parentThreadId: 'nod_other:remote', rootThreadId: 'nod_other:remote', relationship: 'subagent' }
      })
    ]
    const ids = flattenGroups(buildPaletteGroups({ query: 'fix', commands: [], threads: withChild, projects: [] })).map((item) => item.id)
    expect(ids).not.toContain('nod_other:child')
  })

  const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
    ({ id, name, path: `/p/${name}`, createdAt: '', order: 0, ...over }) as Project
  const computers = { nod_other: { name: 'Studio' } }
  const items = (query: string, threads: Thread[], projects: Project[]) =>
    flattenGroups(buildPaletteGroups({ query, commands: [], threads, projects, computers }))

  it('names the computer on a thread of another computer, after its project', () => {
    const projects = [project('p1', 'Mousse'), project('nod_other:rp', 'mousse-copy', { node: 'nod_other', sameAs: 'p1' })]
    const threads = [
      row('mine', 'Fix the login', { projectId: 'p1' }),
      row('nod_other:remote', 'Fix the build', { node: 'nod_other', projectId: 'nod_other:rp' }),
      row('nod_other:loose', 'Fix the docs', { node: 'nod_other' }),
      row('nod_unknown:gone', 'Fix the cache', { node: 'nod_unknown' })
    ]
    const details = Object.fromEntries(items('fix', threads, projects).map((item) => [item.id, item.kind === 'command' ? '' : item.detail]))
    // A thread of this computer names its project only. A thread of the same repository on another computer
    // is named with the group's project, not that computer's own name for it.
    expect(details).toEqual({
      mine: 'Mousse',
      'nod_other:remote': 'Mousse · Studio',
      'nod_other:loose': 'Studio',
      'nod_unknown:gone': 'Another computer'
    })
  })

  it('lists a project that several computers hold as one row, opened on its newest thread of any of them', () => {
    const projects = [
      project('p1', 'Mousse'),
      project('nod_other:rp', 'mousse-copy', { node: 'nod_other', sameAs: 'p1' })
    ]
    const threads = [
      row('mine', 'Old', { projectId: 'p1', updatedAt: '2026-01-02T00:00:00.000Z' }),
      row('nod_other:newer', 'Newer', { node: 'nod_other', projectId: 'nod_other:rp', updatedAt: '2026-02-01T00:00:00.000Z' })
    ]
    const rows = items('mousse', threads, projects).filter((item) => item.kind === 'project')
    expect(rows).toEqual([
      { kind: 'project', key: 'project:p1', id: 'p1', title: 'Mousse', detail: 'Project', threadId: 'nod_other:newer' }
    ])
    // The other computer's own name for it finds the same row.
    expect(items('copy', threads, projects).filter((item) => item.kind === 'project').map((item) => item.id)).toEqual(['p1'])
  })

  it('names the computer on a project that only another computer has, and opens it there', () => {
    const projects = [project('p1', 'Mousse'), project('nod_other:solo', 'Notes', { node: 'nod_other' })]
    const rows = items('notes', [], projects).filter((item) => item.kind === 'project')
    expect(rows).toEqual([
      { kind: 'project', key: 'project:nod_other:solo', id: 'nod_other:solo', title: 'Notes', detail: 'Project · Studio', threadId: undefined }
    ])
  })

  it('keeps a project whose computer is offline', () => {
    const projects = [project('nod_other:solo', 'Notes', { node: 'nod_other', offline: true })]
    const threads = [row('nod_other:t', 'Offline thread', { node: 'nod_other', projectId: 'nod_other:solo', offline: true })]
    const rows = items('notes', threads, projects).filter((item) => item.kind === 'project')
    expect(rows.map((item) => [item.id, item.kind === 'project' ? item.threadId : undefined])).toEqual([['nod_other:solo', 'nod_other:t']])
  })
})
