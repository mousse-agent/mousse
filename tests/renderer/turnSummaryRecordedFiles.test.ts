// @vitest-environment jsdom
/**
 * The changed-files summary under a turn lists every file the turn changed, not only those its Edit and Write calls
 * name: once the summary has stayed on screen, the turn's recorded changes (the list Review shows) join it, so a file a
 * shell command changed is listed and counted. Listed files that are gone, or that the turn deleted, say so. Nothing
 * is read for a running turn, and a long thread reads only the turns that stay on screen.
 */
import { act, createElement, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnEditSummary } from '../../src/renderer/chat/components/agent-elements/turn-edit-summary'
import { RECORDED_READ_DWELL_MS, resetRecordedTurnsForTests } from '../../src/renderer/chat/components/agent-elements/turn-recorded-files'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { setTurnChangedFiles } from '../../src/renderer/lib/turnChangedFilesSetting'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ReviewFileEntry, ReviewFilesResult, ReviewScope } from '../../src/shared/review'
import type { TurnFileResult } from '../../src/shared/turnFiles'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

const FOLDER = '/wt/t1'
const outside = '/elsewhere/notes.txt'
/** What Mousse recorded for each turn, what each folder holds now, and which files outside the folder are gone. */
let recorded: Record<string, ReviewFileEntry[]>
let onDisk: Record<string, string[]>
let goneOutside: Set<string>
const reads: string[] = []

const entry = (path: string, additions: number, deletions: number, status: ReviewFileEntry['status'] = 'modified'): ReviewFileEntry =>
  ({ path, status, additions, deletions, binary: false, countsExact: true })

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  resetRecordedTurnsForTests()
  reads.length = 0
  recorded = {}
  onDisk = {}
  goneOutside = new Set()
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getActiveProjectPath: async () => FOLDER },
    git: { heads: async () => ({ projects: {}, threads: { t1: { own: true, branch: 'b', folder: FOLDER, generation: 1, lifecycle: 'ready' } } }) },
    workspace: { getStatus: async () => ({}) },
    review: {
      files: async ({ scope }: { scope: ReviewScope }): Promise<ReviewFilesResult> => {
        const turnId = scope.kind === 'turn' ? scope.turnId : ''
        reads.push(turnId)
        return { root: FOLDER, scope, range: { from: null, to: { kind: 'worktree' } }, truncated: false, mergeCommits: 0, files: recorded[turnId] ?? [] }
      },
      turnFile: async ({ path }: { path: string }): Promise<TurnFileResult> =>
        goneOutside.has(path) ? { kind: 'missing', path } : { kind: 'plain', path }
    },
    fs: {
      listDir: async (folder?: string) => {
        const names = onDisk[folder ?? '']
        if (!names) throw new Error(`ENOENT: no such file or directory, scandir '${FOLDER}/${folder}'`)
        return names.map((name) => ({ name, path: folder ? `${folder}/${name}` : name, kind: 'file' }))
      }
    }
  }
  useAppStore.setState({ activeThreadId: 't1', messages: [] })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  setTurnChangedFiles('summary')
  useAppStore.setState({ messages: [], activeThreadId: null })
  vi.unstubAllGlobals()
})

/** Waits out the summary's time on screen and the reads that follow it. */
const settle = (ms = RECORDED_READ_DWELL_MS + 50) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

const editPart = (path: string) => ({ type: 'tool-Edit', toolCallId: path, state: 'output-available', input: { file_path: path, old_string: 'a', new_string: 'b' } })
const bashPart = (command: string) => ({ type: 'tool-Bash', toolCallId: command, state: 'output-available', input: { command }, output: 'ok' })

const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-edits-file')]
const row = (path: string) => host.querySelector<HTMLButtonElement>(`[aria-label="Review ${path}"]`)

describe('the summary under a finished turn', () => {
  const turnId = 'run:t1:1'
  const draw = (parts: unknown[]) =>
    act(() => root.render(createElement(TurnEditSummary, { messages: [{ id: 'a1', role: 'assistant', parts }] as unknown as UIMessage[], turnId })))

  it('lists and counts a file a shell command changed, with the recorded line counts', async () => {
    recorded[turnId] = [entry('src/app.ts', 3, 1), entry('src/generated.ts', 10, 2)]
    setTurnChangedFiles('list')
    draw([editPart(`${FOLDER}/src/app.ts`), bashPart('node scripts/gen.js')])
    expect(host.querySelector('.turn-edits-count')!.textContent).toBe('1 file changed')
    await settle()
    await settle()
    expect(host.querySelector('.turn-edits-count')!.textContent).toBe('2 files changed')
    expect(rows().map((button) => button.getAttribute('aria-label'))).toEqual(['Review src/app.ts', 'Review src/generated.ts'])
    expect(host.querySelector('.turn-edits-line .turn-edits-add')!.textContent).toBe('+13')
    expect(host.querySelector('.turn-edits-line .turn-edits-del')!.textContent).toBe('−3')
    expect(reads).toEqual([turnId])
  })

  it('shows a turn that changed files only through a shell command', async () => {
    recorded[turnId] = [entry('build/out.txt', 1, 0, 'added')]
    draw([bashPart('make')])
    expect(host.querySelector('.turn-edits')).toBeNull()
    await settle()
    await settle()
    expect(host.querySelector('.turn-edits-count')!.textContent).toBe('1 file changed')
  })

  it('keeps a file outside the thread’s folder, which the recorded list cannot see', async () => {
    recorded[turnId] = [entry('src/app.ts', 1, 1)]
    setTurnChangedFiles('list')
    draw([editPart(`${FOLDER}/src/app.ts`), editPart(outside)])
    await settle()
    await settle()
    expect(rows().map((button) => button.getAttribute('aria-label'))).toEqual(['Review src/app.ts', `Review ${outside}`])
  })

  it('strikes through a file that is gone or that the turn deleted, and leaves present files alone', async () => {
    recorded[turnId] = [entry('src/app.ts', 1, 1), entry('src/later-removed.ts', 4, 0, 'added'), entry('src/old.ts', 0, 9, 'deleted'), entry('tmp/run.log', 2, 0, 'added')]
    // src/later-removed.ts was deleted after the turn; the whole tmp folder is gone; the file outside is gone too.
    onDisk = { src: ['app.ts'] }
    goneOutside = new Set([outside])
    draw([editPart(`${FOLDER}/src/app.ts`), editPart(outside), bashPart('rm src/old.ts')])
    await settle()
    await settle()
    expect(rows()).toHaveLength(0)
    act(() => host.querySelector<HTMLButtonElement>('.turn-edits-toggle')!.click())
    await settle(20)
    expect(row('src/app.ts')!.title).toBe('src/app.ts')
    expect(row('src/later-removed.ts')!.title).toBe('No longer exists')
    expect(row('tmp/run.log')!.title).toBe('No longer exists')
    expect(row(outside)!.title).toBe('No longer exists')
    expect(row('src/old.ts')!.title).toBe('Deleted in this turn')
    expect(rows().filter((button) => button.hasAttribute('data-gone'))).toHaveLength(4)
  })

  it('looks nothing up while the list is closed', async () => {
    recorded[turnId] = [entry('src/app.ts', 1, 1)]
    const listDir = vi.spyOn((window as unknown as { mousse: { fs: { listDir: () => unknown } } }).mousse.fs, 'listDir')
    draw([editPart(`${FOLDER}/src/app.ts`)])
    await settle()
    await settle()
    expect(listDir).not.toHaveBeenCalled()
  })
})

describe('in the chat', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 26, 10, 0, 0) + n * 1000).toISOString()
  const prompt = (n: number): ChatMessage => ({ id: `u${n}`, role: 'user', content: `step ${n}`, timestamp: at(n * 10), turnId: `turn-${n}` })
  const call = (n: number, toolName: 'Edit' | 'Bash', input: Record<string, unknown>): ChatMessage => ({
    id: `c${n}-${toolName}`, role: 'system', kind: 'tool_call', content: '', timestamp: at(n * 10 + 1),
    toolCall: { title: toolName, summary: toolName, details: [`Tool: ${toolName}`], status: 'complete', toolName, input, response: 'ok' }
  } as ChatMessage)
  const reply = (n: number): ChatMessage => ({ id: `r${n}`, role: 'assistant', content: 'Done.', timestamp: at(n * 10 + 2) })
  const turn = (n: number) => [prompt(n), call(n, 'Edit', { file_path: `${FOLDER}/src/a${n}.ts`, old_string: 'a', new_string: 'b' }), call(n, 'Bash', { command: 'npm run gen' }), reply(n)]

  function Transcript({ status }: { status: 'streaming' | 'ready' }) {
    const messages = useAppStore((s) => s.messages)
    const ui = useMemo(() => mousseToUIMessages(messages), [messages])
    return createElement(MessageList, { messages: ui, status })
  }
  const render = (status: 'streaming' | 'ready') => act(() => root.render(createElement(Transcript, { status })))

  it('reads nothing while the turn runs, and reads it once it ends', async () => {
    recorded['turn-1'] = [entry('src/a1.ts', 1, 1), entry('src/gen.ts', 5, 0)]
    useAppStore.setState({ messages: turn(1) })
    render('streaming')
    await settle()
    await settle()
    expect(reads).toEqual([])
    render('ready')
    await settle()
    await settle()
    expect(reads).toEqual(['turn-1'])
    expect(host.querySelector('.turn-edits-count')!.textContent).toBe('2 files changed')
  })

  it('reads only the turns that stay on screen', async () => {
    let report: ((entries: IntersectionObserverEntry[]) => void) | undefined
    const seen = new Set<Element>()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) { report = callback }
      observe(target: Element) { report!([{ target, isIntersecting: seen.has(target) } as IntersectionObserverEntry]) }
      unobserve() {}
      disconnect() {}
    })
    for (const n of [1, 2, 3, 4, 5]) recorded[`turn-${n}`] = [entry(`src/a${n}.ts`, 1, 1)]
    useAppStore.setState({ messages: [1, 2, 3, 4, 5].flatMap(turn) })
    render('ready')
    await settle()
    expect(reads).toEqual([])
    // The last turn's summary scrolls into view and stays.
    const summaries = [...host.querySelectorAll('.turn-edits')]
    expect(summaries).toHaveLength(5)
    act(() => report!([{ target: summaries[4]!, isIntersecting: true } as IntersectionObserverEntry]))
    await settle()
    expect(reads).toEqual(['turn-5'])
    // One scrolled past, out of view before its time on screen, reads nothing.
    act(() => report!([{ target: summaries[2]!, isIntersecting: true } as IntersectionObserverEntry]))
    act(() => report!([{ target: summaries[2]!, isIntersecting: false } as IntersectionObserverEntry]))
    await settle()
    expect(reads).toEqual(['turn-5'])
  })
})
