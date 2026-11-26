/**
 * Show in sidebar (`threads.setHidden`): the owner brings back a thread one of their bots keeps out of the sidebar
 * (`Thread.hidden`), through the protocol a window uses, and a person's message in it does the same. The bot's own `thread_hide` is in botThreadsDaemon.test.ts; the
 * sidebar and the bot chat's list are in the renderer tests.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import type { Thread } from '../src/shared/types'

describe('showing a hidden thread in the sidebar (threads.setHidden)', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let gui: LocalMmsClient

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-thread-hidden-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    gui = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    await gui.connect()
  })

  afterEach(async () => {
    await gui.close()
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('clears the mark on disk and in the reply, hides again only a thread a bot or an agent started, and keeps its place in the list', async () => {
    const started = mms.threads.createThread('Quick check', undefined, undefined, { started: true, startedByBot: { botId: 'b1', name: 'Alpha' }, hidden: true })
    const owners = mms.threads.createThread('My own work', undefined, undefined, { started: true })
    expect(mms.threads.threadOnDisk(started.id)?.hidden).toBe(true)

    const shown = await gui.request<{ thread: Thread; threads: Thread[] }>('threads.setHidden', { threadId: started.id, hidden: false })
    expect(shown.thread.hidden).toBeUndefined()
    expect(shown.threads.find((thread) => thread.id === started.id)?.hidden).toBeUndefined()
    expect(mms.threads.threadOnDisk(started.id)?.hidden).toBeUndefined()
    // Showing or hiding is not activity: the thread keeps its time, so it does not jump to the top.
    expect(mms.threads.getThread(started.id)!.updatedAt).toBe(started.updatedAt)

    const hidden = await gui.request<{ thread: Thread }>('threads.setHidden', { threadId: started.id, hidden: true })
    expect(hidden.thread.hidden).toBe(true)
    expect(mms.threads.threadOnDisk(started.id)?.hidden).toBe(true)

    // A thread an agent started is listed by the thread that started it, here or on another computer: it can be hidden.
    const launched = mms.threads.createThread('Background check', undefined, undefined, { started: true, createdByThreadId: owners.id })
    const fromAfar = mms.threads.createThread('Linux tests', undefined, undefined, { started: true })
    mms.threads.updateThreadMeta(fromAfar.id, { startedFrom: { node: 'n1', agent: { thread: 'far', title: 'Yo', mode: 'auto' } } }, { touch: false })
    for (const id of [launched.id, fromAfar.id]) expect((await gui.request<{ thread: Thread }>('threads.setHidden', { threadId: id, hidden: true })).thread.hidden).toBe(true)

    // The owner's own thread has nothing else to list it, so it is never hidden.
    await expect(gui.request('threads.setHidden', { threadId: owners.id, hidden: true })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(mms.threads.getThread(owners.id)!.hidden).toBeUndefined()
    await expect(gui.request('threads.setHidden', { threadId: 'missing', hidden: false })).rejects.toMatchObject({ code: 'thread_not_found' })
  })

  it('shows a hidden thread once a person writes in it from a window; a script\'s message leaves it hidden', async () => {
    const started = mms.threads.createThread('Quick check', undefined, undefined, { started: true, startedByBot: { botId: 'b1', name: 'Alpha' }, hidden: true })
    const cli = new LocalMmsClient({ homeDir: home, ownerToken: mms.getOwnerLease()!.owner.token, endpoint: server.endpoint!, clientType: 'cli' })
    await cli.connect()
    try {
      // Whether the turn itself runs (no model is set up here) is not what this checks.
      await cli.request('orchestrator.send', { threadId: started.id, content: 'From a script.' }).catch(() => undefined)
      expect(mms.threads.getThread(started.id)!.hidden).toBe(true)
    } finally {
      await cli.close()
    }

    await gui.request('orchestrator.send', { threadId: started.id, content: 'I will take it from here.' }).catch(() => undefined)
    expect(mms.threads.getThread(started.id)!.hidden).toBeUndefined()
    expect(mms.threads.threadOnDisk(started.id)?.hidden).toBeUndefined()
  })
})
