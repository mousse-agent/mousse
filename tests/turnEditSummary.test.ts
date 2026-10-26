import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UIMessage } from 'ai'
import { TurnEditSummary } from '../src/renderer/chat/components/agent-elements/turn-edit-summary'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import { openTurnInReview } from '../src/renderer/components/review/openReview'
import { useAppStore } from '../src/renderer/stores/appStore'
import { useReviewStore } from '../src/renderer/stores/reviewStore'
import type { ChatMessage } from '../src/shared/types'

const editMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'tool-Edit', toolCallId: 'c1', state: 'output-available', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }]
} as unknown as UIMessage

describe('turn edit summary', () => {
  it('offers to review the turn instead of opening the Git diff', () => {
    const markup = renderToStaticMarkup(createElement(TurnEditSummary, { messages: [editMessage], turnId: 'run:thread:t1:ordinal:1' }))
    expect(markup).toContain('1 changed file')
    expect(markup).toContain('Review changes')
    expect(markup).not.toContain('Open diff')
  })

  it('renders without a turn id, for a transcript from before turns were recorded', () => {
    expect(renderToStaticMarkup(createElement(TurnEditSummary, { messages: [editMessage] }))).toContain('Review changes')
  })

  it('carries the turn id from a chat message to the user message the row reads it from', () => {
    const [user] = mousseToUIMessages([{ id: 'u1', role: 'user', content: 'go', timestamp: new Date().toISOString(), turnId: 'run:thread:t1:ordinal:1' } as ChatMessage])
    expect((user as unknown as { turnId?: string }).turnId).toBe('run:thread:t1:ordinal:1')
    const [legacy] = mousseToUIMessages([{ id: 'u2', role: 'user', content: 'go', timestamp: new Date().toISOString() } as ChatMessage])
    expect(legacy).not.toHaveProperty('turnId')
  })
})

describe('opening a turn in Review', () => {
  const getStatus = vi.fn()
  const ownWorktree = {
    metadata: { lifecycle: 'ready' },
    execution: { lifecycle: 'ready', workspacePath: '/wt/t1', primaryPath: '/repo' }
  }

  beforeEach(() => {
    getStatus.mockReset()
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, mousse: { workspace: { getStatus } } })
    useReviewStore.setState({ byThread: {} })
    useAppStore.setState({ mainView: 'browser', openedSurfaceKinds: [], mainAreaOpen: false })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the turn in Review', async () => {
    getStatus.mockResolvedValue(ownWorktree)
    await openTurnInReview('t1', 'run:thread:t1:ordinal:3')
    expect(useReviewStore.getState().byThread.t1.scope).toEqual({ kind: 'turn', turnId: 'run:thread:t1:ordinal:3' })
    expect(useAppStore.getState()).toMatchObject({ mainView: 'review', mainAreaOpen: true, openedSurfaceKinds: ['review'] })
  })

  it('falls back to the whole thread when the row has no turn id', async () => {
    getStatus.mockResolvedValue(ownWorktree)
    await openTurnInReview('t1', undefined)
    expect(useReviewStore.getState().byThread.t1.scope).toEqual({ kind: 'thread' })
    expect(useAppStore.getState().mainView).toBe('review')
  })

  it('opens the Git surface for a thread without a worktree of its own', async () => {
    getStatus.mockResolvedValue({ metadata: null, execution: { lifecycle: 'unprovisioned', workspacePath: '/repo', primaryPath: '/repo' } })
    await openTurnInReview('t1', 'run:thread:t1:ordinal:3')
    expect(useReviewStore.getState().byThread.t1).toBeUndefined()
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('opens the Git surface when no thread is active', async () => {
    await openTurnInReview(null, 'run:1')
    expect(getStatus).not.toHaveBeenCalled()
    expect(useAppStore.getState().mainView).toBe('git')
  })
})
