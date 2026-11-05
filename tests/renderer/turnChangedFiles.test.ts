// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { TurnEditSummary } from '../../src/renderer/chat/components/agent-elements/turn-edit-summary'
import { GeneralSettings } from '../../src/renderer/components/settings/GeneralSettings'
import { setTurnChangedFiles } from '../../src/renderer/lib/turnChangedFilesSetting'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useReviewStore } from '../../src/renderer/stores/reviewStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { THEME_OPTIONS } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const edit = (path: string) => ({
  type: 'tool-Edit', toolCallId: path, state: 'output-available',
  input: { file_path: path, old_string: 'a', new_string: 'b\nc' }
})
const files = ['src/cart/Cart.tsx', 'src/cart/useCart.ts', 'docs/cart.md']
const messages = [{ id: 'a1', role: 'assistant', parts: files.map(edit) }] as unknown as UIMessage[]
const turnId = 'run:thread:t1:ordinal:2'

const draw = () => act(() => root.render(createElement(TurnEditSummary, { messages, turnId })))
const click = (target: Element | null) => act(() => { (target as HTMLElement).click() })
const toggle = () => host.querySelector<HTMLButtonElement>('.turn-edits-toggle')!
const fileList = () => host.querySelector('.turn-edits-files')
/** openTurnInReview awaits the worktree check before it opens Review. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getActiveProjectPath: async () => '/wt/t1', getFilesRoot: async () => '/wt/t1' },
    workspace: { getStatus: async () => ({ metadata: { lifecycle: 'ready' }, execution: { lifecycle: 'ready', workspacePath: '/wt/t1', primaryPath: '/repo' } }) }
  }
  useAppStore.setState({ activeThreadId: 't1', mainView: 'browser', openedSurfaceKinds: [], mainAreaOpen: false })
  useReviewStore.setState({ byThread: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setTurnChangedFiles('summary')
})

describe('changed files after a turn', () => {
  it('is one collapsed line by default: count, line totals, Review and a chevron', () => {
    draw()
    const line = host.querySelector('.turn-edits-line')!
    expect(line.textContent).toBe('3 files changed+6−3Review')
    expect(host.querySelector('.turn-edits-add')!.textContent).toBe('+6')
    expect(host.querySelector('.turn-edits-del')!.textContent).toBe('−3')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-label')).toBe('Show changed files')
    expect(fileList()).toBeNull()
  })

  it('the chevron lists the files, and hides them again', () => {
    draw()
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect([...fileList()!.querySelectorAll('.turn-edits-file-name')].map((entry) => entry.textContent)).toEqual(['Cart.tsx', 'useCart.ts', 'cart.md'])
    click(toggle())
    expect(fileList()).toBeNull()
  })

  it('"Full list" starts with the files listed', () => {
    setTurnChangedFiles('list')
    draw()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(fileList()!.querySelectorAll('li')).toHaveLength(3)
  })

  it('"Off" shows nothing, and follows a change of the setting', () => {
    setTurnChangedFiles('off')
    draw()
    expect(host.innerHTML).toBe('')
    act(() => setTurnChangedFiles('summary'))
    expect(host.querySelector('.turn-edits-line')).not.toBeNull()
  })

  it('Review opens Review on this turn', async () => {
    draw()
    click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Review')!)
    await settle()
    expect(useReviewStore.getState().byThread.t1.scope).toEqual({ kind: 'turn', turnId })
    expect(useAppStore.getState().mainView).toBe('review')
  })

  it('a listed file opens Review on this turn at that file', async () => {
    draw()
    click(toggle())
    click(host.querySelector('[aria-label="Review src/cart/useCart.ts"]'))
    await settle()
    expect(useReviewStore.getState().byThread.t1).toMatchObject({ scope: { kind: 'turn', turnId }, pendingFile: { path: 'src/cart/useCart.ts' } })
  })
})

describe('Settings > General > Changed files after each turn', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mousse-turn-files-setting-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('saves the choice, and a fresh settings store reads it back', () => {
    const store = new SettingsStore(MousseConfigStore.load(home))
    const before = store.get().appearance
    const drawSettings = () => act(() => root.render(createElement(GeneralSettings, {
      settings: store.get(),
      options: { themes: THEME_OPTIONS, accentColors: [], llmProviders: [], agentTypes: [] },
      onUpdate: async (partial) => { store.set(partial); drawSettings() },
      restartRequired: false,
      onRestart: () => undefined,
      onPreviewAcrylicIntensity: () => undefined,
      onCommitAcrylicIntensity: () => undefined
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
