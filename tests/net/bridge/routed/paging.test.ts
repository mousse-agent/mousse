/**
 * A routed read that does not fit one RPC reply is held by the owner and fetched in pages; a long
 * thread is read as its newest part plus pages of older messages, and images load one at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReplyPages, reassemblePagedReply } from '../../../../src/mms/bridge/routed/pages'
import {
  ROUTED_PAGES_PER_CALLER,
  ROUTED_PAGES_TTL_MS,
  ROUTED_PAGE_BYTES,
  ROUTED_REPLY_MAX_BYTES,
  isRoutedPagedReply,
  type RoutedReply
} from '../../../../src/shared/bridge/routed'
import { newId } from '../../../../src/shared/net'
import { cleanup } from '../hub/fixture'
import { routedOwner } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const MIB = 1024 * 1024
const message = (index: number, content: string, images?: unknown[]) => ({
  id: `m-${index}`,
  role: index % 2 ? ('assistant' as const) : ('user' as const),
  content,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  ...(images ? { images } : {})
})

describe('a reply too large for one RPC reply', () => {
  it('comes back in pages that reassemble to what a window would have been given', async () => {
    const { raw, settled, thread, f, fetchPage } = await routedOwner()
    const t = thread()
    // About 5 MiB of transcript: far over the 63 KiB an RPC reply may carry.
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index, `${index}:`.padEnd(512 * 1024, 'x'))
    )
    f.mms.orchestrator.getOrCreateSession(t.id).messages = messages as never

    const reply = await raw('thread.snapshot', { threadId: t.id })
    expect(isRoutedPagedReply(reply)).toBe(true)
    const paged = (reply as { paged: { id: string; bytes: number; pages: number; sha256: string } })
      .paged
    expect(paged.bytes).toBeGreaterThan(5 * MIB)
    expect(paged.pages).toBe(Math.ceil(paged.bytes / ROUTED_PAGE_BYTES))
    // The reply that names the pages is small; each page fits an RPC reply.
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(ROUTED_REPLY_MAX_BYTES)
    const sample = await fetchPage(paged.id, 0)
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: sample }))).toBeLessThan(
      ROUTED_REPLY_MAX_BYTES
    )

    const whole = await settled(reply)
    expect(whole.ok).toBe(true)
    const snapshot = (whole as { result: { messages: Array<{ id: string; content: string }> } })
      .result
    expect(snapshot.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id))
    expect(snapshot.messages.map((m) => m.content)).toEqual(messages.map((m) => m.content))
  }, 120_000)

  it('is refused rather than returned damaged: a changed page, a missing page and another length are caught', async () => {
    const { raw, thread, f, fetchPage } = await routedOwner()
    const t = thread()
    f.mms.orchestrator.getOrCreateSession(t.id).messages = Array.from({ length: 3 }, (_, index) =>
      message(index, 'y'.repeat(100 * 1024))
    ) as never
    const reply = await raw('thread.snapshot', { threadId: t.id })
    if (!isRoutedPagedReply(reply)) throw new Error('expected a paged reply')
    const { paged } = reply
    const flipped = async (id: string, index: number) => {
      const page = await fetchPage(id, index)
      if (index !== 1) return page
      const bytes = Buffer.from(page.data, 'base64')
      bytes[10] = bytes[10] ^ 0xff
      return { ...page, data: bytes.toString('base64') }
    }
    await expect(reassemblePagedReply(paged, flipped)).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      reassemblePagedReply({ ...paged, bytes: paged.bytes + 1 }, fetchPage)
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      reassemblePagedReply({ ...paged, pages: paged.pages - 1 }, fetchPage)
    ).rejects.toMatchObject({ code: 'bad_request' })
    // Whole, it is fine.
    await expect(reassemblePagedReply(paged, fetchPage)).resolves.toMatchObject({ ok: true })
  }, 120_000)

  it('answers a page the owner no longer holds with a refusal, and keeps no other computer out of its own', async () => {
    const { f, raw, thread, fetchPage } = await routedOwner()
    const t = thread()
    f.mms.orchestrator.getOrCreateSession(t.id).messages = [
      message(0, 'z'.repeat(200 * 1024))
    ] as never
    const reply = await raw('thread.snapshot', { threadId: t.id })
    if (!isRoutedPagedReply(reply)) throw new Error('expected a paged reply')
    // A page that does not exist, and an id that was never issued.
    const past = (await f
      .caller()
      .rpc(
        'routed.page',
        { id: reply.paged.id, index: reply.paged.pages },
        { id: newId('rpc'), deadlineMs: 5000 }
      )) as RoutedReply
    expect(past).toMatchObject({ ok: false, error: { code: 'page_expired' } })
    const unknown = (await f
      .caller()
      .rpc(
        'routed.page',
        { id: 'nothing', index: 0 },
        { id: newId('rpc'), deadlineMs: 5000 }
      )) as RoutedReply
    expect(unknown).toMatchObject({ ok: false, error: { code: 'page_expired' } })
    expect((await fetchPage(reply.paged.id, 0)).index).toBe(0)
    // Extra or missing keys are refused before anything is looked up.
    await expect(
      f
        .caller()
        .rpc(
          'routed.page',
          { id: reply.paged.id, index: 0, extra: 1 },
          { id: newId('rpc'), deadlineMs: 5000 }
        )
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      f.caller().rpc('routed.page', { id: reply.paged.id }, { id: newId('rpc'), deadlineMs: 5000 })
    ).rejects.toMatchObject({ code: 'bad_request' })
  }, 120_000)
})

describe('the owner keeps a few paged results for a minute', () => {
  const clock = {
    t: 1_000_000,
    now() {
      return this.t
    }
  }
  const reply = (size: number): RoutedReply => ({ ok: true, result: 'q'.repeat(size) })

  it('holds four results per computer, pushes out the oldest, and lets each computer fetch only its own', () => {
    clock.t = 1_000_000
    const pages = new ReplyPages(clock)
    const a = 'nod_aaaaaaaaaaaaaaaaaaaaaaaaaa' as never
    const b = 'nod_bbbbbbbbbbbbbbbbbbbbbbbbbb' as never
    const held = Array.from({ length: ROUTED_PAGES_PER_CALLER }, () =>
      pages.hold(a, reply(100_000))
    )
    const other = pages.hold(b, reply(100_000))
    expect(pages.heldCount(a)).toBe(ROUTED_PAGES_PER_CALLER)
    // The fifth result of one computer pushes out its oldest; another computer's is untouched.
    const fifth = pages.hold(a, reply(100_000))
    expect(pages.heldCount(a)).toBe(ROUTED_PAGES_PER_CALLER)
    expect(pages.page(a, held[0].id, 0)).toBeUndefined()
    expect(pages.page(a, held[1].id, 0)).toBeDefined()
    expect(pages.page(a, fifth.id, 0)).toBeDefined()
    expect(pages.page(b, other.id, 0)).toBeDefined()
    // A computer cannot read another's result, even with its id.
    expect(pages.page(b, fifth.id, 0)).toBeUndefined()
    expect(pages.page(a, other.id, 0)).toBeUndefined()
    // Indexes outside the result are not pages.
    expect(pages.page(a, fifth.id, fifth.pages)).toBeUndefined()
    expect(pages.page(a, fifth.id, -1)).toBeUndefined()
  })

  it('keeps a result for a minute, holds 32 MiB per computer at most, and forgets a computer that is gone', () => {
    clock.t = 5_000_000
    const pages = new ReplyPages(clock)
    const a = 'nod_aaaaaaaaaaaaaaaaaaaaaaaaaa' as never
    const first = pages.hold(a, reply(1000))
    clock.t += ROUTED_PAGES_TTL_MS - 1
    expect(pages.page(a, first.id, 0)).toBeDefined()
    clock.t += 1
    expect(pages.page(a, first.id, 0)).toBeUndefined()

    // Three results of 12 MiB: the third pushes out the first to stay within 32 MiB.
    const big = Array.from({ length: 3 }, () => pages.hold(a, reply(12 * MIB)))
    expect(pages.page(a, big[0].id, 0)).toBeUndefined()
    expect(pages.page(a, big[1].id, 0)).toBeDefined()
    expect(pages.page(a, big[2].id, 0)).toBeDefined()
    // One result that alone is over the bound is refused.
    expect(() => pages.hold(a, reply(33 * MIB))).toThrow(
      expect.objectContaining({ code: 'too_large' })
    )

    pages.dropCaller(a)
    expect(pages.heldCount()).toBe(0)
  })
})

describe('a long thread read from another computer', () => {
  it('gives the newest 16 MiB and pages the older messages, 40 MiB in all, in order and whole', async () => {
    const { ok, thread, f } = await routedOwner()
    const t = thread()
    const all = Array.from({ length: 80 }, (_, index) =>
      message(index, `${index}:`.padEnd(512 * 1024, 'x'))
    )
    f.mms.orchestrator.getOrCreateSession(t.id).messages = all as never

    const snapshot = await ok('thread.snapshot', { threadId: t.id })
    const newest = snapshot.messages as Array<{ id: string; content: string }>
    expect(newest.length).toBeGreaterThan(20)
    expect(newest.length).toBeLessThan(40)
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThanOrEqual(16 * MIB)
    // The newest message is the last one; the snapshot says where the older ones begin.
    expect(newest.at(-1)!.id).toBe('m-79')
    expect(snapshot.earlier).toEqual({ before: newest[0].id, count: 80 - newest.length })

    // Walking back page by page gives every older message once, oldest first.
    let before = (snapshot.earlier as { before: string }).before
    const older: Array<{ id: string; content: string }> = []
    let reads = 0
    for (;;) {
      const page = await ok('thread.messages', { threadId: t.id, before })
      reads += 1
      const messages = page.messages as Array<{ id: string; content: string }>
      expect(messages.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(8 * MIB)
      older.unshift(...messages)
      if (!page.earlier) break
      expect(page.earlier.count).toBe(80 - newest.length - older.length)
      before = page.earlier.before
      expect(reads).toBeLessThan(10)
    }
    const everything = [...older, ...newest]
    expect(everything.map((m) => m.id)).toEqual(all.map((m) => m.id))
    expect(everything.map((m) => m.content)).toEqual(all.map((m) => m.content))
  }, 180_000)

  it('refuses a page it cannot give with the reason, and a limit outside what it allows', async () => {
    const { call, thread, f } = await routedOwner()
    const t = thread()
    f.mms.orchestrator.getOrCreateSession(t.id).messages = [
      message(0, 'a'),
      message(1, 'b')
    ] as never
    expect(await call('thread.messages', { threadId: t.id, before: 'nothing' })).toMatchObject({
      ok: false,
      error: { code: 'message_not_found' }
    })
    expect(
      await call('thread.messages', { threadId: t.id, before: 'm-1', limit: 501 })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_params' }
    })
    expect(
      await call('thread.messages', { threadId: 'no-such-thread', before: 'm-1' })
    ).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' }
    })
    // The first message has nothing before it.
    expect(await call('thread.messages', { threadId: t.id, before: 'm-0' })).toEqual({
      ok: true,
      result: { messages: [] }
    })
    expect(await call('thread.messages', { threadId: t.id, before: 'm-1' })).toEqual({
      ok: true,
      result: { messages: [expect.objectContaining({ id: 'm-0' })] }
    })
  }, 120_000)
})

describe('images of a thread read from another computer', () => {
  it('keep their data only for the newest 8 MiB, and an older one comes back from thread.messageImage', async () => {
    const { ok, call, thread, f } = await routedOwner()
    const t = thread()
    const data = (index: number) => `${index}`.padEnd(3 * MIB, 'A')
    f.mms.orchestrator.getOrCreateSession(t.id).messages = Array.from({ length: 4 }, (_, index) =>
      message(index, `with an image ${index}`, [
        { name: `p${index}.png`, mimeType: 'image/png', data: data(index) }
      ])
    ) as never

    const snapshot = await ok('thread.snapshot', { threadId: t.id })
    const images = (
      snapshot.messages as Array<{ images: Array<{ name: string; data?: string }> }>
    ).map((m) => m.images[0])
    // The two newest fit the 8 MiB budget; the two older ones are named but carry no data.
    expect(images.map((image) => image.data !== undefined)).toEqual([false, false, true, true])
    expect(images.map((image) => image.name)).toEqual(['p0.png', 'p1.png', 'p2.png', 'p3.png'])

    const image = await ok('thread.messageImage', { threadId: t.id, messageId: 'm-0', index: 0 })
    expect(image).toEqual({ name: 'p0.png', mimeType: 'image/png', data: data(0) })

    expect(
      await call('thread.messageImage', { threadId: t.id, messageId: 'm-0', index: 1 })
    ).toMatchObject({ ok: false, error: { code: 'image_not_found' } })
    expect(
      await call('thread.messageImage', { threadId: t.id, messageId: 'm-9', index: 0 })
    ).toMatchObject({ ok: false, error: { code: 'image_not_found' } })
    // Exactly one of a message and a queued message is named.
    expect(
      await call('thread.messageImage', {
        threadId: t.id,
        messageId: 'm-0',
        queueItemId: 'q',
        index: 0
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(await call('thread.messageImage', { threadId: t.id, index: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_params' }
    })
  }, 120_000)

  it('keep no data in the queue of a snapshot, and a queued image comes back from thread.messageImage', async () => {
    const { ok, thread, f } = await routedOwner()
    const t = thread()
    const queued = {
      id: 'q-1',
      content: 'later',
      images: [{ name: 'q.png', mimeType: 'image/png', data: 'UVVFVUU=' }],
      enqueuedAt: new Date().toISOString(),
      order: 1,
      intent: 'queue',
      state: 'pending'
    }
    vi.spyOn(f.mms.orchestrator, 'listQueue').mockReturnValue([queued] as never)

    const snapshot = await ok('thread.snapshot', { threadId: t.id })
    expect(snapshot.queue).toEqual([
      expect.objectContaining({ id: 'q-1', images: [{ name: 'q.png', mimeType: 'image/png' }] })
    ])
    expect(
      await ok('thread.messageImage', { threadId: t.id, queueItemId: 'q-1', index: 0 })
    ).toEqual(queued.images[0])
  }, 120_000)
})
