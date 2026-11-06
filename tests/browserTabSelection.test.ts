import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { makeBrowserCommandTempRoot, removeBrowserCommandTempRoot } from './fixtures/agent-platform/browser-command-transport/ownedTemp'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeBrowserCommandTempRoot(root)
})

describe('in-app tab selection for an agent', () => {
  it("gives an agent its thread's own tab before a shared one and never another thread's tab", async () => {
    const profileId = '22222222-2222-4222-8222-222222222222'
    const root = makeBrowserCommandTempRoot()
    roots.push(root)
    const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot: join(root, 'browser', 'worker-artifacts') })
    const service = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot: join(root, 'browser', 'worker-artifacts'), artifacts,
      installationBrowserRoot: join(root, 'browser-binaries'), threadExists: () => true })
    await service.setAccess(true)
    const owner = { connectionId: 'conn_1', profileId, profileEpoch: 1 }
    const register = (uiTabId: string, threadId?: string) => service.registerAttachment({ registrationId: randomUUID(), registrationEpoch: 1,
      closureToken: randomBytes(32).toString('base64url'), uiTabId, ...(threadId ? { threadId } : {}) }, owner)
    const registrations = [register('other_thread_tab', 'thread_2'), register('shared_tab'), register('own_tab', 'thread_1')]
    expect(service.selectedTarget('thread_1')).toEqual({ backend: 'electron-attached', uiTabId: 'own_tab' })
    expect(service.selectedTarget('thread_3')).toEqual({ backend: 'electron-attached', uiTabId: 'shared_tab' })
    expect(service.selectedTarget('thread_4')).toBeUndefined()
    for (const registration of registrations) service.unregisterAttachment(registration, owner)
    await service.dispose()
    await artifacts.dispose()
  })
})
