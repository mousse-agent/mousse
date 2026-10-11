import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { useAppStore } from '../src/renderer/stores/appStore'
import { openProjectReference } from '../src/renderer/utils/chatLinks'

const original = { id: 'original', projectId: 'project-a' } as Thread
const referenced = { id: 'referenced', projectId: 'project-b' } as Thread

function setup() {
  const api = {
    projects: { listThreads: vi.fn(async () => [] as Thread[]) },
    threads: {
      create: vi.fn(async () => referenced),
      select: vi.fn(async () => {})
    }
  }
  vi.stubGlobal('window', { mousse: api })
  return api
}

beforeEach(() => {
  useAppStore.setState({ profileId: 'one', activeThreadId: original.id, threads: [original], mainView: 'agents', mainAreaOpen: false, messages: [] })
})

describe('project reference routing', () => {
  it('opens a draft in the referenced project when it has no thread yet', async () => {
    const api = setup()
    await openProjectReference('project-b')
    expect(api.projects.listThreads).toHaveBeenCalledWith('project-b')
    expect(api.threads.create).toHaveBeenCalledWith(undefined, 'project-b')
    expect(api.threads.select).toHaveBeenCalledWith(referenced.id)
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: referenced.id, mainView: 'files', mainAreaOpen: true })
  })

  it('uses a daemon-listed thread that was missing from the renderer cache', async () => {
    const api = setup()
    api.projects.listThreads.mockResolvedValue([referenced])
    await openProjectReference('project-b')
    expect(api.threads.create).not.toHaveBeenCalled()
    expect(useAppStore.getState().threads).toContainEqual(referenced)
    expect(useAppStore.getState().activeThreadId).toBe(referenced.id)
  })

  it('uses the cached project thread without creating or listing another draft', async () => {
    const api = setup()
    useAppStore.setState({ threads: [original, referenced] })
    await openProjectReference('project-b')
    expect(api.projects.listThreads).not.toHaveBeenCalled()
    expect(api.threads.create).not.toHaveBeenCalled()
    expect(api.threads.select).toHaveBeenCalledWith(referenced.id)
  })

  it('does not activate a created draft after the profile changes', async () => {
    const api = setup()
    api.threads.create.mockImplementation(async () => {
      useAppStore.setState({ profileId: 'two', threads: [] })
      return referenced
    })
    await openProjectReference('project-b')
    expect(api.threads.select).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ profileId: 'two', threads: [], mainView: 'agents', mainAreaOpen: false })
  })

  it('does not create or navigate after the user switches threads during the lookup', async () => {
    const api = setup()
    api.projects.listThreads.mockImplementation(async () => {
      useAppStore.setState({ activeThreadId: 'elsewhere' })
      return []
    })
    await openProjectReference('project-b')
    expect(api.threads.create).not.toHaveBeenCalled()
    expect(api.threads.select).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 'elsewhere', mainView: 'agents', mainAreaOpen: false })
  })
})
