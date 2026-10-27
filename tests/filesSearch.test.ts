import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FilesSearchView, searchNotes } from '../src/renderer/components/FilesSearch'
import {
  DEFAULT_TEXT_TIMEOUT_MS,
  EXTENDED_TEXT_TIMEOUT_MS,
  applySearchKey,
  createFilesSearchState,
  enterAction,
  filesSearchKeyAction,
  filesSearchReducer,
  groupGrepMatches,
  openLineDetail,
  rowsAreCurrent,
  searchKey,
  searchRows,
  snippetHighlight,
  type FilesSearchAction,
  type FilesSearchHandlers,
  type FilesSearchState
} from '../src/renderer/components/filesSearchState'
import { fileWorkspaceScope } from '../src/renderer/stores/filesStore'
import type { FileGrepMatch, FileGrepResponse, FileSearchResponse, FileSearchResult } from '../src/shared/types'

const SCOPE = fileWorkspaceScope('default', 'thread-a', 'project-a')
const OTHER_SCOPE = fileWorkspaceScope('default', 'thread-b', 'project-a')

function file(path: string, positions: number[] = []): FileSearchResult {
  return { path, kind: 'file', score: 1, positions }
}

function filesResponse(results: FileSearchResult[], over: Partial<FileSearchResponse> = {}): FileSearchResponse {
  return {
    root: '/repo',
    source: 'git',
    results,
    indexed: results.length,
    indexedAt: null,
    truncated: false,
    indexing: false,
    complete: true,
    ...over
  }
}

function match(path: string, line: number, over: Partial<FileGrepMatch> = {}): FileGrepMatch {
  return { path, line, column: 1, matchLength: 3, text: 'foo bar', snippetStart: 0, ...over }
}

function grepResponse(matches: FileGrepMatch[], over: Partial<FileGrepResponse> = {}): FileGrepResponse {
  return {
    root: '/repo',
    source: 'git',
    matches,
    filesWithMatches: new Set(matches.map((m) => m.path)).size,
    truncated: false,
    timedOut: false,
    indexing: false,
    skippedLongLines: 0,
    elapsedMs: 5,
    ...over
  }
}

function reduce(state: FilesSearchState, ...actions: FilesSearchAction[]): FilesSearchState {
  return actions.reduce(filesSearchReducer, state)
}

/** A box that asked `query` as request 1 and got `response`. */
function answeredFiles(query: string, response: FileSearchResponse, scopeKey = SCOPE): FilesSearchState {
  const state = reduce(createFilesSearchState('files', scopeKey), { type: 'query', query })
  return reduce(
    state,
    { type: 'request-started', request: 1, key: searchKey(state) },
    { type: 'response', request: 1, scopeKey, key: searchKey(state), result: { mode: 'files', response } }
  )
}

function answeredText(query: string, response: FileGrepResponse, timeoutMs = DEFAULT_TEXT_TIMEOUT_MS): FilesSearchState {
  const state = reduce(createFilesSearchState('text', SCOPE), { type: 'query', query })
  return reduce(
    state,
    { type: 'request-started', request: 1, key: searchKey(state) },
    { type: 'response', request: 1, scopeKey: SCOPE, key: searchKey(state), result: { mode: 'text', response, timeoutMs } }
  )
}

const noopHandlers = (): FilesSearchHandlers & Record<keyof FilesSearchHandlers, ReturnType<typeof vi.fn>> => ({
  onAction: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenLine: vi.fn(),
  onClose: vi.fn()
})

function render(state: FilesSearchState): string {
  return renderToStaticMarkup(
    createElement(FilesSearchView, { state, onAction: () => {}, onOpenFile: () => {}, onOpenLine: () => {}, onClose: () => {} })
  )
}

const twentyFiles = Array.from({ length: 20 }, (_, i) => file(`src/file${String(i).padStart(2, '0')}.ts`))

describe('quick open state', () => {
  it('shows the answer of the latest request', () => {
    const state = answeredFiles('com', filesResponse([file('src/components/Chat.tsx', [4, 5, 6]), file('src/comp.ts')]))
    expect(state.status).toBe('ready')
    expect(state.files.map((f) => f.path)).toEqual(['src/components/Chat.tsx', 'src/comp.ts'])
    expect(rowsAreCurrent(state)).toBe(true)
  })

  it('drops an answer for an earlier request', () => {
    const typed = reduce(createFilesSearchState('files', SCOPE), { type: 'query', query: 'a' })
    const first = searchKey(typed)
    const second = reduce(typed, { type: 'query', query: 'ab' })
    const asked = reduce(
      second,
      { type: 'request-started', request: 1, key: first },
      { type: 'request-started', request: 2, key: searchKey(second) }
    )
    const late = reduce(asked, {
      type: 'response',
      request: 1,
      scopeKey: SCOPE,
      key: first,
      result: { mode: 'files', response: filesResponse([file('late.ts')]) }
    })
    expect(late).toBe(asked)
    expect(late.files).toEqual([])
    expect(late.status).toBe('loading')
  })

  it('drops an answer that belongs to another thread, and an error from one', () => {
    const asked = reduce(createFilesSearchState('files', SCOPE), { type: 'request-started', request: 1, key: 'k' })
    const wrongScope = reduce(asked, {
      type: 'response',
      request: 1,
      scopeKey: OTHER_SCOPE,
      key: 'k',
      result: { mode: 'files', response: filesResponse([file('other-thread.ts')]) }
    })
    expect(wrongScope).toBe(asked)
    expect(reduce(asked, { type: 'error', request: 1, scopeKey: OTHER_SCOPE, message: 'boom' })).toBe(asked)
    expect(reduce(asked, { type: 'error', request: 9, scopeKey: SCOPE, message: 'boom' })).toBe(asked)
  })

  it('drops an answer that comes after the box changed mode', () => {
    const asked = reduce(createFilesSearchState('files', SCOPE), { type: 'request-started', request: 1, key: 'k' })
    const switched = reduce(asked, { type: 'mode', mode: 'text' })
    const late = reduce(switched, {
      type: 'response',
      request: 1,
      scopeKey: SCOPE,
      key: 'k',
      result: { mode: 'files', response: filesResponse([file('late.ts')]) }
    })
    expect(late).toBe(switched)
    expect(late.files).toEqual([])
  })

  it('clears rows and selection when the thread or project changes, and ignores a repeat', () => {
    const state = reduce(answeredFiles('f', filesResponse(twentyFiles)), { type: 'move', key: 'End' })
    expect(state.selected).toBe(19)
    const moved = reduce(state, { type: 'scope-changed', scopeKey: OTHER_SCOPE })
    expect(moved).toMatchObject({ files: [], groups: [], selected: 0, status: 'idle', request: 0, scopeKey: OTHER_SCOPE, resultsKey: null, meta: null })
    expect(moved.query).toBe('f')
    expect(reduce(moved, { type: 'scope-changed', scopeKey: OTHER_SCOPE })).toBe(moved)
    // The old thread's answer, still in flight, is now dropped.
    const late = reduce(moved, {
      type: 'response',
      request: 1,
      scopeKey: SCOPE,
      key: 'files\0f',
      result: { mode: 'files', response: filesResponse([file('old.ts')]) }
    })
    expect(late.files).toEqual([])
  })

  it('moves the selection with the arrows, pages, Home and End over 20 rows', () => {
    let state = answeredFiles('f', filesResponse(twentyFiles))
    const at = (key: string) => (state = reduce(state, { type: 'move', key })).selected
    expect(at('ArrowDown')).toBe(1)
    expect(at('PageDown')).toBe(9)
    expect(at('PageDown')).toBe(17)
    expect(at('PageDown')).toBe(19)
    expect(at('ArrowDown')).toBe(0)
    expect(at('ArrowUp')).toBe(19)
    expect(at('Home')).toBe(0)
    expect(at('End')).toBe(19)
    expect(at('PageUp')).toBe(11)
  })

  it('keeps the rows of an earlier query but does not treat them as the answer', () => {
    const answered = answeredFiles('abc', filesResponse([file('abc.ts')]))
    const typing = reduce(answered, { type: 'query', query: 'abcd' })
    expect(typing.files).toHaveLength(1)
    expect(rowsAreCurrent(typing)).toBe(false)
    expect(enterAction(typing)).toBe('none')
    expect(enterAction(answered)).toBe('open')
  })

  it('says the index is still building and keeps the partial rows', () => {
    const state = answeredFiles('a', filesResponse([file('a.ts')], { indexing: true, source: null }))
    expect(state.status).toBe('indexing')
    expect(state.files).toHaveLength(1)
    expect(searchNotes(state).map((n) => n.id)).toContain('indexing')
  })

  it('shows an error verbatim and drops the rows', () => {
    const answered = answeredFiles('a', filesResponse([file('a.ts')]))
    const asked = reduce(answered, { type: 'request-started', request: 2, key: 'k' })
    const failed = reduce(asked, { type: 'error', request: 2, scopeKey: SCOPE, message: 'Thread has no project workspace' })
    expect(failed).toMatchObject({ status: 'error', error: 'Thread has no project workspace', files: [] })
    expect(searchNotes(failed)).toEqual([{ id: 'error', tone: 'error', text: 'Thread has no project workspace' }])
  })
})

describe('text search state', () => {
  it('keeps the results grouped by file', () => {
    const state = answeredText('foo', grepResponse([match('b.ts', 9), match('a.ts', 20), match('a.ts', 3)]))
    expect(state.groups.map((g) => [g.path, g.matches.map((m) => m.line)])).toEqual([
      ['a.ts', [3, 20]],
      ['b.ts', [9]]
    ])
    expect(state.meta).toMatchObject({ matchCount: 3, fileCount: 2 })
    expect(searchRows(state).map((row) => (row.kind === 'match' ? `${row.match.path}:${row.match.line}` : ''))).toEqual([
      'a.ts:3',
      'a.ts:20',
      'b.ts:9'
    ])
  })

  it('sets the Index still building note and the indexing status when the index is incomplete', () => {
    const state = answeredText('foo', grepResponse([match('a.ts', 1)], { indexing: true, source: 'walk' }))
    expect(state.status).toBe('indexing')
    expect(searchNotes(state).find((n) => n.id === 'indexing')?.text).toBe('Index still building — press Enter to search again')
    expect(enterAction(state)).toBe('search')
  })

  it('raises the time budget on Keep searching, and goes back to the default for a new scope or mode', () => {
    const state = answeredText('foo', grepResponse([], { timedOut: true }))
    const more = reduce(state, { type: 'keep-searching' })
    expect(more.timeoutMs).toBe(EXTENDED_TEXT_TIMEOUT_MS)
    expect(reduce(more, { type: 'scope-changed', scopeKey: OTHER_SCOPE }).timeoutMs).toBe(DEFAULT_TEXT_TIMEOUT_MS)
    expect(reduce(more, { type: 'mode', mode: 'files' }).timeoutMs).toBe(DEFAULT_TEXT_TIMEOUT_MS)
  })

  it('treats a changed option like a changed query: the rows no longer answer the box', () => {
    const state = answeredText('foo', grepResponse([match('a.ts', 1)]))
    expect(rowsAreCurrent(state)).toBe(true)
    const toggled = reduce(state, { type: 'toggle', option: 'regex' })
    expect(toggled.options.regex).toBe(true)
    expect(rowsAreCurrent(toggled)).toBe(false)
    expect(enterAction(toggled)).toBe('search')
  })

  it('needs a project: no rows, no request', () => {
    const state = reduce(answeredText('foo', grepResponse([match('a.ts', 1)])), { type: 'needs-project' })
    expect(state).toMatchObject({ status: 'needs-project', groups: [], request: 0 })
  })
})

describe('keyboard', () => {
  const key = (over: Partial<Parameters<typeof filesSearchKeyAction>[0]> & { key: string }) => filesSearchKeyAction(over)

  it('maps arrows and pages to selection moves, Enter to enter, Escape to close', () => {
    expect(key({ key: 'ArrowDown' })).toEqual({ type: 'move', key: 'ArrowDown' })
    expect(key({ key: 'PageUp' })).toEqual({ type: 'move', key: 'PageUp' })
    expect(key({ key: 'Enter' })).toEqual({ type: 'enter' })
    expect(key({ key: 'Escape' })).toEqual({ type: 'close' })
  })

  it('leaves Home and End to the caret unless Ctrl or Cmd is held', () => {
    expect(key({ key: 'Home' })).toBeNull()
    expect(key({ key: 'End', ctrlKey: true })).toEqual({ type: 'move', key: 'End' })
    expect(key({ key: 'Home', metaKey: true })).toEqual({ type: 'move', key: 'Home' })
  })

  it('does nothing while an input method is composing, or for a modified Enter', () => {
    expect(key({ key: 'Enter', isComposing: true })).toBeNull()
    expect(key({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(key({ key: 'Enter', shiftKey: true })).toBeNull()
    expect(key({ key: 'ArrowDown', shiftKey: true })).toBeNull()
  })

  it('quick open: arrows pick the row and Enter opens that file', () => {
    const state = answeredFiles('f', filesResponse([file('a.ts'), file('src/b.ts'), file('c.ts')]))
    const handlers = noopHandlers()
    applySearchKey({ type: 'move', key: 'ArrowDown' }, state, handlers)
    expect(handlers.onAction).toHaveBeenCalledWith({ type: 'move', key: 'ArrowDown' })
    const moved = reduce(state, { type: 'move', key: 'ArrowDown' })
    applySearchKey({ type: 'enter' }, moved, handlers)
    expect(handlers.onOpenFile).toHaveBeenCalledWith('src/b.ts')
    expect(handlers.onOpenLine).not.toHaveBeenCalled()
  })

  it('quick open: Enter does not open a row from an earlier query', () => {
    const typing = reduce(answeredFiles('a', filesResponse([file('a.ts')])), { type: 'query', query: 'ab' })
    const handlers = noopHandlers()
    applySearchKey({ type: 'enter' }, typing, handlers)
    expect(handlers.onOpenFile).not.toHaveBeenCalled()
    expect(handlers.onAction).not.toHaveBeenCalled()
  })

  it('text search: Enter runs the search, then opens the selected match at its line', () => {
    const typed = reduce(createFilesSearchState('text', SCOPE), { type: 'query', query: 'foo' })
    const handlers = noopHandlers()
    applySearchKey({ type: 'enter' }, typed, handlers)
    expect(handlers.onAction).toHaveBeenCalledWith({ type: 'submit' })

    const answered = reduce(answeredText('foo', grepResponse([match('src/a.ts', 12, { column: 5 }), match('src/b.ts', 40)])), {
      type: 'move',
      key: 'ArrowDown'
    })
    const opening = noopHandlers()
    applySearchKey({ type: 'enter' }, answered, opening)
    expect(opening.onOpenLine).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/b.ts', line: 40 }))
    expect(opening.onAction).not.toHaveBeenCalled()
  })

  it('text search: Enter does not start a second search while one is running', () => {
    const typed = reduce(createFilesSearchState('text', SCOPE), { type: 'query', query: 'foo' })
    const running = reduce(typed, { type: 'request-started', request: 1, key: searchKey(typed) })
    expect(enterAction(running)).toBe('none')
  })

  it('opens a match with its path, line and UTF-16 column for the editor', () => {
    expect(openLineDetail(match('src/a.ts', 12, { column: 7 }), 'thread-a')).toEqual({ path: 'src/a.ts', line: 12, column: 7, threadId: 'thread-a' })
    expect(openLineDetail(match('src/a.ts', 12), null).threadId).toBeUndefined()
  })
})

describe('groupGrepMatches', () => {
  it('orders files by path and lines by line then column, and keeps every match', () => {
    const groups = groupGrepMatches([
      match('z.ts', 1),
      match('a/b.ts', 7, { column: 9 }),
      match('a/b.ts', 7, { column: 2 }),
      match('a/b.ts', 2),
      match('m.ts', 5)
    ])
    expect(groups.map((g) => g.path)).toEqual(['a/b.ts', 'm.ts', 'z.ts'])
    expect(groups[0]!.matches.map((m) => [m.line, m.column])).toEqual([[2, 1], [7, 2], [7, 9]])
  })

  it('is empty for no matches', () => {
    expect(groupGrepMatches([])).toEqual([])
  })
})

describe('snippetHighlight', () => {
  it('highlights a match that follows an emoji by UTF-16 column', () => {
    const text = 'a😀b needle c'
    const column = text.indexOf('needle') + 1
    expect(snippetHighlight({ text, column, snippetStart: 0, matchLength: 6 })).toEqual({
      before: 'a😀b ',
      match: 'needle',
      after: ' c',
      caret: false
    })
  })

  it('offsets the column by the snippet start for a match late in a long line', () => {
    const line = `${'x'.repeat(700)}needle${'y'.repeat(300)}`
    const column = line.indexOf('needle') + 1
    const snippetStart = 500
    const text = line.slice(snippetStart, snippetStart + 400)
    const parts = snippetHighlight({ text, column, snippetStart, matchLength: 6 })
    expect(parts.match).toBe('needle')
    expect(parts.after.startsWith('y')).toBe(true)
    // The long lead is cut to its end so the match stays in view.
    expect(parts.before.startsWith('…')).toBe(true)
    expect(parts.before.length).toBeLessThan(60)
    expect(parts.caret).toBe(false)
  })

  it('never starts the shortened lead in the middle of a surrogate pair', () => {
    // 122 units of lead: the cut lands on the second half of an emoji and moves on by one.
    const text = `x${'😀'.repeat(60)}yneedle`
    const parts = snippetHighlight({ text, column: text.indexOf('needle') + 1, snippetStart: 0, matchLength: 6 })
    const first = parts.before.charCodeAt(1)
    expect(first >= 0xd800 && first <= 0xdbff).toBe(true)
  })

  it('marks the column with a caret when a regular-expression match has no length', () => {
    expect(snippetHighlight({ text: '  const x = 1', column: 9, snippetStart: 0, matchLength: null })).toEqual({
      before: 'const ',
      match: '',
      after: 'x = 1',
      caret: true
    })
  })
})

describe('FilesSearchView', () => {
  it('shows the hint for an empty box in each mode', () => {
    expect(render(createFilesSearchState('files', SCOPE))).toContain('Type to find a file by name')
    expect(render(createFilesSearchState('text', SCOPE))).toContain('Type a word or phrase, then press Enter')
    expect(render(createFilesSearchState('text', SCOPE))).toContain('aria-label="Search options"')
    expect(render(createFilesSearchState('files', SCOPE))).not.toContain('aria-label="Search options"')
  })

  it('shows Searching while the first answer is awaited', () => {
    const typed = reduce(createFilesSearchState('files', SCOPE), { type: 'query', query: 'a' })
    const loading = reduce(typed, { type: 'request-started', request: 1, key: searchKey(typed) })
    expect(render(loading)).toContain('Searching…')
  })

  it('renders matched files with highlighted characters, the folder dimmed, and the selected row', () => {
    const state = reduce(
      answeredFiles('chat', filesResponse([file('src/components/ChatComposer.tsx', [15, 16, 17, 18]), file('docs/chat.md', [5, 6, 7, 8])])),
      { type: 'move', key: 'ArrowDown' }
    )
    const html = render(state)
    expect(html).toContain('<mark>Chat</mark>Composer.tsx')
    expect(html).toContain('files-search-row-dir')
    expect(html).toContain('src/components/')
    expect(html).toMatch(/id="files-search-row-1"[^>]*aria-selected="true"/)
    expect(html).toMatch(/id="files-search-row-0"[^>]*aria-selected="false"/)
    expect(html).toContain('files-search-row selected')
    expect(html).not.toContain('Indexing')
  })

  it('says Indexing with the results so far', () => {
    const html = render(answeredFiles('a', filesResponse([file('a.ts')], { indexing: true, source: null })))
    expect(html).toContain('Indexing… results so far')
    expect(html).toContain('a.ts')
  })

  it('says when nothing matches', () => {
    expect(render(answeredFiles('zzz', filesResponse([])))).toContain('No files match')
    expect(render(answeredText('zzz', grepResponse([])))).toContain('No matches')
  })

  it('says a large project was cut short', () => {
    expect(render(answeredFiles('a', filesResponse([file('a.ts')], { truncated: true })))).toContain(
      'Large project: showing the first matches, keep typing'
    )
  })

  it('groups text results by file and highlights each match', () => {
    const state = answeredText(
      'needle',
      grepResponse([
        match('src/a.ts', 12, { text: 'let needle = 1', column: 5, matchLength: 6 }),
        match('src/a.ts', 30, { text: 'use(needle)', column: 5, matchLength: 6 }),
        match('lib/b.ts', 2, { text: 'needle', column: 1, matchLength: 6 })
      ])
    )
    const html = render(state)
    expect(html.indexOf('lib/')).toBeLessThan(html.indexOf('src/'))
    expect(html).toContain('role="group" aria-label="lib/b.ts"')
    expect(html).toContain('role="group" aria-label="src/a.ts"')
    expect(html).toContain('let <mark>needle</mark> = 1')
    expect(html).toContain('use(<mark>needle</mark>)')
    expect(html).toContain('files-search-count')
    expect(html).toMatch(/id="files-search-row-0"[^>]*aria-selected="true"/)
    expect(html).toContain('title="src/a.ts:12:5"')
  })

  it('marks a regular-expression match with a caret', () => {
    const html = render(answeredText('a.c', grepResponse([match('a.ts', 1, { text: 'abc', column: 1, matchLength: null })])))
    expect(html).toContain('files-search-caret')
    expect(html).not.toContain('<mark>')
  })

  it('says the results stopped at the match limit', () => {
    const html = render(answeredText('foo', grepResponse([match('a.ts', 1), match('a.ts', 2)], { truncated: true })))
    expect(html).toContain('Showing the first 2 matches')
  })

  it('offers Keep searching after a timeout, once, and not after the longer budget', () => {
    const short = render(answeredText('foo', grepResponse([match('a.ts', 1)], { timedOut: true })))
    expect(short).toContain('Timed out after 1 s')
    expect(short).toContain('Keep searching')
    const long = render(answeredText('foo', grepResponse([match('a.ts', 1)], { timedOut: true }), EXTENDED_TEXT_TIMEOUT_MS))
    expect(long).toContain('Timed out after 10 s')
    expect(long).not.toContain('Keep searching')
  })

  it('does not call a timed-out search with no rows "No matches"', () => {
    const html = render(answeredText('foo', grepResponse([], { timedOut: true })))
    expect(html).toContain('Timed out after 1 s')
    expect(html).not.toContain('No matches')
  })

  it('says the index is still building for text search', () => {
    const html = render(answeredText('foo', grepResponse([match('a.ts', 1)], { indexing: true, source: 'walk' })))
    expect(html).toContain('Index still building — press Enter to search again')
  })

  it('explains an invalid pattern that was searched literally, with the daemon message', () => {
    const html = render(answeredText('a(', grepResponse([match('a.ts', 1)], { regexError: "fatal: command line, 'a(': Unmatched ( or \\(" })))
    expect(html).toContain('Invalid pattern, searched literally')
    expect(html).toContain('Unmatched ( or')
  })

  it('explains that regular expressions need a Git repository', () => {
    const html = render(answeredText('a+', grepResponse([], { source: 'walk', regexError: 'Regular expressions need a Git repository' })))
    expect(html).toContain('Regular expressions need a Git repository. Searched literally.')
    expect(html).not.toContain('Invalid pattern')
  })

  it('warns about ignore rules only for git-missing and git-too-old', () => {
    const notes = (fallbackReason: FileSearchResponse['fallbackReason'], source: 'git' | 'walk' = 'walk') =>
      render(answeredFiles('a', filesResponse([file('a.ts')], { source, fallbackReason })))
    expect(notes('git-missing')).toContain('Git not found: ignore rules not applied')
    expect(notes('git-too-old')).toContain('Git 2.19 or newer is needed for ignore rules')
    for (const quiet of [notes('not-a-repo'), notes(undefined, 'git'), notes(undefined, 'walk')]) {
      expect(quiet).not.toContain('ignore rules')
    }
    const text = render(answeredText('a', grepResponse([match('a.ts', 1)], { source: 'walk', fallbackReason: 'git-missing' })))
    expect(text).toContain('Git not found: ignore rules not applied')
  })

  it('mentions skipped long lines', () => {
    expect(render(answeredText('a', grepResponse([match('a.ts', 1)], { skippedLongLines: 1 })))).toContain('1 very long line was skipped')
    expect(render(answeredText('a', grepResponse([match('a.ts', 1)], { skippedLongLines: 3 })))).toContain('3 very long lines were skipped')
  })

  it('says a project is needed', () => {
    const html = render(reduce(createFilesSearchState('files', SCOPE), { type: 'needs-project' }))
    expect(html).toContain('Search needs a project')
  })

  it('shows the daemon error verbatim', () => {
    const asked = reduce(createFilesSearchState('text', SCOPE), { type: 'request-started', request: 1, key: 'k' })
    const html = render(reduce(asked, { type: 'error', request: 1, scopeKey: SCOPE, message: 'Task workspace is not ready & recovery is required' }))
    expect(html).toContain('Task workspace is not ready &amp; recovery is required')
    expect(html).toContain('files-search-note error')
  })

  it('dims the rows of an earlier query while the box is ahead of them', () => {
    const typing = reduce(answeredFiles('a', filesResponse([file('a.ts')])), { type: 'query', query: 'ab' })
    expect(render(typing)).toContain('files-search-results scrollbar-ultra-thin stale')
    expect(render(answeredFiles('a', filesResponse([file('a.ts')])))).not.toContain('stale')
  })

  it('offers both modes and pressed state', () => {
    const html = render(createFilesSearchState('text', SCOPE))
    expect(html).toMatch(/aria-pressed="false"[^>]*>Files</)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Text</)
  })
})

describe('the search box is only a background highlight', () => {
  const css = readFileSync(new URL('../src/renderer/components/filesPanel.css', import.meta.url), 'utf8')

  it('styles a selected row with a background, never a border or inset bar', () => {
    const rule = /\.files-search-row\.selected\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('background')
    expect(rule).not.toMatch(/border|box-shadow|outline/)
    const block = css.slice(css.indexOf('.files-search-host'))
    expect(block).not.toMatch(/box-shadow:\s*inset/)
  })
})
