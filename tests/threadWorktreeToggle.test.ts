/**
 * Worktree toggle: threads.create flag + threads.setWorktreeEnabled round-trip
 * through the local protocol stack (daemon side of the Electron IPC chain).
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import type { Thread } from '../src/shared/types'

describe('thread worktree toggle', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let gui: GuiMmsController

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-worktree-toggle-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'daemon'
    })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    mms.getOwnerLease()?.setEndpoint(endpoint)
    gui = new GuiMmsController({
      homeDir: home,
      disableAutoStart: true,
      endpointOverride: endpoint,
      ownerTokenOverride: ownerToken
    })
    await gui.start()
  })

  afterEach(async () => {
    await gui.stop()
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('creates threads worktree-off by default and toggles via protocol', async () => {
    const created = await gui.request<{ thread: Thread }>('threads.create', {
      name: 'Toggle Test'
    })
    expect(created.thread.worktreeEnabled).toBeFalsy()

    const enabled = await gui.request<{ thread: Thread }>(
      'threads.setWorktreeEnabled',
      { threadId: created.thread.id, enabled: true }
    )
    expect(enabled.thread.worktreeEnabled).toBe(true)

    const fetched = await gui.request<{ thread: Thread }>('threads.get', {
      threadId: created.thread.id
    })
    expect(fetched.thread.worktreeEnabled).toBe(true)

    const disabled = await gui.request<{ thread: Thread }>(
      'threads.setWorktreeEnabled',
      { threadId: created.thread.id, enabled: false }
    )
    expect(disabled.thread.worktreeEnabled).toBeFalsy()
  })

  it('accepts worktreeEnabled at creation time', async () => {
    const created = await gui.request<{ thread: Thread }>('threads.create', {
      name: 'Pre-enabled',
      worktreeEnabled: true
    })
    expect(created.thread.worktreeEnabled).toBe(true)
  })

  it('toggles a custom-named thread with zero messages (startedAt backfill must not lock it)', async () => {
    const created = await gui.request<{ thread: Thread }>('threads.create', {
      name: 'My Custom Feature'
    })
    // Listing backfills startedAt for named threads; the toggle must still work.
    mms.threads.listAllThreads()
    const enabled = await gui.request<{ thread: Thread }>(
      'threads.setWorktreeEnabled',
      { threadId: created.thread.id, enabled: true }
    )
    expect(enabled.thread.worktreeEnabled).toBe(true)
  })

  it('refuses toggling once the thread has a real message', async () => {
    const thread = mms.threads.createThread('Started')
    mms.threads.mutateThreadData(thread.id, (current) => ({
      messages: [
        ...current.messages,
        {
          id: 'user-1',
          role: 'user',
          content: 'hello',
          timestamp: new Date().toISOString()
        }
      ]
    }))

    expect(() => mms.threads.setThreadWorktreeEnabled(thread.id, true)).toThrow(
      /before the first message/
    )
    await expect(
      gui.request('threads.setWorktreeEnabled', { threadId: thread.id, enabled: true })
    ).rejects.toThrow(/before the first message/)
  })
})
