/**
 * Terminals over Bridge, on the computer that runs the thread: where a shell starts, numbered input, the
 * limit, what ends a device's terminals, the audit and the output stream. The terminal switch and the
 * owner's switch are checked where they live, over a real session (`terminalsBridge.test.ts`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorkspaceManager } from '../../../../src/mms/workspace/ThreadWorkspaceManager'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import {
  TERMINAL_INPUT_BURST_BYTES,
  TERMINAL_INPUT_BURST_CALLS
} from '../../../../src/mms/bridge/routed/terminals'
import {
  ROUTED_TERMINALS_PER_NODE,
  type RoutedStreamOpened
} from '../../../../src/shared/bridge/routed'
import { PROJECT_SHELL_AGENT_ID } from '../../../../src/shared/types'
import { newId } from '../../../../src/shared/net'
import { cleanup, resources } from '../hub/fixture'
import { burst, fakeShells, type Spawned } from './terminalFixture'
import { readStream, repo, routedOwner, testClock } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

type Owner = Awaited<ReturnType<typeof routedOwner>>

/** A thread with a folder of its own on the owner. */
function folderThread(o: Owner) {
  const path = repo()
  const project = o.f.mms.projects.openProject(path)
  const t = o.thread('Terminal thread', project.id, path)
  return { t, project, path }
}

const agentId = `${PROJECT_SHELL_AGENT_ID}:tab-1`
const create = (o: Owner, threadId: string, extra: Record<string, unknown> = {}) =>
  o.call('pty.create', { threadId, agentId, ...extra })

/** The folder the owner's own window would start a terminal for the thread in. */
function threadFolder(o: Owner, threadId: string, projectPath: string): string {
  const manager = new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(threadId))
  const stored = manager.load()
  return manager.executionContext(projectPath, stored ?? undefined).projectPath
}

async function opened(o: Owner) {
  const spawned = fakeShells(o.f.mms.ptyManager, resources)
  o.policy.set(o.f.callerNode, { terminal: true })
  const { t, path } = folderThread(o)
  const reply = await create(o, t.id)
  if (!reply.ok) throw new Error(`pty.create refused: ${reply.error.code}: ${reply.error.message}`)
  return { spawned, t, path, ptyId: (reply.result as { ptyId: string }).ptyId }
}

/** Another terminal of the device, in a thread of its own (a thread has one terminal at a time: it holds the thread's lease). */
async function another(o: Owner) {
  const { t, path } = folderThread(o)
  const reply = await create(o, t.id)
  if (!reply.ok) throw new Error(`pty.create refused: ${reply.error.code}`)
  return { t, path, ptyId: (reply.result as { ptyId: string }).ptyId }
}

/** Closes a terminal, and waits for it to give its thread's lease back. */
const close = (o: Owner, threadId: string, ptyId: string) => o.call('pty.kill', { threadId, ptyId })

/** A numbered input call; `seq` is the caller's own. */
const type = (o: Owner, threadId: string, ptyId: string, seq: number, data: string) =>
  o.call('pty.write', { threadId, ptyId, seq, data })

describe('where a routed terminal starts', () => {
  it('starts in the thread’s own folder, in the owner’s shell and environment', async () => {
    const o = await routedOwner()
    const { spawned, t, path } = await opened(o)
    expect(spawned).toHaveLength(1)
    const [shell] = spawned
    expect(resolve(shell.options.cwd)).toBe(resolve(threadFolder(o, t.id, path)))
    // The owner's own default shell, and its own environment: nothing the caller sent is in it.
    expect(shell.shell).toBe(
      process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'
    )
    expect(Object.keys(shell.options.env).every((key) => key in process.env)).toBe(true)
    expect(Object.keys(process.env).every((key) => key in shell.options.env)).toBe(true)
    expect(shell.args.some((arg) => arg.includes('&&'))).toBe(false)
  }, 180_000)

  it('refuses a shell, arguments, a variable or a project path the caller names, before anything starts', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const { t } = folderThread(o)
    for (const extra of [
      { command: 'rm -rf ~' },
      { env: { LD_PRELOAD: '/tmp/x' } },
      { shellArgs: ['-c', 'x'] },
      { projectPath: '/' },
      { source: 'bot' },
      { cwd: '.' }
    ])
      await expect(
        create(o, t.id, extra),
        JSON.stringify(Object.keys(extra))
      ).rejects.toMatchObject({ code: 'bad_request' })
    // A project shell only, like the ones the panel opens.
    await expect(o.call('pty.create', { threadId: t.id, agentId: 'agent-7' })).rejects.toMatchObject({
      code: 'bad_request'
    })
    expect(spawned).toHaveLength(0)
  }, 180_000)

  it('takes no folder from the caller at all, inside the thread’s folder or outside it', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const { t, path } = folderThread(o)
    for (const cwd of ['.', 'sub', '..', '../..', path, 'C:\\Windows', '\\\\host\\share', 'x\0y'])
      await expect(create(o, t.id, { cwd }), JSON.stringify(cwd)).rejects.toMatchObject({
        code: 'bad_request'
      })
    expect(spawned).toHaveLength(0)
    // The terminal that does start is in the thread's own folder.
    const reply = await create(o, t.id)
    expect(reply.ok).toBe(true)
    expect(resolve(spawned[0].options.cwd)).toBe(resolve(threadFolder(o, t.id, path)))
  }, 180_000)

  it('starts a thread with no folder in its own terminal workspace, and takes no folder of the caller for it', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const t = o.thread('No folder')
    const reply = await create(o, t.id)
    expect(reply.ok).toBe(true)
    const dir = o.f.mms.threads.getThreadDir(t.id)
    expect(realpathSync(spawned[0].options.cwd)).toBe(realpathSync(join(dir, 'terminal-workspace')))
    // And a thread that is not here never starts a shell.
    expect(await create(o, 'no-such-thread')).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' }
    })
    expect(spawned).toHaveLength(1)
  }, 180_000)
})

describe('input and resizes', () => {
  it('reach the terminal that the device opened, and nobody else’s', async () => {
    const o = await routedOwner()
    const { spawned, t, ptyId } = await opened(o)
    expect(await type(o, t.id, ptyId, 1, 'ls\r')).toMatchObject({ ok: true })
    expect(
      await o.call('pty.resize', { threadId: t.id, ptyId, seq: 2, cols: 100, rows: 40 })
    ).toMatchObject({ ok: true })
    expect(spawned[0].pty.written).toEqual(['ls\r'])
    expect(spawned[0].pty.resizes).toEqual([[100, 40]])

    // A terminal the owner's own window opened in a thread the device may reach is readable, but not typed into.
    const second = folderThread(o)
    const own = await dispatchMethod(
      {
        mms: o.f.mms,
        globalSequence: () => 0,
        connection: {
          id: 'window-1',
          clientType: 'gui',
          capabilities: new Set(),
          binding: { profileId: o.f.mms.getProfileId(), epoch: 1 },
          lifetime: new AbortController().signal
        }
      },
      'pty.create',
      { threadId: second.t.id, agentId: `${PROJECT_SHELL_AGENT_ID}:own` }
    )
    const ownId = (own as { ptyId: string }).ptyId
    // Nor read: the device reads only the terminals it opened.
    for (const [method, params] of [
      ['pty.isAlive', {}],
      ['pty.lookup', {}],
      ['pty.scrollback', {}],
      ['pty.outputSince', { afterSequence: 0 }]
    ] as const)
      expect(await o.call(method, { threadId: second.t.id, ptyId: ownId, ...params }), method).toMatchObject({
        ok: false,
        error: { code: 'pty_not_found' }
      })
    expect(
      (await o.ok('pty.list', { threadId: second.t.id })).ptys
    ).toEqual([])
    expect((await o.ok('pty.scrollback', { threadId: second.t.id })).scrollbacks).toEqual({})
    expect(await type(o, second.t.id, ownId, 1, 'sneaky')).toMatchObject({
      ok: false,
      error: { code: 'pty_not_found' }
    })
    expect(await o.call('pty.kill', { threadId: second.t.id, ptyId: ownId })).toMatchObject({
      ok: false,
      error: { code: 'pty_not_found' }
    })
    expect(spawned.at(-1)!.pty.written).toEqual([])
    expect(spawned.at(-1)!.pty.killed).toBe(false)
    // A terminal id of another thread is not this thread's.
    const other = o.thread('Another')
    expect(await type(o, other.id, ptyId, 3, 'x')).toMatchObject({
      ok: false,
      error: { code: 'pty_not_found' }
    })
  }, 180_000)

  it('applies each number once: a resend is answered and not typed again, and an older one is a resend', async () => {
    const o = await routedOwner()
    const { spawned, t, ptyId } = await opened(o)
    const written = () => spawned[0].pty.written
    expect(await type(o, t.id, ptyId, 10, 'a')).toMatchObject({ ok: true, result: { ok: true } })
    expect(await type(o, t.id, ptyId, 11, 'b')).toMatchObject({ ok: true })
    // The reply to 11 was lost, so it is sent again, and later still the caller sends 12.
    expect(await type(o, t.id, ptyId, 11, 'b')).toMatchObject({
      ok: true,
      result: { ok: true, duplicate: true }
    })
    expect(await type(o, t.id, ptyId, 10, 'a')).toMatchObject({ result: { duplicate: true } })
    expect(await type(o, t.id, ptyId, 12, 'c')).toMatchObject({ ok: true })
    expect(written()).toEqual(['a', 'b', 'c'])
    // A resize shares the numbers: it is not applied twice either.
    await o.call('pty.resize', { threadId: t.id, ptyId, seq: 13, cols: 90, rows: 30 })
    await o.call('pty.resize', { threadId: t.id, ptyId, seq: 13, cols: 90, rows: 30 })
    expect(spawned[0].pty.resizes).toEqual([[90, 30]])
  }, 180_000)

  it('keeps no ledger: a numbered call is not a request on disk, and a malformed one is refused', async () => {
    const o = await routedOwner()
    const { t, ptyId } = await opened(o)
    const requests = () =>
      Number(o.f.targetDb.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n)
    const before = requests()
    for (let seq = 1; seq <= 50; seq += 1) await type(o, t.id, ptyId, seq, 'x')
    expect(requests()).toBe(before)
    // No number, a number that is not a whole one, text that is too long, and a size outside the bounds.
    for (const params of [
      { threadId: t.id, ptyId, data: 'x' },
      { threadId: t.id, ptyId, seq: 0, data: 'x' },
      { threadId: t.id, ptyId, seq: 1.5, data: 'x' },
      { threadId: t.id, ptyId, seq: 99, data: 'x'.repeat(16 * 1024 + 1) },
      { threadId: t.id, ptyId, seq: 99, data: 5 }
    ])
      await expect(o.call('pty.write', params as never)).rejects.toMatchObject({
        code: 'bad_request'
      })
    for (const size of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: 257 },
      { cols: 513, rows: 24 },
      { cols: 80 }
    ])
      await expect(
        o.call('pty.resize', { threadId: t.id, ptyId, seq: 99, ...size })
      ).rejects.toMatchObject({ code: 'bad_request' })
    // A call may not carry an idempotency key to a class that keeps none.
    await expect(
      o.f
        .caller()
        .rpc(
          'routed.pty.write',
          { threadId: t.id, ptyId, seq: 777, data: 'x' },
          { id: newId('rpc'), idem: 'k', deadlineMs: 10_000 }
        )
    ).rejects.toMatchObject({ code: 'bad_request' })
  }, 180_000)

  it('holds a device to a steady rate by making input wait, so a paste stays whole and in order', async () => {
    const clock = testClock()
    const o = await routedOwner({ clock })
    const { spawned, t, ptyId } = await opened(o)
    const terminals = o.routes.terminals as unknown as {
      buckets: Map<string, { bytes: number; calls: number; at: number }>
    }
    // The burst is spent and 100 KiB more is owed: this call waits for it, then goes through.
    terminals.buckets.set(o.f.callerNode, { bytes: -100 * 1024, calls: 100, at: clock.now() })
    const chunk = 'x'.repeat(16 * 1024)
    const started = Date.now()
    expect(await type(o, t.id, ptyId, 1, chunk)).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(spawned[0].pty.written).toEqual([chunk])
    // A device that owes far more than any wait is refused, plainly, and nothing of that call is typed.
    terminals.buckets.set(o.f.callerNode, { bytes: -4 * 1024 * 1024, calls: 100, at: clock.now() })
    expect(await type(o, t.id, ptyId, 2, chunk)).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' }
    })
    expect(spawned[0].pty.written).toEqual([chunk])
    // The number after it is the next one: the refused call was not typed and is not waited for.
    terminals.buckets.set(o.f.callerNode, { bytes: 500 * 1024, calls: 100, at: clock.now() })
    expect(await type(o, t.id, ptyId, 3, 'after')).toMatchObject({ ok: true })
    expect(spawned[0].pty.written).toEqual([chunk, 'after'])
  }, 180_000)

  it('puts calls sent together back in order, and waits a moment for the number before a late one', async () => {
    const o = await routedOwner()
    const { spawned, t, ptyId } = await opened(o)
    // Sent at once and in the wrong order: the owner types them in number order.
    const calls = [4, 2, 3, 1].map((seq) => type(o, t.id, ptyId, seq, String(seq) + ";"))
    await Promise.all(calls)
    expect(spawned[0].pty.written).toEqual(['1;', '2;', '3;', '4;'])
    // A number that never comes is waited for only a moment; the call after it is not held for good.
    const started = Date.now()
    expect(await type(o, t.id, ptyId, 9, 'late')).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(spawned[0].pty.written.at(-1)).toBe('late')
    // And the numbers in between are resends now.
    expect(await type(o, t.id, ptyId, 7, 'lost')).toMatchObject({ result: { duplicate: true, lastSeq: 9 } })
  }, 180_000)

  it('says plainly when the shell cannot take the input, and does not record it as unknown', async () => {
    const o = await routedOwner()
    const { spawned, t, ptyId } = await opened(o)
    spawned[0].pty.write = () => {
      throw new Error('EPIPE')
    }
    const reply = await type(o, t.id, ptyId, 1, 'x')
    expect(reply).toMatchObject({ ok: false, error: { code: 'pty_unavailable' } })
    // Fixed words: what the shell said (a path, a system error) stays in the owner's log.
    expect(JSON.stringify(reply)).not.toContain('EPIPE')
  }, 180_000)
})

describe('how many terminals a device may have', () => {
  it('is four, and a closed terminal gives its slot back', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const open: Array<{ t: { id: string }; ptyId: string }> = []
    for (let n = 0; n < ROUTED_TERMINALS_PER_NODE; n += 1) open.push(await another(o))
    const fifth = folderThread(o)
    expect(await create(o, fifth.t.id)).toMatchObject({
      ok: false,
      error: { code: 'terminal_limit' }
    })
    expect(spawned).toHaveLength(ROUTED_TERMINALS_PER_NODE)
    expect(await close(o, open[0].t.id, open[0].ptyId)).toMatchObject({ ok: true })
    expect((await create(o, fifth.t.id)).ok).toBe(true)
  }, 240_000)

  it('cannot be passed by two calls made at once: the slot is taken before the shell starts', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    for (let n = 0; n < ROUTED_TERMINALS_PER_NODE - 1; n += 1) await another(o)
    const [a, b] = [folderThread(o), folderThread(o)]
    const settled = await Promise.all([create(o, a.t.id), create(o, b.t.id)])
    expect(settled.filter((reply) => reply.ok)).toHaveLength(1)
    expect(settled.filter((reply) => !reply.ok)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'terminal_limit' }) })
    ])
    expect(spawned).toHaveLength(ROUTED_TERMINALS_PER_NODE)
  }, 240_000)
})

describe('what ends a device’s terminals', () => {
  const alive = (spawned: Spawned[]) => spawned.filter((s) => !s.pty.killed).length

  it('ends them all when the device’s terminal switch goes off', async () => {
    const o = await routedOwner({ streams: true })
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const { t } = folderThread(o)
    const first = (await create(o, t.id)) as { result: { ptyId: string } }
    await another(o)
    const stream = (await o.ok('stream.open', {
      kind: 'terminal',
      threadId: t.id,
      ptyId: first.result.ptyId
    })) as RoutedStreamOpened
    expect(o.adapter!.privateAccess((stream.descriptor as { id: never }).id)).toMatchObject({
      open: true
    })
    expect(alive(spawned)).toBe(2)

    o.policy.set(o.f.callerNode, { terminal: false })
    expect(alive(spawned)).toBe(0)
    const closes = o.audit.recent(20, o.f.callerNode).filter((row) => row.method === 'pty.close')
    expect(closes).toHaveLength(2)
    expect(closes.every((row) => row.outcome.startsWith('terminal_off'))).toBe(true)
  }, 240_000)

  it('ends them when the device is blocked, and unblocking gives nothing back', async () => {
    const o = await routedOwner()
    const { spawned } = await opened(o)
    await another(o)
    expect(alive(spawned)).toBe(2)
    o.policy.set(o.f.callerNode, { blocked: true })
    expect(alive(spawned)).toBe(0)
    expect(o.audit.recent(20, o.f.callerNode).filter((row) => row.method === 'pty.close')).toEqual([
      expect.objectContaining({ outcome: expect.stringMatching(/^blocked;/) }),
      expect.objectContaining({ outcome: expect.stringMatching(/^blocked;/) })
    ])
    o.policy.set(o.f.callerNode, { blocked: false })
    expect(alive(spawned)).toBe(0)
  }, 240_000)

  it('ends them when the owner’s switch goes off and when the device loses Works on threads', async () => {
    const o = await routedOwner()
    const { spawned } = await opened(o)
    await another(o)
    // A computer that still holds the grant keeps its terminals.
    o.routes.terminals.endExcept('access_lost', () => true)
    expect(alive(spawned)).toBe(2)
    o.routes.terminals.endExcept('access_lost', (node) => node !== o.f.callerNode)
    expect(alive(spawned)).toBe(0)
    await another(o)
    o.routes.terminals.end('setting_off')
    expect(alive(spawned)).toBe(0)
    const reasons = o.audit
      .recent(20, o.f.callerNode)
      .filter((row) => row.method === 'pty.close')
      .map((row) => row.outcome.split(';')[0])
      .sort()
    expect(reasons).toEqual(['access_lost', 'access_lost', 'setting_off'])
  }, 240_000)
})

describe('a window of this computer', () => {
  it('can still type into, resize and stop a terminal of a thread that is being trashed, naming the thread as it does for another computer', async () => {
    const o = await routedOwner()
    const mms = o.f.mms
    const lifecycle = mms.threads.lifecycleStore!
    vi.spyOn(lifecycle, 'get').mockReturnValue({} as never)
    vi.spyOn(mms.threads, 'assertThreadAdmission').mockImplementation(() => {
      throw new Error('This thread is being deleted.')
    })
    const window = (method: string, params: Record<string, unknown>) =>
      dispatchMethod(
        {
          mms,
          globalSequence: () => 0,
          connection: {
            id: 'window-1',
            clientType: 'gui',
            capabilities: new Set(),
            binding: { profileId: mms.getProfileId(), epoch: 1 },
            lifetime: new AbortController().signal
          }
        },
        method,
        params
      )
    await expect(window('pty.write', { ptyId: 'p', data: 'x', threadId: 't' })).resolves.toEqual({ ok: true })
    await expect(window('pty.resize', { ptyId: 'p', cols: 80, rows: 24, threadId: 't' })).resolves.toEqual({
      ok: true
    })
    // Opening a new one on that thread is still refused.
    await expect(window('pty.create', { threadId: 't', agentId })).rejects.toThrow('being deleted')
  }, 120_000)
})

describe('what is audited', () => {
  it('records the first terminal of a device once, each open and kill, and the close with its bytes, but not every key press', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const { t } = folderThread(o)
    const first = (await create(o, t.id)) as { result: { ptyId: string } }
    const ptyId = first.result.ptyId
    await another(o)
    for (let seq = 1; seq <= 30; seq += 1) await type(o, t.id, ptyId, seq, 'k')
    spawned[0].pty.say('hello from the shell')
    await o.call('pty.kill', { threadId: t.id, ptyId })
    spawned[1].pty.exit(0)

    const rows = o.audit.recent(50, o.f.callerNode).reverse()
    expect(rows.map((row) => row.method)).toEqual([
      'pty.create',
      'pty.first_open',
      'pty.create',
      'pty.close',
      'pty.kill',
      'pty.close'
    ])
    expect(rows.find((row) => row.method === 'pty.first_open')).toMatchObject({
      outcome: 'first_terminal',
      kind: 'change',
      thread: t.id
    })
    const closes = rows.filter((row) => row.method === 'pty.close')
    // Closed by the device, with what went in and what came out; the other ended by itself.
    expect(closes[0].outcome).toBe(
      `killed; in 30 B; out ${Buffer.byteLength('hello from the shell')} B`
    )
    expect(closes[1].outcome).toBe('exited; in 0 B; out 0 B')
    // What came out is read volume.
    expect(
      o.audit.reads(o.f.callerNode).reduce((sum, hour) => sum + hour.bytes, 0)
    ).toBeGreaterThanOrEqual(Buffer.byteLength('hello from the shell'))
  }, 240_000)

  it('tells the owner of a device’s first terminal once, not for the next ones', async () => {
    const o = await routedOwner()
    fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    expect(o.audit.has(o.f.callerNode, 'pty.first_open')).toBe(false)
    await another(o)
    await another(o)
    expect(
      o.audit.recent(20, o.f.callerNode).filter((row) => row.method === 'pty.first_open')
    ).toHaveLength(1)
  }, 240_000)
})

describe('a terminal’s output on its own stream', () => {
  it('carries 1 MiB complete and in order, one record per chunk, never merged', async () => {
    const o = await routedOwner({ streams: true })
    const { spawned, t, ptyId } = await opened(o)
    const stream = (await o.ok('stream.open', {
      kind: 'terminal',
      threadId: t.id,
      ptyId
    })) as RoutedStreamOpened
    const chunks = burst(1024 * 1024)
    expect(chunks.length).toBeGreaterThan(20)
    for (const chunk of chunks) spawned[0].pty.say(chunk)
    // The stream stores a burst a few milliseconds after it arrived (and at once when it ends).
    await new Promise((resolve) => setTimeout(resolve, 150))

    const { snapshot, events } = readStream(
      o.f,
      (stream.descriptor as { id: never }).id,
      stream.subject
    )
    expect(snapshot).toMatchObject({ kind: 'mousse.terminal', ptyId, alive: true })
    const data = events.filter((event) => event.type === 'pty.data')
    // The terminal's own numbers, one chunk after another; a chunk larger than a record is in pieces that share its number.
    const bySequence = new Map<number, string[]>()
    for (const event of data) {
      const list = bySequence.get(event.data.sequence) ?? []
      list.push(event.data.data)
      bySequence.set(event.data.sequence, list)
    }
    expect([...bySequence.keys()]).toEqual(chunks.map((_, index) => index + 1))
    chunks.forEach((chunk, index) => expect(bySequence.get(index + 1)!.join('')).toBe(chunk))
    expect(data.map((event) => event.data.data).join('')).toBe(chunks.join(''))
    // Never merged: a chunk of 16 KiB or less is exactly one record.
    for (const [sequence, pieces] of bySequence)
      if (chunks[sequence - 1].length <= 16 * 1024) expect(pieces).toHaveLength(1)
    spawned[0].pty.exit(0)
  }, 240_000)

  it('signs and stores a burst in a few transactions, each chunk still its own record in order', async () => {
    const o = await routedOwner({ streams: true })
    const { spawned, t, ptyId } = await opened(o)
    const stream = (await o.ok('stream.open', {
      kind: 'terminal',
      threadId: t.id,
      ptyId
    })) as RoutedStreamOpened
    const commits = vi.spyOn(o.f.targetDb.database, 'exec')
    const chunks = Array.from({ length: 300 }, (_, index) => `line ${index}
`)
    for (const chunk of chunks) spawned[0].pty.say(chunk)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const committed = commits.mock.calls.filter(([sql]) => sql === 'COMMIT').length
    commits.mockRestore()
    // One transaction a record would be 300; a batch holds up to 32.
    expect(committed).toBeGreaterThan(0)
    expect(committed).toBeLessThan(60)
    const { events } = readStream(o.f, (stream.descriptor as { id: never }).id, stream.subject)
    const data = events.filter((event) => event.type === 'pty.data')
    expect(data.map((event) => event.data.sequence)).toEqual(chunks.map((_, index) => index + 1))
    expect(data.map((event) => event.data.data)).toEqual(chunks)
    // Anything that is not output keeps its place behind the output before it.
    spawned[0].pty.say('last')
    spawned[0].pty.exit(0)
    const after = readStream(o.f, (stream.descriptor as { id: never }).id, stream.subject).events
    expect(after.slice(-2).map((event) => event.type)).toEqual(['pty.data', 'pty.exit'])
    expect(after.at(-2)!.data).toMatchObject({ sequence: 301, data: 'last' })
  }, 240_000)

  it('carries what a real pseudo-terminal printed, 1 MiB of it, exactly as the owner’s own windows heard it', async () => {
    const nodePty = await import('node-pty')
    const o = await routedOwner({ streams: true })
    o.policy.set(o.f.callerNode, { terminal: true })
    // A real process on a real pseudo-terminal: it waits to be typed to, prints 1 MiB in large writes and a marker, and ends.
    const script =
      'process.stdin.once("data", () => { const chunk = "y".repeat(65536); for (let i = 0; i < 16; i++) process.stdout.write(chunk); process.stdout.write("\\nEND\\n", () => process.exit(0)) })'
    ;(o.f.mms.ptyManager as unknown as { spawnPty: unknown }).spawnPty = (
      _shell: string,
      _args: string[],
      options: Record<string, unknown>
    ) => nodePty.spawn(process.execPath, ['-e', script], options as never)
    const heard: Array<{ sequence: number; data: string }> = []
    o.f.mms.ptyManager.on('data', (payload: { sequence: number; data: string }) =>
      heard.push({ sequence: payload.sequence, data: payload.data })
    )
    const exited = new Promise<void>((resolve) => o.f.mms.ptyManager.once('exit', () => resolve()))
    const { t } = folderThread(o)
    const created = await create(o, t.id)
    expect(created.ok).toBe(true)
    const ptyId = (created as { result: { ptyId: string } }).result.ptyId
    // The stream is attached before the process is told to print.
    const stream = (await o.ok('stream.open', { kind: 'terminal', threadId: t.id, ptyId })) as RoutedStreamOpened
    expect(await type(o, t.id, ptyId, 1, 'go\r')).toMatchObject({ ok: true })
    await exited
    await new Promise((resolve) => setTimeout(resolve, 300))
    const all = heard.map((chunk) => chunk.data).join('')
    expect(all.length).toBeGreaterThanOrEqual(1024 * 1024)
    expect(all).toContain('END')

    const { snapshot, events } = readStream(o.f, (stream.descriptor as { id: never }).id, stream.subject)
    const data = events.filter((event) => event.type === 'pty.data')
    // What the shell printed before the stream was attached is the snapshot's scrollback; the rest is records, each chunk
    // once and in order, and together they are everything the owner's own windows heard.
    expect(snapshot.scrollback + data.map((event) => event.data.data as string).join('')).toBe(all)
    // A chunk larger than a record is in pieces that share its number, side by side, so the numbers climb without a step back.
    const numbers = data.map((event) => event.data.sequence as number)
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect([...new Set(numbers)]).toEqual(
      heard.filter((chunk) => chunk.sequence > snapshot.sequence).map((chunk) => chunk.sequence)
    )
    expect(numbers.length).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ type: 'pty.exit' })
  }, 240_000)

  it('can be caught up from a sequence number with pty.outputSince', async () => {
    const o = await routedOwner()
    const { spawned, t, ptyId } = await opened(o)
    const chunks = burst(200 * 1024)
    for (const chunk of chunks) spawned[0].pty.say(chunk)
    const since = await o.ok('pty.outputSince', { threadId: t.id, ptyId, afterSequence: 3 })
    expect(since.gap).toBe(false)
    expect(since.sequence).toBe(chunks.length)
    expect(since.chunks.map((chunk: { sequence: number }) => chunk.sequence)).toEqual(
      chunks.map((_, index) => index + 1).slice(3)
    )
    expect(since.chunks.map((chunk: { data: string }) => chunk.data).join('')).toBe(
      chunks.slice(3).join('')
    )
  }, 240_000)
})
