import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { isThreadStarted } from '../src/shared/threadTitle'
import type { Thread } from '../src/shared/types'

describe('threads.create for a message being sent', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-create-started-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('lists the new chat at once with started, and keeps a plain draft unlisted', async () => {
    const ctx = { mms, globalSequence: () => 0 }
    const sent = (await dispatchMethod(ctx, 'threads.create', { name: 'New Chat', started: true })) as { thread: Thread; threads: Thread[] }
    const draft = (await dispatchMethod(ctx, 'threads.create', { name: 'New Chat' })) as { thread: Thread; threads: Thread[] }

    expect(sent.thread.startedAt).toBeTruthy()
    expect(isThreadStarted(draft.threads.find((thread) => thread.id === sent.thread.id)!)).toBe(true)
    expect(draft.thread.startedAt).toBeUndefined()
    expect(isThreadStarted(draft.threads.find((thread) => thread.id === draft.thread.id)!)).toBe(false)
    await expect(dispatchMethod(ctx, 'threads.create', { name: 'New Chat', started: 'yes' })).rejects.toThrow()
  })

  it('makes a listed chat with the chosen permission mode in the same call, or makes nothing', async () => {
    const ctx = { mms, globalSequence: () => 0 }
    const before = mms.threads.listAllThreads().length
    await expect(dispatchMethod(ctx, 'threads.create', { name: 'New Chat', started: true, permissionMode: 'not-a-mode' })).rejects.toThrow()
    expect(mms.threads.listAllThreads()).toHaveLength(before)

    const { thread } = (await dispatchMethod(ctx, 'threads.create', { name: 'New Chat', started: true, permissionMode: 'ask' })) as { thread: Thread }
    // Even if every call after this fails, the thread a retry sends on is listed and already has the chosen mode.
    const stored = mms.threads.getThread(thread.id)!
    expect(isThreadStarted(stored)).toBe(true)
    expect(stored.permissionMode).toBe('ask')
  })
})
