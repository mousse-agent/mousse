/**
 * What a sidebar row shows beside its title, kept in the thread's own metadata at write time so the list never opens a
 * thread's database: the latest reply as one clipped line (written when a turn ends), and the pull requests the thread
 * was linked to (`threadPullRequestsOf`).
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { latestReplyPreview, REPLY_PREVIEW_CHARS, replyPreviewText } from '../src/shared/threadPreview'
import { MAX_THREAD_PULL_REQUESTS, threadPullRequestsOf, withThreadPullRequest, type ThreadPullRequestLink } from '../src/shared/pullRequests'
import type { ChatMessage, Thread } from '../src/shared/types'

describe('a reply as one line', () => {
  it.each([
    ['plain text', 'Fixed the flaky test.', 'Fixed the flaky test.'],
    ['line breaks and runs of spaces', 'Done.\n\nThe   build passes.', 'Done. The build passes.'],
    ['a heading, a list and a quote', '## Summary\n- one\n2. two\n> three', 'Summary one two three'],
    ['bold, strike and inline code', 'Use **`npm test`** not ~~yarn~~', 'Use npm test not yarn'],
    ['a link keeps its text, an image goes', 'See [the PR](https://x.y/1) ![shot](a.png) now', 'See the PR now'],
    ['a code block goes', 'Run this:\n```sh\nrm -rf build\n```\nthen retry', 'Run this: then retry'],
    ['an unclosed code block goes to the end', 'Here:\n```ts\nconst a = 1', 'Here:'],
    ['only a code block', '```\ncode\n```', ''],
    ['snake_case and a single star stay', 'set max_size * 2', 'set max_size * 2']
  ])('%s', (_case, input, expected) => {
    expect(replyPreviewText(input)).toBe(expected)
  })

  it('cuts a long reply at the limit with an ellipsis, never inside a character', () => {
    const preview = replyPreviewText(`${'é'.repeat(REPLY_PREVIEW_CHARS - 2)}😀😀😀 tail`)
    expect([...preview]).toHaveLength(REPLY_PREVIEW_CHARS)
    expect(preview.endsWith('😀…')).toBe(true)
  })
})

describe('the latest reply of a transcript', () => {
  const at = '2026-11-17T10:00:00.000Z'
  const msg = (content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: content || 'x', role: 'assistant', content, timestamp: at, ...over })

  it.each<[string, ChatMessage[], string | undefined]>([
    ['the last reply', [msg('first'), msg('second')], 'second'],
    ['a plan reply counts', [msg('first'), msg('the plan', { kind: 'plan_card' })], 'the plan'],
    ['tool calls, notes and markers are skipped', [msg('the answer'), msg('ls', { kind: 'tool_call' }), msg('Compacted', { kind: 'context_compaction' }), msg('slow', { kind: 'warning' })], 'the answer'],
    ['a hidden or copied message is skipped', [msg('mine'), msg('internal', { hidden: true }), msg('from the source', { inherited: { threadId: 'src' } })], 'mine'],
    ['the person\'s messages are skipped', [msg('reply'), msg('thanks', { role: 'user' })], 'reply'],
    ['an empty reply and one of code alone are skipped', [msg('words'), msg(''), msg('```\nx\n```')], 'words'],
    ['no reply at all', [msg('hi', { role: 'user' })], undefined]
  ])('%s', (_case, messages, expected) => {
    expect(latestReplyPreview(messages)).toBe(expected)
  })
})

describe('the pull requests a row counts', () => {
  const link = (number: number): ThreadPullRequestLink => ({
    number, url: `https://github.com/acme/app/pull/${number}`, host: 'github.com', nameWithOwner: 'acme/app',
    headRefName: 'f', baseRefName: 'main', headRepository: 'acme/app', isCrossRepository: false, linkedAt: '2026-11-01T00:00:00.000Z'
  })
  const entry = (number: number, over = {}) => ({ number, url: `https://github.com/acme/app/pull/${number}`, nameWithOwner: 'acme/app', ...over })

  it('counts the link of a thread linked before the list was kept, once', () => {
    expect(threadPullRequestsOf({ pullRequest: link(3) })).toEqual([entry(3)])
    expect(threadPullRequestsOf({ pullRequest: link(3), pullRequests: [entry(3, { state: 'open' })] })).toEqual([entry(3, { state: 'open' })])
    expect(threadPullRequestsOf({})).toEqual([])
  })

  it('updates the entry of the same pull request in place, whatever the URL\'s case, and drops a draft mark once a state says otherwise', () => {
    const list = [entry(1, { state: 'open', isDraft: true, title: 'One' }), entry(2)]
    const next = withThreadPullRequest(list, entry(1, { url: 'https://GitHub.com/acme/app/pull/1', state: 'merged' }))
    expect(next).toEqual([{ ...entry(1, { state: 'merged', title: 'One' }), url: 'https://GitHub.com/acme/app/pull/1' }, entry(2)])
  })

  it('keeps the newest when a thread has more than the limit', () => {
    let list = [] as ReturnType<typeof entry>[]
    for (let n = 1; n <= MAX_THREAD_PULL_REQUESTS + 2; n += 1) list = withThreadPullRequest(list, entry(n))
    expect(list).toHaveLength(MAX_THREAD_PULL_REQUESTS)
    expect(list[0].number).toBe(3)
  })
})

describe('a turn that ends keeps its reply on the thread', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let window: LocalMmsClient
  let seen: Array<{ type: string; data?: unknown }>

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-row-summary-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    seen = []
    window = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
    window.onEvent((event) => seen.push(event as { type: string; data?: unknown }))
    await window.connect()
    await window.subscribe()
  }, 30_000)

  afterEach(async () => {
    await window?.close()
    await server?.stop()
    await mms?.stop()
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows can hold a thread database open a moment after stop; the temporary folder is left behind.
    }
    delete process.env.MOUSSE_HOME
  })

  /** The thread's transcript in the service, as a turn leaves it. */
  const transcript = (threadId: string): ChatMessage[] =>
    (mms.orchestrator as unknown as { getOrCreateSession(id: string): { messages: ChatMessage[] } }).getOrCreateSession(threadId).messages
  const listed = async (threadId: string) =>
    (await window.request<{ threads: Thread[] }>('threads.list')).threads.find((thread) => thread.id === threadId)
  const pushedReplies = (threadId: string) => seen
    .filter((event) => event.type === 'threads.updated')
    .map((event) => (event.data as { threads: Thread[] }).threads.find((thread) => thread.id === threadId)?.lastReply)

  it.each(['turn-completed', 'turn-failed', 'turn-interrupted', 'turn-paused'])('after %s, the list a window gets carries the clipped reply, and the thread keeps it on disk', async (event) => {
    const thread = (await window.request<{ thread: Thread }>('threads.create', { name: 'Fix the build' })).thread
    const updatedAt = (await listed(thread.id))!.updatedAt
    transcript(thread.id).push(
      { id: 'u1', role: 'user', content: 'Why does CI fail?', timestamp: updatedAt },
      { id: 'a1', role: 'assistant', content: '**Found it.** The `lint` step\nruns twice.', timestamp: updatedAt },
      { id: 'a2', role: 'assistant', kind: 'tool_call', content: 'npm run lint', timestamp: updatedAt }
    )

    mms.orchestrator.emit(event, { threadId: thread.id })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const row = await listed(thread.id)
    expect(row?.lastReply).toBe('Found it. The lint step runs twice.')
    // Not activity: the row keeps its place.
    expect(row?.updatedAt).toBe(updatedAt)
    expect(pushedReplies(thread.id)).toContain('Found it. The lint step runs twice.')
    const meta = JSON.parse(readFileSync(join(mms.threads.getThreadDir(thread.id), 'meta.json'), 'utf8')) as Thread
    expect(meta.lastReply).toBe('Found it. The lint step runs twice.')
  })

  it('keeps the reply before when a turn ends without one, and sends no list when nothing changed', async () => {
    const thread = (await window.request<{ thread: Thread }>('threads.create', { name: 'Ask' })).thread
    transcript(thread.id).push({ id: 'a1', role: 'assistant', content: 'Earlier answer', timestamp: '' })
    mms.orchestrator.emit('turn-completed', { threadId: thread.id })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pushes = seen.length

    transcript(thread.id).push({ id: 'u2', role: 'user', content: 'and now?', timestamp: '' })
    mms.orchestrator.emit('turn-interrupted', { threadId: thread.id })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect((await listed(thread.id))?.lastReply).toBe('Earlier answer')
    expect(seen.slice(pushes).filter((event) => event.type === 'threads.updated')).toEqual([])
  })
})
