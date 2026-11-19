import { afterEach, expect, it, vi } from 'vitest'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { publicFetch } from '../../src/mms/net-public/publicFetch'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { secretFetchAction } from '../../src/mms/bots/actions/secretFetchAction'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import { appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'

const hooks = vi.hoisted(() => ({
  afterCheck: undefined as undefined | ((path: unknown) => void),
  afterOpen: undefined as undefined | ((path: unknown, fd: number) => void),
  afterClose: undefined as undefined | ((fd: number) => void)
}))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
      const result = original.lstatSync(...args)
      hooks.afterCheck?.(args[0])
      return result
    },
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const fd = original.openSync(...args)
      hooks.afterOpen?.(args[0], fd)
      return fd
    },
    closeSync: (fd: number) => {
      original.closeSync(fd)
      hooks.afterClose?.(fd)
    }
  }
})
vi.mock('../../src/mms/net-public/publicFetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publicFetch: vi.fn()
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  hooks.afterCheck = undefined
  hooks.afterOpen = undefined
  hooks.afterClose = undefined
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
  vi.restoreAllMocks()
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'fetch-file-race-'))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const scratch = join(home, 'scratch'),
    outside = join(home, 'outside')
  mkdirSync(scratch)
  mkdirSync(outside)
  const vault = new SecretVault({ profileRoot: home, threadAlive: () => true })
  vault.store('KEY', 'private-test-value0123456789', {
    threadId: 'owner',
    keep: 'saved',
    binding: resolveSecretBinding({ service: 'openai' })
  })
  const secrets = createSecretToolHost({
    vault,
    requests: new SecretRequests(vault),
    scratchRoot: scratch
  })
  vi.mocked(publicFetch)
    .mockClear()
    .mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.alloc(70000, 'x')
    })
  const input = {
    threadId: 'owner',
    folder: scratch,
    args: { secret: 'KEY', path: '/v1/models' },
    signal: new AbortController().signal
  }
  return { home, scratch, outside, secrets, input, run: () => secrets.fetch!(input) }
}

// Actors and orders: a folder link present initially; a directory swapped after lstat;
// a recorded name replaced by a link; unrecorded names; text/binary bodies; a local save error.
it.each(['text/plain', 'application/octet-stream'])(
  'refuses a folder swap before saving %s, without spending a slot',
  async (type) => {
    const f = fixture(),
      folder = join(f.scratch, 'fetches')
    const originals = Array.from({ length: 30 }, (_, i) => String(i))
    originals.forEach((name) => writeFileSync(join(f.outside, name), 'owner file'))
    vi.mocked(publicFetch).mockResolvedValue({
      status: 200,
      headers: { 'content-type': type },
      body: Buffer.alloc(70000, 'x')
    })
    hooks.afterCheck = (path) => {
      if (path !== folder) return
      hooks.afterCheck = undefined
      renameSync(folder, folder + '-original')
      symlinkSync(f.outside, folder, 'dir')
    }
    const store = new BotStore({ profileHome: f.home })
    cleanup.push(() => store.close())
    const tool = secretTools({
      ...fakeAppToolHost().host,
      secrets: () => f.secrets,
      botHomeOf: () => 'owner'
    }).find((t) => t.name === 'secret_fetch')!
    const turn = appTurn({
      threadId: 'owner',
      runId: 'run',
      bot: {
        appTools: new Set(['secret_fetch']),
        role: 'activation',
        workspace: { scratch: f.scratch },
        secretFetch: (
          request: Parameters<typeof secretFetchAction>[1],
          send: Parameters<typeof secretFetchAction>[2]
        ) => secretFetchAction(store, { ...request, botId: 'owner', activationId: 'a' }, send)
      } as never
    })
    const result = await tool.handler(f.input.args, {
      turn,
      transport: 'in_process',
      toolCallId: 'race',
      signal: f.input.signal
    } as ToolCallContext)
    expect.soft(result.isError).toBe(true)
    expect.soft(result.text).toMatch(/folder.*(?:changed|unavailable)/i)
    expect.soft(readdirSync(f.outside).sort()).toEqual(originals.sort())
    for (const name of originals)
      expect(readFileSync(join(f.outside, name), 'utf8')).toBe('owner file')
    expect.soft(readdirSync(folder + '-original')).toEqual([])
    expect(store.get('SELECT status, ran_at FROM bot_actions')).toMatchObject({
      status: 'failed',
      ran_at: null
    })
  }
)

it('prunes only recorded names and never follows a replacement link', async () => {
  const f = fixture(),
    folder = join(f.scratch, 'fetches')
  const first = await f.run(),
    file = first.text.split('File: ')[1]!
  const victim = join(f.outside, 'keep')
  writeFileSync(victim, 'owner file')
  unlinkSync(file)
  symlinkSync(victim, file)
  writeFileSync(join(folder, 'unrecorded'), 'bot file')
  for (let i = 0; i < 20; i++) expect((await f.run()).isError).not.toBe(true)
  expect(readFileSync(victim, 'utf8')).toBe('owner file')
  expect(readFileSync(join(folder, 'unrecorded'), 'utf8')).toBe('bot file')
  expect(readdirSync(folder)).not.toContain(basename(file))
  expect(readdirSync(folder)).toHaveLength(21)
})

it('describes a local save failure without calling it a connection failure', async () => {
  const f = fixture()
  writeFileSync(join(f.scratch, 'fetches'), 'not a directory')
  const out = await f.run()
  expect(out.isError).toBe(true)
  expect(out.text).toContain('request was not sent')
  expect(out.text).not.toContain('could not be reached')
})

it('checks the opened file before writing and removes it while it is still empty on a folder move', async () => {
  const f = fixture(),
    folder = join(f.scratch, 'fetches')
  hooks.afterOpen = (path) => {
    if (!String(path).startsWith('/proc/self/fd/')) return
    hooks.afterOpen = undefined
    renameSync(folder, folder + '-original')
    symlinkSync(f.outside, folder, 'dir')
  }
  const result = await f.run()
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/folder.*(?:changed|unavailable)/i)
  expect(readdirSync(f.outside)).toEqual([])
  expect(readdirSync(folder + '-original')).toEqual([])
})

it('keeps a close failure local and releases the parent handle', async () => {
  const f = fixture(),
    opened = new Set<number>()
  hooks.afterOpen = (path, fd) => {
    if (path === join(f.scratch, 'fetches') || String(path).startsWith('/proc/self/fd/'))
      opened.add(fd)
  }
  hooks.afterClose = (fd) => {
    if (!opened.has(fd)) return
    if (opened.size < 2) {
      opened.delete(fd)
      return
    }
    opened.delete(fd)
    hooks.afterClose = (next) => {
      opened.delete(next)
    }
    throw new Error('private close diagnostic')
  }
  cleanup.push(() => {
    for (const fd of opened) {
      try {
        closeSync(fd)
      } catch {
        /* The old implementation leaked this parent. */
      }
    }
  })
  const result = await f.run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain('could not be saved on this computer')
  expect(result.text).not.toContain('private close diagnostic')
  expect(opened.size).toBe(0)
})

it('counts a sent request even when its file disappears before verification', async () => {
  const f = fixture(),
    store = new BotStore({ profileHome: f.home })
  cleanup.push(() => store.close())
  hooks.afterOpen = (path) => {
    if (!String(path).startsWith('/proc/self/fd/')) return
    hooks.afterOpen = undefined
    unlinkSync(String(path))
  }
  const prepared = f.secrets.prepareFetch!(f.input)
  expect(prepared.refusal).toBeUndefined()
  const result = await secretFetchAction(
    store,
    {
      botId: 'owner',
      activationId: 'a',
      callKey: 'removed',
      secret: 'KEY',
      service: 'OpenAI',
      args: {},
      mask: (text) => text
    },
    (uncount) => prepared.send!(uncount)
  )
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/folder.*(?:changed|unavailable)/i)
  expect(store.get('SELECT ran_at FROM bot_actions')?.ran_at).not.toBeNull()
  expect(result.text).toContain('request was sent')
  expect(readdirSync(join(f.scratch, 'fetches'))).toEqual([])
})

async function countedRead(f: ReturnType<typeof fixture>, store: BotStore, n: number) {
  const prepared = f.secrets.prepareFetch!(f.input)
  return secretFetchAction(
    store,
    {
      botId: 'owner',
      activationId: 'a',
      callKey: `cap-${n}`,
      secret: 'KEY',
      service: 'OpenAI',
      args: {},
      mask: (text) => text
    },
    (uncount) => prepared.send!(uncount)
  )
}
it('refuses a persistent linked folder before sending and leaves no counted request', async () => {
  const f = fixture(),
    store = new BotStore({ profileHome: f.home })
  cleanup.push(() => store.close())
  symlinkSync(f.outside, join(f.scratch, 'fetches'), 'dir')
  for (let i = 0; i < 21; i++) expect((await countedRead(f, store, i)).isError).toBe(true)
  expect(publicFetch).not.toHaveBeenCalled()
  expect(store.get('SELECT count(*) AS n FROM bot_actions WHERE ran_at IS NOT NULL')?.n).toBe(0)
})
it('counts all sent requests when a linked folder prevents saving, then refuses call 21', async () => {
  const f = fixture(),
    store = new BotStore({ profileHome: f.home })
  cleanup.push(() => store.close())
  const folder = join(f.scratch, 'fetches')
  vi.mocked(publicFetch).mockImplementation(async () => {
    rmSync(folder, { recursive: true, force: true })
    symlinkSync(f.outside, folder, 'dir')
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(70000) }
  })
  for (let i = 0; i < 20; i++) {
    rmSync(folder, { recursive: true, force: true })
    const out = await countedRead(f, store, i)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('request was sent')
  }
  const last = await countedRead(f, store, 20)
  expect(last.text).toContain('20 times this hour')
  expect(publicFetch).toHaveBeenCalledTimes(20)
  expect(store.get('SELECT count(*) AS n FROM bot_actions WHERE ran_at IS NOT NULL')?.n).toBe(20)
})
it('pins the directory opened just before replacement by a link', async () => {
  const f = fixture(),
    folder = join(f.scratch, 'fetches')
  hooks.afterOpen = (path) => {
    if (path !== folder) return
    hooks.afterOpen = undefined
    renameSync(folder, folder + '-original')
    symlinkSync(f.outside, folder, 'dir')
  }
  expect((await f.run()).isError).toBe(true)
  expect(readdirSync(f.outside)).toEqual([])
})

it.each([
  [
    'reject after writing',
    Object.assign(new Error('socket write completed'), { code: 'ECONNRESET' })
  ],
  ['timeout', new Error('The request took more than 30 seconds.')],
  ['oversize response', new Error('The response exceeds 5 MiB.')]
])('keeps sent %s failures counted through the hourly cap', async (_kind, error) => {
  const f = fixture(),
    store = new BotStore({ profileHome: f.home })
  cleanup.push(() => store.close())
  vi.mocked(publicFetch).mockRejectedValue(error)
  for (let i = 0; i < 20; i++) {
    expect((await countedRead(f, store, i)).isError).toBe(true)
    expect(
      store.get('SELECT ran_at FROM bot_actions WHERE call_key = ?', `cap-${i}`)?.ran_at
    ).not.toBeNull()
  }
  const capped = await countedRead(f, store, 20)
  expect(capped.text).toContain('20 times this hour')
  expect(capped.text).toContain('try again later')
  expect(publicFetch).toHaveBeenCalledTimes(20)
  expect(store.get('SELECT count(*) AS n FROM bot_actions WHERE ran_at IS NOT NULL')?.n).toBe(20)
})
