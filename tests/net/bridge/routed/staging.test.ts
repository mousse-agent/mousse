/**
 * Large values are sent ahead of the call that uses them: uploaded as a request artifact of
 * `routed.stage`, held in the blob store within limits, and named in `stagedValues`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateRoutedParams } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { ROUTED_METHODS, ROUTED_STAGE_TTL_MS } from '../../../../src/shared/bridge/routed'
import { newId } from '../../../../src/shared/net'
import { cleanup } from '../hub/fixture'
import { repo, routedOwner, testClock } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const KIB = 1024
const stageId = (reply: Awaited<ReturnType<Awaited<ReturnType<typeof routedOwner>>['stage']>>) => {
  if (!reply.ok) throw new Error(`stage refused: ${reply.error.code}`)
  return (reply.result as { stage: string }).stage
}

describe('routed.stage', () => {
  it('holds an uploaded value for the call that names it, which puts it back before it checks the call', async () => {
    const { f, ok, thread, stage, staging } = await routedOwner({ staging: {} })
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('Saved', project.id, path)
    // A value far over what a request may carry inline.
    const content = `${'line of a long file\n'.repeat(10_000)}`
    expect(Buffer.byteLength(content)).toBeGreaterThan(190 * KIB)

    const reply = await stage(content)
    expect(reply).toMatchObject({ ok: true, result: { bytes: expect.any(Number) } })
    const id = stageId(reply)
    expect(id).toMatch(/^stg_[0-9a-f]{32}$/)
    expect(staging!.count()).toBe(1)

    const saved = await ok('files.write', {
      threadId: t.id,
      path: 'big.txt',
      stagedValues: { content: id }
    })
    expect(saved).toMatchObject({ path: 'big.txt', receiptId: expect.any(String) })
    // The thread's own folder holds it (a thread with a worktree has its own copy of the project).
    expect((await ok('files.read', { threadId: t.id, path: 'big.txt' })).content).toBe(content)
    // A successful call uses the value up, and the bytes it came in are no longer referenced.
    expect(staging!.count()).toBe(0)
    const again = await f
      .caller()
      .rpc(
        'routed.files.write',
        { threadId: t.id, path: 'again.txt', stagedValues: { content: id } },
        { id: newId('rpc'), idem: 'again', deadlineMs: 20_000 }
      )
    expect(again).toMatchObject({ ok: false, error: { code: 'stage_not_found' } })
  }, 120_000)

  it('stages images and a message for a send, which reaches the handler as an inline call would', async () => {
    const { f, ok, thread, stage } = await routedOwner({ staging: {} })
    const t = thread()
    const send = vi
      .spyOn(f.mms.orchestrator, 'send')
      .mockResolvedValue({ message: '', actions: [], runId: 'run-1', accepted: true } as never)
    const images = [{ name: 'shot.png', mimeType: 'image/png', data: 'QUJD'.repeat(40_000) }]
    const text = 'a long message '.repeat(8000)
    const imagesId = stageId(await stage(images))
    const contentId = stageId(await stage(text))

    await ok('orchestrator.send', {
      threadId: t.id,
      clientRequestId: 'req-staged',
      stagedValues: { content: contentId, images: imagesId }
    })
    expect(send).toHaveBeenCalledTimes(1)
    const input = send.mock.calls[0][0] as { content: string; images: unknown[] }
    expect(input.content).toBe(text)
    expect(input.images).toEqual(images)
  }, 120_000)

  it('keeps a staged value when the call that named it was refused, so it can be tried again', async () => {
    const { call, thread, stage, staging } = await routedOwner({ staging: {} })
    const id = stageId(await stage('kept for the second try'))
    const refused = await call('files.write', {
      threadId: 'no-such-thread',
      path: 'x.txt',
      stagedValues: { content: id }
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    expect(staging!.count()).toBe(1)
    // A value that was never staged is a refusal that says so, not a crash.
    const missing = await call('files.write', {
      threadId: thread().id,
      path: 'x.txt',
      stagedValues: { content: `stg_${'0'.repeat(32)}` }
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'stage_not_found' } })
  }, 120_000)

  it('refuses a value past its limits as a result, and frees room as values are used or expire', async () => {
    const clock = testClock()
    // One value 300 KiB at most, 500 KiB per computer, 700 KiB in all.
    const { f, stage, staging } = await routedOwner({
      clock,
      staging: { item: 300 * KIB, caller: 500 * KIB, total: 700 * KIB }
    })
    const of = (kib: number) => 'v'.repeat(kib * KIB - 2)
    expect(await stage(of(400))).toMatchObject({ ok: false, error: { code: 'stage_too_large' } })
    expect(staging!.count()).toBe(0)

    const first = stageId(await stage(of(250)))
    expect(staging!.used()).toBeGreaterThan(249 * KIB)
    expect(await stage(of(260))).toMatchObject({ ok: false, error: { code: 'stage_full' } })
    // A refused upload leaves nothing held.
    expect(staging!.count()).toBe(1)

    // Held for an hour from when it was staged, and not a moment longer.
    clock.advance(ROUTED_STAGE_TTL_MS - 1000)
    expect(staging!.resolve(f.callerNode, [first]).size).toBe(1)
    clock.advance(2000)
    expect(staging!.sweep()).toBe(1)
    expect(staging!.count()).toBe(0)
    expect(() => staging!.resolve(f.callerNode, [first])).toThrow(
      expect.objectContaining({ code: 'stage_not_found' })
    )
    // Room again.
    expect(await stage(of(250))).toMatchObject({ ok: true })
  }, 120_000)

  it('holds no more than the total across computers, whoever staged it', async () => {
    const { f, stage, staging } = await routedOwner({
      staging: { item: 400 * KIB, caller: 10 * 1024 * KIB, total: 600 * KIB }
    })
    const of = (kib: number) => 'w'.repeat(kib * KIB - 2)
    // Another computer already holds 350 KiB of the total.
    f.targetDb.database
      .prepare('INSERT INTO routed_stage VALUES(?,?,?,?,?,?,?)')
      .run('stg_' + 'a'.repeat(32), newId('node'), 'strm', 'evnt', 'blb_x', 350 * KIB, Date.now())
    expect(staging!.used()).toBe(350 * KIB)
    expect(await stage(of(300))).toMatchObject({ ok: false, error: { code: 'stage_full' } })
    expect(await stage(of(200))).toMatchObject({ ok: true })
  }, 120_000)

  it('keeps the uploaded bytes in the blob store while the value is held and lets them go when it is used', async () => {
    const { f, upload, staging } = await routedOwner({ staging: {} })
    const { id, ref } = await upload(Buffer.from(JSON.stringify('held in the blob store')))
    const reply = (await f
      .caller()
      .rpc('routed.stage', { input: ref }, { id, idem: `stage-${id}`, deadlineMs: 20_000 })) as {
      ok: true
      result: { stage: string }
    }
    expect(f.targetBlobs.has(ref.blob)).toBe(true)
    expect(f.targetBlobs.isReferenced(ref.blob, ref.stream)).toBe(true)
    staging!.consume([reply.result.stage])
    expect(staging!.count()).toBe(0)
    expect(f.targetBlobs.isReferenced(ref.blob, ref.stream)).toBe(false)
  }, 120_000)

  it('lets one call use a staged value at a time, and gives it back to a call that did not use it', async () => {
    const { f, ok, call, thread, stage, staging } = await routedOwner({ staging: {} })
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('Saved', project.id, path)
    const id = stageId(await stage('same text, sent once'))

    // Two calls name the same value at once: one uses it, the other is told it is in use.
    const [first, second] = await Promise.all([
      call('files.write', { threadId: t.id, path: 'one.txt', stagedValues: { content: id } }),
      call('files.write', { threadId: t.id, path: 'two.txt', stagedValues: { content: id } })
    ])
    const replies = [first, second]
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1)
    const refused = replies.find((reply) => !reply.ok)!
    expect(refused).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(stage_in_use|stage_not_found)$/) }
    })
    expect(staging!.count()).toBe(0)

    // A call that is refused before it uses the value gives it back, and the next call can use it.
    const again = stageId(await stage('second value'))
    expect(
      await call('files.write', {
        threadId: 'nothing',
        path: 'x.txt',
        stagedValues: { content: again }
      })
    ).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    expect(staging!.count()).toBe(1)
    expect(
      await ok('files.write', {
        threadId: t.id,
        path: 'three.txt',
        stagedValues: { content: again }
      })
    ).toMatchObject({ path: 'three.txt' })
    expect(staging!.count()).toBe(0)
  }, 120_000)

  it('refuses a claim on a value that is in use, without reading it again', async () => {
    const { f, stage, staging } = await routedOwner({ staging: {} })
    const id = stageId(await stage('big'))
    const held = staging!.resolve(f.callerNode, [id])
    expect(held.get(id)!.toString()).toBe('"big"')
    expect(() => staging!.resolve(f.callerNode, [id])).toThrow(
      expect.objectContaining({ code: 'stage_in_use' })
    )
    staging!.release([id])
    expect(staging!.resolve(f.callerNode, [id]).size).toBe(1)
  }, 120_000)

  it('looks for expired values when it starts and on a timer, not only when someone stages again', async () => {
    const clock = testClock()
    const { f, stage, staging } = await routedOwner({ clock, staging: { sweepMs: 20 } })
    stageId(await stage('one'))
    stageId(await stage('two'))
    expect(staging!.count()).toBe(2)
    // At start: values left from before are dropped once they are older than their hour.
    clock.advance(ROUTED_STAGE_TTL_MS + 1000)
    const stop = staging!.start()
    expect(staging!.count()).toBe(0)
    // On a timer: a value that expires later goes without any call.
    stageId(await stage('three'))
    expect(staging!.count()).toBe(1)
    clock.advance(ROUTED_STAGE_TTL_MS + 1000)
    await vi.waitFor(() => expect(staging!.count()).toBe(0), { timeout: 5000 })
    stop()
    void f
  }, 120_000)

  it('keeps a staged value over 512 KiB for files.write out, as the save limit does for an inline one', async () => {
    const { f, call, thread, stage, staging } = await routedOwner({ staging: {} })
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('Saved', project.id, path)
    // The save limit is the handler's (raised for routed saves by a later change); staging does not get around it.
    const id = stageId(await stage('y'.repeat(600 * KIB)))
    expect(
      await call('files.write', { threadId: t.id, path: 'big.txt', stagedValues: { content: id } })
    ).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(staging!.count()).toBe(1)
  }, 120_000)

  it('drops what a device has staged or is waiting to fetch when it is blocked here', async () => {
    const { f, stage, staging, thread, raw, routes, policy } = await routedOwner({ staging: {} })
    stageId(await stage('staged before the block'))
    const t = thread()
    f.mms.orchestrator.getOrCreateSession(t.id).messages = [
      {
        id: 'm-0',
        role: 'user',
        content: 'z'.repeat(200 * KIB),
        timestamp: new Date().toISOString()
      }
    ] as never
    expect(await raw('thread.snapshot', { threadId: t.id })).toMatchObject({
      paged: expect.any(Object)
    })
    expect(staging!.count(f.callerNode)).toBe(1)
    expect(routes.pages.heldCount(f.callerNode)).toBe(1)

    policy.set(f.callerNode, { blocked: true })
    expect(staging!.count(f.callerNode)).toBe(0)
    expect(routes.pages.heldCount(f.callerNode)).toBe(0)
    // Closing the routes ends the watch: a later block changes nothing here.
    routes.close()
    policy.set(f.callerNode, { blocked: false })
  }, 120_000)

  it("never gives one computer another's value, and drops what a computer staged when it goes", async () => {
    const { f, stage, staging, call, thread } = await routedOwner({ staging: {} })
    const mine = stageId(await stage('mine'))
    const other = newId('node')
    const theirs = 'stg_' + 'b'.repeat(32)
    f.targetDb.database
      .prepare('INSERT INTO routed_stage VALUES(?,?,?,?,?,?,?)')
      .run(theirs, other, 'strm', 'evnt', 'blb_x', 10, Date.now())
    expect(
      await call('files.write', {
        threadId: thread().id,
        path: 'x',
        stagedValues: { content: theirs }
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'stage_not_found' }
    })
    expect(() => staging!.resolve(other, [mine])).toThrow(
      expect.objectContaining({ code: 'stage_not_found' })
    )
    staging!.dropCaller(f.callerNode)
    expect(staging!.count(f.callerNode)).toBe(0)
    expect(staging!.count(other)).toBe(1)
  }, 120_000)
})

describe('the staged key of a call', () => {
  const row = ROUTED_METHODS['files.write']
  const base = { threadId: 't', path: 'a.txt' }
  const id = 'stg_' + 'c'.repeat(32)

  it('stands for a required value, and for no value the row does not name', () => {
    expect(() =>
      validateRoutedParams('files.write', row, { ...base, stagedValues: { content: id } })
    ).not.toThrow()
    // Staged and inline at once, or a value the row cannot stage, or something that is not an id.
    for (const bad of [
      { ...base, content: 'x', stagedValues: { content: id } },
      { ...base, stagedValues: { path: id } },
      { ...base, stagedValues: { threadId: id, content: id } },
      { ...base, stagedValues: { content: 'stg_short' } },
      { ...base, stagedValues: { content: 7 } },
      { ...base, stagedValues: {} },
      { ...base, stagedValues: [id] },
      { ...base, stagedValues: id }
    ])
      expect(() => validateRoutedParams('files.write', row, bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'bad_request' })
      )
    // A row that stages nothing does not take the key at all.
    expect(() =>
      validateRoutedParams('threads.rename', ROUTED_METHODS['threads.rename'], {
        threadId: 't',
        name: 'n',
        stagedValues: { name: id }
      })
    ).toThrow(expect.objectContaining({ code: 'bad_request' }))
    // The value is still required: neither inline nor staged is refused.
    expect(() => validateRoutedParams('files.write', row, base)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it('is refused over the wire when the owner offers no staging', async () => {
    const { call, thread } = await routedOwner()
    expect(
      await call('files.write', { threadId: thread().id, path: 'x', stagedValues: { content: id } })
    ).toMatchObject({ ok: false, error: { code: 'stage_unavailable' } })
  }, 120_000)
})
