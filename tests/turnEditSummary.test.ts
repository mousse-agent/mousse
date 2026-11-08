import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UIMessage } from 'ai'
import { TurnEditSummary } from '../src/renderer/chat/components/agent-elements/turn-edit-summary'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import { openTurnInChanges } from '../src/renderer/components/changes/openChanges'
import { useAppStore } from '../src/renderer/stores/appStore'
import { useChangesStore } from '../src/renderer/stores/changesStore'
import { setTurnChangedFiles } from '../src/renderer/lib/turnChangedFilesSetting'
import type { ChatMessage } from '../src/shared/types'
import type { ActivityFileChange } from '../src/shared/agentActivity'

const editMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'tool-Edit', toolCallId: 'c1', state: 'output-available', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }]
} as unknown as UIMessage

function editOf(path: string, id = path) {
  return { type: 'tool-Edit', toolCallId: id, state: 'output-available', input: { file_path: path, old_string: 'a', new_string: 'b' } }
}

describe('turn edit summary', () => {
  afterEach(() => setTurnChangedFiles('summary'))

  it('lists each changed file by name, with its folder', () => {
    setTurnChangedFiles('list')
    const markup = renderToStaticMarkup(createElement(TurnEditSummary, {
      messages: [{ id: 'a2', role: 'assistant', parts: [editOf('src/lib/app.ts'), editOf('README.md')] } as unknown as UIMessage]
    }))
    expect(markup).toContain('aria-label="Review src/lib/app.ts"')
    expect(markup).toContain('<span class="turn-edits-file-name">app.ts</span><span class="turn-edits-file-folder">src/lib</span>')
    // A file at the top level has no folder.
    expect(markup).toContain('<span class="turn-edits-file-name">README.md</span><span class="turn-edits-stat">')
    expect(markup).not.toContain('Project root')
  })

  it('counts every file of typed and raw edits once, sums their lines and leaves out failed edits', () => {
    setTurnChangedFiles('list')
    const typed = (id: string, changes: ActivityFileChange[], status: 'done' | 'failed' = 'done'): ChatMessage => ({
      id, role: 'system', kind: 'mcp_tool_call', content: '', timestamp: '2026-01-01T00:00:00.000Z',
      toolCall: { title: 'edit', summary: 'edit', details: [], status: 'complete' },
      activity: { id, callId: id, toolName: 'edit', startedAt: '2026-01-01T00:00:00.000Z', status, kind: 'file_change', changes }
    })
    const messages = [
      ...mousseToUIMessages([
        // Two edits of one file count once, with both edits' lines.
        typed('e1', [{ path: 'src/a.ts', change: 'update', added: 1, removed: 1 }]),
        typed('e2', [{ path: 'src/a.ts', change: 'update', added: 2, removed: 0 }]),
        // A failed edit changed nothing.
        typed('e3', [{ path: 'src/broken.ts', change: 'update', error: 'old text not found' }], 'failed'),
        // A write whose counts come from its diff.
        typed('w1', [{ path: 'src/new.ts', change: 'add', diff: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n' }]),
        // One call that changed three files, one of whose changes failed.
        typed('m1', [
          { path: 'src/x.ts', change: 'update', added: 1, removed: 1 },
          { path: 'src/y.ts', change: 'update', added: 4, removed: 2 },
          { path: 'src/z.ts', change: 'update', error: 'file changed on disk' }
        ])
      ]),
      // A raw edit from an older transcript, and a raw edit of a file a typed edit also changed.
      { id: 'raw', role: 'assistant', parts: [editOf('src/old.ts'), editOf('src/x.ts', 'raw-x')] } as unknown as UIMessage
    ]
    const markup = renderToStaticMarkup(createElement(TurnEditSummary, { messages }))
    const listed = [...markup.matchAll(/aria-label="Review ([^"]+)"/g)].map((match) => match[1])
    expect(listed).toEqual(['src/a.ts', 'src/new.ts', 'src/x.ts', 'src/y.ts', 'src/old.ts'])
    expect(markup).toContain('5 files changed')
    // a 3/1 + new 3/0 + x 2/2 + y 4/2 + old 1/1
    expect(markup).toContain('<span class="turn-edits-add">+13</span><span class="turn-edits-del">−6</span>')
  })

  it('offers to review the turn instead of opening the Git diff', () => {
    const markup = renderToStaticMarkup(createElement(TurnEditSummary, { messages: [editMessage], turnId: 'run:thread:t1:ordinal:1' }))
    expect(markup).toContain('1 file changed')
    expect(markup).toContain('>Review</button>')
    expect(markup).not.toContain('Open diff')
  })

  it('renders without a turn id, for a transcript from before turns were recorded', () => {
    expect(renderToStaticMarkup(createElement(TurnEditSummary, { messages: [editMessage] }))).toContain('>Review</button>')
  })

  it('carries the turn id from a chat message to the user message the row reads it from', () => {
    const [user] = mousseToUIMessages([{ id: 'u1', role: 'user', content: 'go', timestamp: new Date().toISOString(), turnId: 'run:thread:t1:ordinal:1' } as ChatMessage])
    expect((user as unknown as { turnId?: string }).turnId).toBe('run:thread:t1:ordinal:1')
    const [legacy] = mousseToUIMessages([{ id: 'u2', role: 'user', content: 'go', timestamp: new Date().toISOString() } as ChatMessage])
    expect(legacy).not.toHaveProperty('turnId')
  })
})

describe('opening a turn in the Changes tab', () => {
  const getStatus = vi.fn()
  const ownWorktree = {
    metadata: { lifecycle: 'ready' },
    execution: { lifecycle: 'ready', workspacePath: '/wt/t1', primaryPath: '/repo' }
  }

  beforeEach(() => {
    getStatus.mockReset()
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, mousse: { workspace: { getStatus } } })
    useChangesStore.setState({ byThread: {} })
    useAppStore.setState({ mainView: 'browser', openedSurfaceKinds: [], mainAreaOpen: false })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the turn in the Changes tab', async () => {
    getStatus.mockResolvedValue(ownWorktree)
    await openTurnInChanges('t1', 'run:thread:t1:ordinal:3')
    expect(useChangesStore.getState().byThread.t1.requested).toBe('turn:run:thread:t1:ordinal:3')
    expect(useAppStore.getState()).toMatchObject({ mainView: 'git', mainAreaOpen: true, openedSurfaceKinds: ['git'] })
  })

  it('opens the turn at the clicked file', async () => {
    getStatus.mockResolvedValue(ownWorktree)
    await openTurnInChanges('t1', 'run:thread:t1:ordinal:3', '/wt/t1/src/app.ts')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({
      requested: 'turn:run:thread:t1:ordinal:3',
      pendingFile: { path: '/wt/t1/src/app.ts' }
    })
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('falls back to the whole thread when the row has no turn id', async () => {
    getStatus.mockResolvedValue(ownWorktree)
    await openTurnInChanges('t1', undefined)
    expect(useChangesStore.getState().byThread.t1.requested).toBe('thread')
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('opens the Git surface for a thread without a worktree of its own', async () => {
    getStatus.mockResolvedValue({ metadata: null, execution: { lifecycle: 'unprovisioned', workspacePath: '/repo', primaryPath: '/repo' } })
    await openTurnInChanges('t1', 'run:thread:t1:ordinal:3')
    expect(useChangesStore.getState().byThread.t1).toBeUndefined()
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('opens the Git surface when no thread is active', async () => {
    await openTurnInChanges(null, 'run:1')
    expect(getStatus).not.toHaveBeenCalled()
    expect(useAppStore.getState().mainView).toBe('git')
  })
})
