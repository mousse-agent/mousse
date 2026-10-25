/**
 * Live check of the helper tree against the real `codex app-server` (issue #142): the capability
 * probe, `thread/read` and `thread/list` with `ancestorThreadId`, and `turn/interrupt` with an empty
 * turn id, as `CodexProviderService` uses them. It needs no sign-in and no model turn: it runs the
 * process in a throwaway profile, so the user's `~/.codex` (config, sessions, credentials) is never
 * read or written. Runs only with MOUSSE_LIVE_CODEX=1 and MOUSSE_LIVE_CODEX_HOME naming an empty
 * scratch directory (never `~/.codex`). MOUSSE_CODEX_BINARY may name the executable.
 *
 * Spawning real helpers needs a model turn, so a ChatGPT sign-in in the scratch profile (`CODEX_HOME=<dir>
 * codex login`). Then ask Codex, through a Mousse child run, to start two helpers, press Stop while
 * they run, and `thread/list` with the thread as ancestor must show every descendant idle.
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexAppServerClient, CodexRpcError, spawnCodexAppServer } from '../../src/mms/providers/codex/CodexAppServerClient'
import { codexEnvironment, findCodexBinary } from '../../src/mms/providers/codex/CodexProviderService'
import { HelperTree, RpcRefused, ThreadStatuses } from '../../src/mms/providers/codex/helperTree'
import { cliLaunch } from '../../src/mms/providers/cliConfig'

const live = process.env.MOUSSE_LIVE_CODEX === '1'
const scratch = process.env.MOUSSE_LIVE_CODEX_HOME ? resolve(process.env.MOUSSE_LIVE_CODEX_HOME) : ''
const NIL = '00000000-0000-0000-0000-000000000000'

describe.skipIf(!live)('helper tree against the real codex app-server', () => {
  let client: CodexAppServerClient
  const statuses = new ThreadStatuses()
  let tree: HelperTree | undefined

  beforeAll(async () => {
    if (!scratch || scratch === resolve(homedir(), '.codex')) throw new Error('MOUSSE_LIVE_CODEX_HOME must name an empty scratch directory, never ~/.codex')
    mkdirSync(scratch, { recursive: true })
    if (readdirSync(scratch).length > 0) throw new Error('MOUSSE_LIVE_CODEX_HOME must be empty: this check starts from a fresh profile')
    const binary = process.env.MOUSSE_CODEX_BINARY || findCodexBinary()
    const target = cliLaunch(binary)
    if (!target) throw new Error('codex not found')
    const process_ = spawnCodexAppServer({
      binary: target.command,
      ...(target.args.length ? { entryArgs: target.args } : {}),
      args: [],
      env: { ...codexEnvironment(), CODEX_HOME: scratch },
      cwd: scratch
    })
    client = new CodexAppServerClient(process_, { defaultTimeoutMs: 20_000 })
    client.onNotification((notification) => {
      statuses.note(notification)
      tree?.noteWake(notification)
    })
    await client.request('initialize', {
      clientInfo: { name: 'mousse-live', title: 'Mousse live check', version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    client.notify('initialized')
  })
  afterAll(() => client?.close())

  it('the capability probe: exclusive filters are refused, one ancestor filter lists nothing', async () => {
    const refusal = await client.request('thread/list', { parentThreadId: NIL, ancestorThreadId: NIL, limit: 1 }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(CodexRpcError)
    expect((refusal as CodexRpcError).message).toMatch(/mutually exclusive/i)
    const listing = await client.request('thread/list', { ancestorThreadId: NIL, limit: 1, useStateDbOnly: true })
    expect(listing.data).toEqual([])
  })

  it('a thread with no helpers: read shows it idle and rootless, the listing is empty, and two snapshots make a quiescence pair', async () => {
    const started = await client.request('thread/start', { cwd: scratch, approvalPolicy: 'on-request', sandbox: 'read-only' })
    const id = started.thread.id
    const read = ((await client.request('thread/read', { threadId: id })).thread ?? {}) as { id?: string; status?: { type?: string }; parentThreadId?: unknown }
    expect(read.id).toBe(id)
    expect(read.status?.type).toBe('idle')
    expect(read.parentThreadId ?? null).toBeNull()

    tree = new HelperTree(
      id,
      {
        now: () => Date.now(),
        read: async (threadId) => {
          try {
            return (await client.request('thread/read', { threadId })).thread
          } catch (error) {
            throw error instanceof CodexRpcError ? new RpcRefused(error.message) : error
          }
        },
        list: async (ancestorThreadId) => {
          try {
            return (await client.request('thread/list', { ancestorThreadId, limit: 100, useStateDbOnly: true })).data
          } catch (error) {
            throw error instanceof CodexRpcError ? new RpcRefused(error.message) : error
          }
        },
        interrupt: (threadId, turnId) => void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      },
      statuses,
      { running: () => [] }
    )
    const first = await tree.check()
    expect(first.snapshot.members).toEqual([])
    expect(first.snapshot.calm).toBe(true)
    await new Promise((done) => setTimeout(done, 300))
    expect((await tree.check()).quiescent).toBe(true)
  })

  it('an interrupt with an empty turn id on an idle thread is accepted and does nothing', async () => {
    const started = await client.request('thread/start', { cwd: scratch, approvalPolicy: 'on-request', sandbox: 'read-only' })
    await expect(client.request('turn/interrupt', { threadId: started.thread.id, turnId: '' })).resolves.toEqual({})
    expect(((await client.request('thread/read', { threadId: started.thread.id })).thread as { status: { type: string } }).status.type).toBe('idle')
  })
})
