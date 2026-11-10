import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { FIRST_SEND_BINDING_CAPABILITY } from '../src/mms/protocol/types'
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

  describe("a listed chat's first message", () => {
    const gui = () => ({ mms, globalSequence: () => 0, connection: { clientType: 'gui', capabilities: new Set<string>([FIRST_SEND_BINDING_CAPABILITY]) } as never })
    const caller = (connection: Record<string, unknown>) => ({ mms, globalSequence: () => 0, connection: { capabilities: new Set<string>(), ...connection } as never })
    const bridge = (window?: string) => ({ ctx: caller({ clientType: 'bridge', bridgeCaller: { node: 'node-1', user: 'me', maxPermissionMode: 'full' } }), window })
    const refusalOf = async (run: Promise<unknown>): Promise<{ code?: string; message?: string }> => {
      try { await run; return {} } catch (error) { return error as { code?: string; message?: string } }
    }
    const codeOf = async (run: Promise<unknown>): Promise<string | undefined> => {
      try { await run; return undefined } catch (error) { return (error as { code?: string }).code }
    }

    it('is refused from a window unless it is bound, and stays pending across a reload until a message is saved', async () => {
      const { thread } = (await dispatchMethod(gui(), 'threads.create', { name: 'New Chat', started: true, permissionMode: 'ask' })) as { thread: Thread }
      expect(thread.firstSendPending).toBe(true)
      // A retry after a failed selection, or a window that did not bind it: refused, so the window reads the thread again.
      expect(await codeOf(dispatchMethod(gui(), 'orchestrator.send', { threadId: thread.id, content: 'hello' }))).toBe('first_send_unbound')
      // A reload reads the flag from the thread's own files.
      expect(JSON.parse(readFileSync(join(mms.threads.getThreadDir(thread.id), 'meta.json'), 'utf8')).firstSendPending).toBe(true)
      // A plain draft (not made for a send) has none.
      const draft = (await dispatchMethod(gui(), 'threads.create', { name: 'New Chat' })) as { thread: Thread }
      expect(draft.thread.firstSendPending).toBeUndefined()
      // The first message saved: later sends are not first sends.
      mms.threads.saveThreadData(thread.id, { messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: new Date().toISOString() }], agents: [], tasks: [] })
      expect(mms.threads.getThread(thread.id)?.firstSendPending).toBeUndefined()
      expect(await codeOf(dispatchMethod(gui(), 'orchestrator.send', { threadId: thread.id, content: 'again' }))).not.toBe('first_send_unbound')
    })

    it('holds a window on another computer to the same rule, tells an older window to update, and lets the CLI and agents send it', async () => {
      const made = async () => ((await dispatchMethod(gui(), 'threads.create', { name: 'New Chat', started: true, permissionMode: 'ask' })) as { thread: Thread }).thread
      const send = (via: { ctx: ReturnType<typeof caller>; window?: string }, threadId: string) =>
        refusalOf(dispatchMethod(via.ctx, 'orchestrator.send', { threadId, content: 'hello', ...(via.window ? { window: via.window } : {}) }))
      const thread = await made()
      const update = 'Update Mousse to send the first message in this chat.'
      // A window here from before the flag (it did not ask for the capability): told what to do, not to send it again.
      expect(await send({ ctx: caller({ clientType: 'gui' }) }, thread.id)).toMatchObject({ code: 'first_send_unbound', message: update })
      // A window on another computer, as that computer's router marks its send.
      expect(await send(bridge('binds'), thread.id)).toMatchObject({ code: 'first_send_unbound', message: expect.stringContaining('Send it again') })
      expect(await send(bridge('older'), thread.id)).toMatchObject({ code: 'first_send_unbound', message: update })
      expect(await send(bridge('anything'), thread.id)).toMatchObject({ code: 'invalid_params' })
      // Each refusal left the first message to be bound.
      expect(mms.threads.getThread(thread.id)?.firstSendPending).toBe(true)
      // The CLI, and an agent or an older computer over the Bridge (no window mark), may send it unbound.
      expect((await send({ ctx: caller({ clientType: 'cli' }) }, (await made()).id)).code).not.toBe('first_send_unbound')
      expect((await send(bridge(), (await made()).id)).code).not.toBe('first_send_unbound')
    })

    it('bound to Ask is refused after another window switched the chat to Full before it was admitted', async () => {
      const { thread } = (await dispatchMethod(gui(), 'threads.create', { name: 'New Chat', started: true, permissionMode: 'ask' })) as { thread: Thread }
      const shown = { permissionMode: 'ask', settingsRevision: thread.settingsRevision ?? 0 }
      // Another window changes it before this window's first message is admitted.
      await dispatchMethod(gui(), 'threads.setPermissionMode', { threadId: thread.id, mode: 'full' })
      expect(await codeOf(dispatchMethod(gui(), 'orchestrator.send', { threadId: thread.id, content: 'hello', expect: shown }))).toBe('thread_settings_changed')
      expect(mms.threads.getThread(thread.id)?.firstSendPending).toBe(true)
    })
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
