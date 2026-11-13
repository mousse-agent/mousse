// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { TurnEditSummary } from '../../src/renderer/chat/components/agent-elements/turn-edit-summary'
import { ChatSettings } from '../../src/renderer/components/settings/ChatSettings'
import { setTurnChangedFiles } from '../../src/renderer/lib/turnChangedFilesSetting'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useChangesStore } from '../../src/renderer/stores/changesStore'
import { DocumentPanel } from '../../src/renderer/components/DocumentPanel'
import { ToastHost, dismissToast } from '../../src/renderer/components/ui/Toast'
import { turnFileOpen } from '../../src/renderer/components/changes/turnFileOpen'
import type { ReviewFilesResult, ReviewScope } from '../../src/shared/review'
import type { TurnFileResult } from '../../src/shared/turnFiles'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const edit = (path: string) => ({
  type: 'tool-Edit', toolCallId: path, state: 'output-available',
  input: { file_path: path, old_string: 'a', new_string: 'b\nc' }
})
const outside = 'J:/ryspa/mousse/scratch/mousse-test.txt'
const files = ['src/cart/Cart.tsx', 'src/cart/useCart.ts', 'docs/cart.md', outside]
const messages = [{ id: 'a1', role: 'assistant', parts: files.map(edit) }] as unknown as UIMessage[]
const turnId = 'run:thread:t1:ordinal:2'

const draw = () => act(() => root.render(createElement(TurnEditSummary, { messages, turnId })))
const click = (target: Element | null) => act(() => { (target as HTMLElement).click() })
const toggle = () => host.querySelector<HTMLButtonElement>('.turn-edits-toggle')!
const fileList = () => host.querySelector('.turn-edits-files')
/** openTurnInChanges awaits the worktree check before it opens the Changes tab. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

/** The thread's own worktree, or the shared checkout of a thread without one. */
const ownWorktree = { metadata: { lifecycle: 'ready' }, execution: { lifecycle: 'ready', workspacePath: '/wt/t1', primaryPath: '/repo' } }
const sharedCheckout = { metadata: null, execution: { lifecycle: 'unprovisioned', workspacePath: '/repo', primaryPath: '/repo' } }
let status: unknown
/** What the Changes tab lists for each scope, and where each written file stands on disk. */
let listed: Partial<Record<ReviewScope['kind'], string[]>>
let located: Record<string, TurnFileResult>
const turnFileCalls: string[] = []

const listOf = (scope: ReviewScope, root: string): ReviewFilesResult => ({
  root, scope, range: { from: null, to: { kind: 'worktree' } }, truncated: false, mergeCommits: 0,
  files: (scope.kind === 'worktree' && scope.staged ? [] : listed[scope.kind] ?? []).map((path) => ({ path, status: 'modified', additions: 1, deletions: 1, binary: false, countsExact: true }))
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  status = ownWorktree
  listed = { turn: ['src/cart/Cart.tsx', 'src/cart/useCart.ts', 'docs/cart.md'] }
  located = {}
  turnFileCalls.length = 0
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getActiveProjectPath: async () => '/wt/t1', getFilesRoot: async () => '/wt/t1' },
    workspace: { getStatus: async () => status },
    review: {
      files: async ({ scope }: { scope: ReviewScope }) => listOf(scope, status === ownWorktree ? '/wt/t1' : '/repo'),
      turnFile: async ({ path }: { path: string }) => {
        turnFileCalls.push(path)
        const found = located[path]
        if (!found) throw new Error('Only a file this thread’s agent wrote opens here')
        return found
      }
    }
  }
  useAppStore.setState({ activeThreadId: 't1', mainView: 'browser', openedSurfaceKinds: [], mainAreaOpen: false, documentTabs: [], activeDocumentTabId: null })
  useChangesStore.setState({ byThread: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setTurnChangedFiles('summary')
  act(() => dismissToast())
})

describe('changed files after a turn', () => {
  it('is one collapsed line by default: count, line totals, Review and a chevron', () => {
    draw()
    const line = host.querySelector('.turn-edits-line')!
    expect(line.textContent).toBe('4 files changed+8−4Review')
    expect(host.querySelector('.turn-edits-add')!.textContent).toBe('+8')
    expect(host.querySelector('.turn-edits-del')!.textContent).toBe('−4')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-label')).toBe('Show changed files')
    expect(fileList()).toBeNull()
  })

  it('the chevron lists the files, and hides them again', () => {
    draw()
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect([...fileList()!.querySelectorAll('.turn-edits-file-name')].map((entry) => entry.textContent)).toEqual(['Cart.tsx', 'useCart.ts', 'cart.md', 'mousse-test.txt'])
    click(toggle())
    expect(fileList()).toBeNull()
  })

  it('"Full list" starts with the files listed', () => {
    setTurnChangedFiles('list')
    draw()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(fileList()!.querySelectorAll('li')).toHaveLength(4)
  })

  it('"Off" shows nothing, and follows a change of the setting', () => {
    setTurnChangedFiles('off')
    draw()
    expect(host.innerHTML).toBe('')
    act(() => setTurnChangedFiles('summary'))
    expect(host.querySelector('.turn-edits-line')).not.toBeNull()
  })

  it('Review opens the Changes tab on this turn', async () => {
    draw()
    click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Review')!)
    await settle()
    expect(useChangesStore.getState().byThread.t1.requested).toBe(`turn:${turnId}`)
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('a listed file opens the Changes tab on this turn at that file', async () => {
    draw()
    click(toggle())
    click(host.querySelector('[aria-label="Review src/cart/useCart.ts"]'))
    await settle()
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ requested: `turn:${turnId}`, pendingFile: { path: 'src/cart/useCart.ts' } })
    expect(useAppStore.getState().mainView).toBe('git')
  })
})

describe('a changed file the Changes tab does not list', () => {
  const clickFile = async (path: string) => {
    draw()
    click(toggle())
    click(host.querySelector(`[aria-label="Review ${path}"]`))
    await settle()
  }

  it('in another repository, opens its diff against that repository in the Documents tab', async () => {
    located[outside] = {
      kind: 'diff', path: outside,
      version: { root: 'J:/ryspa/mousse', path: 'scratch/mousse-test.txt', original: { content: 'one\n', size: 4 }, modified: { content: 'two\n', size: 4 } }
    }
    await clickFile(outside)
    const state = useAppStore.getState()
    expect(state.mainView).toBe('documents')
    expect(state.mainAreaOpen).toBe(true)
    expect(state.documentTabs).toMatchObject([{ title: 'mousse-test.txt', turnFile: { threadId: 't1', path: outside } }])
    expect(useChangesStore.getState().byThread.t1).toBeUndefined()

    // The tab shows the file's path and reads its diff, read-only.
    const panel = document.createElement('div')
    document.body.append(panel)
    const panelRoot = createRoot(panel)
    act(() => panelRoot.render(createElement(DocumentPanel)))
    await settle()
    expect(panel.querySelector('.turn-file-diff-path')!.textContent).toBe(outside)
    expect(turnFileCalls.filter((path) => path === outside)).toHaveLength(2)
    expect(panel.querySelector('.changes-diff')).not.toBeNull()
    expect(panel.querySelector('[aria-label="Hunk actions"]')).toBeNull()
    act(() => panelRoot.unmount())
    panel.remove()
  })

  it('with nothing for Git to show, opens the file in the Files tab', async () => {
    located[outside] = { kind: 'plain', path: outside }
    const opened: unknown[] = []
    const listen = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener('mousse:open-file', listen)
    try {
      await clickFile(outside)
    } finally {
      window.removeEventListener('mousse:open-file', listen)
    }
    expect(opened).toEqual([{ path: outside, threadId: 't1' }])
    expect(useAppStore.getState().documentTabs).toEqual([])
  })

  it('that no longer exists, says so in one line', async () => {
    located[outside] = { kind: 'missing', path: outside }
    const toasts = document.createElement('div')
    document.body.append(toasts)
    const toastRoot = createRoot(toasts)
    act(() => toastRoot.render(createElement(ToastHost)))
    await clickFile(outside)
    expect(document.body.textContent).toContain('mousse-test.txt no longer exists')
    expect(useAppStore.getState().mainView).toBe('browser')
    act(() => toastRoot.unmount())
    toasts.remove()
  })

  it('on a thread without its own worktree, opens Uncommitted at the file when it lists it', async () => {
    status = sharedCheckout
    listed = { worktree: ['src/cart/useCart.ts'] }
    await clickFile('src/cart/useCart.ts')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ requested: 'uncommitted', pendingFile: { path: 'src/cart/useCart.ts' } })
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('opens the Changes tab as before when the file cannot be looked up', async () => {
    listed = {}
    await clickFile('docs/cart.md')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ requested: `turn:${turnId}`, pendingFile: { path: 'docs/cart.md' } })
  })
})

describe('where a clicked file opens', () => {
  const path = '/elsewhere/a.txt'
  const version = { root: '/elsewhere', path: 'a.txt', original: null, modified: { content: 'a\n', size: 2 } }
  const rows: Array<[string, Parameters<typeof turnFileOpen>[0], ReturnType<typeof turnFileOpen>['kind']]> = [
    ['listed by the Changes tab', { listed: true, located: { kind: 'diff', path, version } }, 'changes'],
    ['listed, though gone from disk (the turn deleted it)', { listed: true, located: { kind: 'missing', path } }, 'changes'],
    ['not listed, changed in its own repository', { listed: false, located: { kind: 'diff', path, version } }, 'diff'],
    ['not listed, nothing for Git to show', { listed: false, located: { kind: 'plain', path } }, 'file'],
    ['not listed, gone', { listed: false, located: { kind: 'missing', path } }, 'missing'],
    ['not looked up (older service, another computer)', { listed: false, located: null }, 'changes']
  ]
  it.each(rows)('%s', (_name, input, kind) => {
    expect(turnFileOpen(input).kind).toBe(kind)
  })
})

describe('Settings > Chat > Changed files after each turn', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mousse-turn-files-setting-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('saves the choice, and a fresh settings store reads it back', () => {
    const store = new SettingsStore(MousseConfigStore.load(home))
    const before = store.get().appearance
    const drawSettings = () => act(() => root.render(createElement(ChatSettings, {
      settings: store.get(),
      onUpdate: async (partial) => { store.set(partial); drawSettings() },
      onPreviewFrostedComposer: () => undefined,
      onCommitFrostedComposer: () => undefined
    })))
    drawSettings()
    const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Changed files after each turn"]')!
    expect(trigger().textContent).toContain('Summary line')
    click(trigger())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Summary line', 'Full list', 'Off'])
    click(options.find((option) => option.textContent === 'Off')!)
    expect(trigger().textContent).toContain('Off')
    // Saved to disk, with the other appearance choices unchanged.
    expect(new SettingsStore(MousseConfigStore.load(home)).get().appearance).toEqual({ ...before, turnChangedFiles: 'off' })
  })
})
