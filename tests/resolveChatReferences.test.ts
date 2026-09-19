import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveChatReference, resolveChatReferences } from '../src/renderer/utils/resolveChatReferences'

const originalWindow = globalThis.window

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

describe('composer reference metadata resolution', () => {
  it('round-trips project and thread references through the typed backend API', async () => {
    const resolve = vi.fn(async (input: { kind: string; projectId?: string; threadId?: string }) => input.kind === 'project'
      ? { id: 'project:p1', kind: 'project', title: 'App', projectId: input.projectId, path: 'D:\\app', metadataPath: 'C:\\profile\\projects.json' }
      : { id: 'thread:t1', kind: 'thread', title: 'Fix', threadId: input.threadId, projectId: 'p1', metadataPath: 'C:\\profile\\threads\\t1\\meta.json' })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { mousse: { chatReferences: { resolve } } }
    })

    const references = await resolveChatReferences([
      { id: 'drag:p1', kind: 'project', title: 'App', projectId: 'p1' },
      { id: 'drag:t1', kind: 'thread', title: 'Fix', threadId: 't1' }
    ])

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(references).toEqual([
      expect.objectContaining({ id: 'project:p1', metadataPath: 'C:\\profile\\projects.json' }),
      expect.objectContaining({ id: 'thread:t1', metadataPath: 'C:\\profile\\threads\\t1\\meta.json' })
    ])
  })

  it('does not call the backend for already self-contained resource kinds', async () => {
    const resolve = vi.fn()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { mousse: { chatReferences: { resolve } } }
    })
    await expect(resolveChatReference({ id: 'file:a', kind: 'file', title: 'a.ts', path: 'src/a.ts' }))
      .resolves.toEqual(expect.objectContaining({ path: 'src/a.ts' }))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('surfaces a deleted backend resource instead of attaching guessed metadata', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { mousse: { chatReferences: { resolve: vi.fn(async () => null) } } }
    })
    await expect(resolveChatReference({ id: 'thread:gone', kind: 'thread', title: 'Gone', threadId: 'gone' }))
      .rejects.toThrow('no longer exists')
  })
})
