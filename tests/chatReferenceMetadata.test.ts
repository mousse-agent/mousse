import { describe, expect, it } from 'vitest'
import { ChatReferenceMetadataResolver } from '../src/mms/data/ChatReferenceMetadata'

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
})
