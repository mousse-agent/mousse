import { describe, expect, it } from 'vitest'
import { ChatReferenceMetadataResolver } from '../src/mms/data/resolveChatReferenceMetadata'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'

describe('ChatReferenceMetadataResolver', () => {
  it('uses the authoritative thread directory and active profile registry', () => {
    const threads = {
      getThread: (id: string) => id === 't1' ? { id, name: 'Thread', projectId: 'p1' } : undefined,
      getThreadDir: (id: string) => `C:\\profile-a\\thread-data\\repositories\\p1\\${id}`
    }
    const projects = {
      getProject: (id: string) => id === 'p1' ? { id, name: 'Project', path: 'D:\\code\\project' } : undefined
    }
    const resolver = new ChatReferenceMetadataResolver(threads as never, projects as never, 'C:\\profile-a')

    expect(resolver.resolve({ kind: 'thread', title: 'Thread', threadId: 't1' })).toEqual(expect.objectContaining({
      metadataPath: 'C:\\profile-a\\thread-data\\repositories\\p1\\t1\\meta.json'
    }))
    expect(resolver.resolve({ kind: 'project', title: 'Project', projectId: 'p1' })).toEqual(expect.objectContaining({
      path: 'D:\\code\\project', metadataPath: 'C:\\profile-a\\projects.json'
    }))
    expect(resolver.resolve({ kind: 'thread', title: 'Missing', threadId: 'missing' })).toBeNull()
  })

  it('is exposed by the validated protocol handler with the bound profile home', async () => {
    const threads = {
      getThread: (id: string) => id === 't1' ? { id, name: 'Thread', projectId: 'p1' } : undefined,
      getThreadDir: (id: string) => `C:\\bound-profile\\threads\\${id}`
    }
    const projects = {
      getProject: (id: string) => id === 'p1' ? { id, name: 'Project', path: 'D:\\project' } : undefined
    }
    const result = await dispatchMethod({
      mms: { threads, projects, getProfileHomeDir: () => 'C:\\bound-profile' } as never,
      globalSequence: () => 0
    }, 'chatReferences.resolve', {
      reference: { id: 'drag:t1', kind: 'thread', title: 'Thread', threadId: 't1' }
    }) as { reference: { metadataPath: string } }

    expect(PROTOCOL_METHODS).toContain('chatReferences.resolve')
    expect(result.reference.metadataPath).toBe('C:\\bound-profile\\threads\\t1\\meta.json')
  })

  it('rejects non-project/thread payloads at the protocol boundary', async () => {
    await expect(dispatchMethod({
      mms: {} as never,
      globalSequence: () => 0
    }, 'chatReferences.resolve', {
      reference: { id: 'file:a', kind: 'file', title: 'a', path: 'a' }
    })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
