import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { findUnstartedThread, isThreadStarted } from '../src/shared/threadTitle'

function thread(
  id: string,
  updatedAt: string,
  patch: Partial<Thread> = {}
): Thread {
  return {
    id,
    name: 'New Chat',
    createdAt: updatedAt,
    updatedAt,
    order: 0,
    ...patch
  }
}

describe('new-chat draft selection', () => {
  it('keeps an empty active draft out of the sidebar', () => {
    expect(isThreadStarted(thread('draft', '2026-09-17T10:00:00.000Z'))).toBe(false)
  })

  it('restores the newest draft in the requested project context', () => {
    const threads = [
      thread('standalone', '2026-09-17T12:00:00.000Z'),
      thread('old-project-draft', '2026-09-17T10:00:00.000Z', { projectId: 'project-a' }),
      thread('new-project-draft', '2026-09-17T11:00:00.000Z', {
        projectId: 'project-a',
        modelOverride: { llmProvider: 'openai', model: 'gpt-test' }
      }),
      thread('started-project-chat', '2026-09-17T13:00:00.000Z', {
        projectId: 'project-a',
        startedAt: '2026-09-17T13:00:00.000Z'
      }),
      thread('other-project-draft', '2026-09-17T14:00:00.000Z', { projectId: 'project-b' })
    ]

    expect(findUnstartedThread(threads, 'project-a')?.id).toBe('new-project-draft')
    expect(findUnstartedThread(threads)?.id).toBe('standalone')
  })

  it('ignores archived drafts', () => {
    expect(findUnstartedThread([
      thread('archived', '2026-09-17T10:00:00.000Z', {
        settledAt: '2026-09-17T11:00:00.000Z'
      })
    ])).toBeUndefined()
  })
})
