import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatReferenceMetadataResolver } from '../src/mms/data/resolveChatReferenceMetadata'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { resolveChatReference, resolveChatReferences } from '../src/renderer/utils/chatLinks'

const originalWindow = globalThis.window

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

describe('ChatReferenceMetadataResolver', () => {
  it('uses the authoritative thread directory and active profile registry', () => {
    const profileHome = join(tmpdir(), 'profile-a')
    const projectPath = join(tmpdir(), 'project')
    const threads = {
      getThread: (id: string) => id === 't1' ? { id, name: 'Thread', projectId: 'p1' } : undefined,
      getThreadDir: (id: string) => join(profileHome, 'thread-data', 'repositories', 'p1', id)
    }
    const projects = {
      getProject: (id: string) => id === 'p1' ? { id, name: 'Project', path: projectPath } : undefined
    }
    const resolver = new ChatReferenceMetadataResolver(threads as never, projects as never, profileHome)

    expect(resolver.resolve({ kind: 'thread', title: 'Thread', threadId: 't1' })).toEqual(expect.objectContaining({
      metadataPath: join(profileHome, 'thread-data', 'repositories', 'p1', 't1', 'meta.json')
    }))
    expect(resolver.resolve({ kind: 'project', title: 'Project', projectId: 'p1' })).toEqual(expect.objectContaining({
      path: projectPath, metadataPath: join(profileHome, 'projects.json')
    }))
    expect(resolver.resolve({ kind: 'thread', title: 'Missing', threadId: 'missing' })).toBeNull()
  })

  it('is exposed by the validated protocol handler with the bound profile home', async () => {
    const profileHome = join(tmpdir(), 'bound-profile')
    const threads = {
      getThread: (id: string) => id === 't1' ? { id, name: 'Thread', projectId: 'p1' } : undefined,
      getThreadDir: (id: string) => join(profileHome, 'threads', id)
    }
    const projects = {
      getProject: (id: string) => id === 'p1' ? { id, name: 'Project', path: 'D:\\project' } : undefined
    }
    const result = await dispatchMethod({
      mms: { threads, projects, getProfileHomeDir: () => profileHome } as never,
      globalSequence: () => 0
    }, 'chatReferences.resolve', {
      reference: { id: 'drag:t1', kind: 'thread', title: 'Thread', threadId: 't1' }
    }) as { reference: { metadataPath: string } }

    expect(PROTOCOL_METHODS).toContain('chatReferences.resolve')
    expect(result.reference.metadataPath).toBe(join(profileHome, 'threads', 't1', 'meta.json'))
  })

  it('rejects non-project/thread payloads at the protocol boundary', async () => {
    await expect(dispatchMethod({
      mms: {} as never,
      globalSequence: () => 0
    }, 'chatReferences.resolve', {
      reference: { id: 'file:a', kind: 'file', title: 'a', path: 'a' }
    })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('round-trips project and thread references from backend to composer', async () => {
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

  it('keeps self-contained references local and surfaces deleted resources', async () => {
    const resolve = vi.fn(async () => null)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { mousse: { chatReferences: { resolve } } }
    })
    await expect(resolveChatReference({ id: 'file:a', kind: 'file', title: 'a.ts', path: 'src/a.ts' }))
      .resolves.toEqual(expect.objectContaining({ path: 'src/a.ts' }))
    expect(resolve).not.toHaveBeenCalled()
    await expect(resolveChatReference({ id: 'thread:gone', kind: 'thread', title: 'Gone', threadId: 'gone' }))
      .rejects.toThrow('no longer exists')
  })
})
