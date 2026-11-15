import * as fs from 'node:fs'
import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import { WriterEpisode } from '../../src/mms/harness/pi/episode'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) }
})

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const refusal = 'This file changed since you read it. Read it again, then make your change.'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bot-stale-'))
  roots.push(root)
  const files = join(root, 'files')
  const scratch = join(root, 'scratch')
  mkdirSync(files); mkdirSync(scratch)
  const path = join(files, 'todo.md')
  writeFileSync(path, 'one\n')
  const authority = (activationId = 'a', folder = files, state = new Map<string, string>()) => createBotAuthority({
    activationId, role: 'activation', permissions: { tools: ['read', 'edit', 'write', 'shell'], appTools: [], mcp: [], skills: [], workspace: { roots: [], access: 'read', scratch, files: folder } },
    waiting: () => false, counters: new RunCounters(), time: { deadline: () => Infinity, signal: new AbortController().signal }, spend: null,
    fileReads: state
  })
  const engine = new PiRpcEngine({ instanceId: 'pi:x', provider: 'x', label: 'X', capabilities: PI_RPC_CAPS, env: () => ({ env: {} }) } as unknown as PiRpcEngineOptions)
  // In-process transport seam: real gate and authority, hand-authored file executor. No Pi child/model.
  const rpc = engine as unknown as { gate(thread: unknown, request: unknown): Promise<{ allow: boolean; reason?: string; input?: Record<string, unknown> }>; turnEvent(thread: unknown, turn: unknown, event: unknown): void }
  const turn = (bot = authority()) => ({
    bot, attemptToken: 't', phase: 'running', gateRelease: new AbortController(), active: new Set(['read', 'edit', 'write', 'bash']), classes: new Map(),
    input: {}, host: { bot, budget: { toolCall: vi.fn(() => ({ ok: true })) }, tools: { toolLedger: { start: () => 'row', commit: vi.fn(), failed: vi.fn() } } },
    episode: new WriterEpisode(), ledgerRows: new Map(), fileCalls: new Map(), openTools: new Map(), announced: new Set(), sink: { tool: vi.fn(), lineEdits: vi.fn() }
  })
  let n = 0
  async function call(t: ReturnType<typeof turn>, toolName: string, target = path, content = 'mine\n', fail = false, read: { args?: Record<string, unknown>; result?: unknown } = {}) {
    const thread = { turn: t, cwd: files }
    const toolCallId = String(++n)
    const input = { path: target, content, oldText: 'one', newText: 'mine', ...read.args }
    const answer = await rpc.gate(thread, { attemptToken: 't', toolCallId, toolName, input })
    if (answer.allow) {
      if (!fail) {
        if (toolName === 'write') writeFileSync(target, content)
        if (toolName === 'edit') writeFileSync(target, readFileSync(target, 'utf8').replace('one', 'mine'))
        if (toolName === 'read') accessSync(target)
      }
      rpc.turnEvent(thread, t, { type: 'tool_execution_end', toolCallId, toolName, args: input, isError: fail, result: read.result ?? {} })
    }
    return answer
  }
  return { files, scratch, path, authority, turn, call }
}

// Inputs: read/unread; edit/write/create; other writer; fresh read; own/failed writes;
// separate activations/bots; dispatch replacement; relative aliases; scratch; other runtimes.
for (const tool of ['edit', 'write']) {
  it(`${tool}: refuses stale bytes without a charge or write, then accepts after a fresh read`, async () => {
    const f = fixture(), t = f.turn()
    await f.call(t, 'read')
    writeFileSync(f.path, 'one\nother\n')
    const charged = t.host.budget.toolCall.mock.calls.length
    expect(await f.call(t, tool)).toEqual({ allow: false, reason: refusal })
    expect(readFileSync(f.path, 'utf8')).toBe('one\nother\n')
    expect(t.host.budget.toolCall).toHaveBeenCalledTimes(charged)
    await f.call(t, 'read')
    expect((await f.call(t, tool)).allow).toBe(true)
    expect(readFileSync(f.path, 'utf8')).toBe(tool === 'edit' ? 'mine\nother\n' : 'mine\n')
  })
  it(`${tool}: refuses an existing file never read in this activation`, async () => {
    const f = fixture()
    expect(await f.call(f.turn(), tool)).toEqual({ allow: false, reason: refusal })
    expect(readFileSync(f.path, 'utf8')).toBe('one\n')
  })
}
it('creating a file counts as reading it and permits the next edit', async () => {
  const f = fixture(), t = f.turn(), path = join(f.files, 'new.md')
  expect((await f.call(t, 'write', path, 'one\n')).allow).toBe(true)
  expect((await f.call(t, 'edit', path)).allow).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('mine\n')
})
it('a successful edit and overwrite both refresh the version', async () => {
  const f = fixture(), t = f.turn()
  await f.call(t, 'read')
  await f.call(t, 'edit')
  expect((await f.call(t, 'write', f.path, 'one\n')).allow).toBe(true)
  expect((await f.call(t, 'edit')).allow).toBe(true)
})
it('another activation or bot cannot lend its reads, even after a restart', async () => {
  const f = fixture()
  await f.call(f.turn(), 'read')
  for (const bot of [f.authority('b'), f.authority('a')]) expect(await f.call(f.turn(bot), 'edit')).toEqual({ allow: false, reason: refusal })
  const elsewhere = join(f.files, 'other-bot'); mkdirSync(elsewhere)
  const other = join(elsewhere, 'todo.md'); writeFileSync(other, 'one\n')
  expect(await f.call(f.turn(f.authority('other', elsewhere)), 'edit', other)).toEqual({ allow: false, reason: refusal })
})
it('keeps reads across dispatches of the activation and resolves relative aliases', async () => {
  const f = fixture(), state = new Map<string, string>()
  await f.call(f.turn(f.authority('a', f.files, state)), 'read')
  expect((await f.call(f.turn(f.authority('a', f.files, state)), 'edit', join(f.files, '.', 'todo.md'))).allow).toBe(true)
})
it('a failed read or write does not refresh the remembered version', async () => {
  const f = fixture(), t = f.turn()
  await f.call(t, 'read', f.path, '', true)
  expect(await f.call(t, 'edit')).toEqual({ allow: false, reason: refusal })
  await f.call(t, 'read')
  await f.call(t, 'write', f.path, 'x', true)
  writeFileSync(f.path, 'other\n')
  expect(await f.call(t, 'edit')).toEqual({ allow: false, reason: refusal })
})
it('scratch files and Claude Code/Codex authority checks are unchanged', async () => {
  const f = fixture(), t = f.turn(), scratch = join(f.scratch, 'x')
  writeFileSync(scratch, 'one\n')
  expect((await f.call(t, 'edit', scratch)).allow).toBe(true)
  for (const nativeName of ['Edit', 'Write', 'apply_patch']) {
    expect(t.bot.check({ kind: 'builtin', tool: 'edit', nativeName, args: { path: f.path } }).ok).toBe(true)
  }
})

for (const size of [50 * 1024 * 1024, 3 * 1024 * 1024 * 1024]) {
  it(`versions a ${size}-byte file without loading its contents and permits a fresh overwrite`, async () => {
    const f = fixture(), t = f.turn()
    const fd = fs.openSync(f.path, 'r+')
    fs.ftruncateSync(fd, size); fs.closeSync(fd)
    // Fail safely on the old implementation, rather than allocate a giant buffer in the test.
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync
    const reads = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (path === f.path) throw new Error('whole-file read is forbidden in this fixture')
      return original(path, ...args as [])
    }) as typeof fs.readFileSync)
    await f.call(t, 'read')
    expect(reads.mock.calls.filter(([path]) => path === f.path)).toHaveLength(0)
    expect((await f.call(t, 'write')).allow).toBe(true)
    reads.mockRestore()
    expect(readFileSync(f.path, 'utf8')).toBe('mine\n')
  })
}
it('detects a file growing past the hash cap and accepts it after a fresh read', async () => {
  const f = fixture(), t = f.turn()
  await f.call(t, 'read')
  const fd = fs.openSync(f.path, 'r+')
  fs.ftruncateSync(fd, 4 * 1024 * 1024); fs.closeSync(fd)
  const reads = vi.spyOn(fs, 'readFileSync')
  expect(await f.call(t, 'write')).toEqual({ allow: false, reason: refusal })
  await f.call(t, 'read')
  expect((await f.call(t, 'write')).allow).toBe(true)
  expect(reads.mock.calls.filter(([path]) => path === f.path)).toHaveLength(0)
})

for (const [name, read] of [
  ['offset', { args: { offset: 2 } }],
  ['limit', { args: { limit: 1 } }],
  ['Pi truncation', { result: { details: { truncation: { truncated: true } } } }],
  ['oversized first line', { result: { details: { truncation: { firstLineExceedsLimit: true } } } }]
] as const) {
  it(`a partial read (${name}) allows version-checked edits but requires a whole read before overwrite`, async () => {
    const f = fixture(), t = f.turn()
    await f.call(t, 'read', f.path, '', false, read)
    expect((await f.call(t, 'write')).allow).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe('one\n')
    expect((await f.call(t, 'edit')).allow).toBe(true)
    expect((await f.call(t, 'write')).allow).toBe(false)
    await f.call(t, 'read')
    expect((await f.call(t, 'write')).allow).toBe(true)
  })
}

it('case aliases share a version on a case-insensitive filesystem', async (ctx) => {
  const f = fixture(), t = f.turn()
  const alias = join(f.files, 'TODO.md')
  if (!fs.existsSync(alias)) ctx.skip()
  await f.call(t, 'read', f.path)
  expect((await f.call(t, 'edit', alias)).allow).toBe(true)
})
it('stays within the content-read cap when a file grows during fingerprinting', async () => {
  const f = fixture(), t = f.turn()
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).readSync
  let requested = 0
  const reads = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    requested += length
    const result = original(fd, bytes, offset, length, position)
    // An outside writer grows the inode after the first stat and read.
    const writer = fs.openSync(f.path, 'r+')
    fs.ftruncateSync(writer, 4 * 1024 * 1024); fs.closeSync(writer)
    return result
  }) as typeof fs.readSync)
  await f.call(t, 'read')
  expect(requested).toBeGreaterThan(0)
  expect(requested).toBeLessThanOrEqual(2 * 1024 * 1024)
  reads.mockRestore()
  expect((await f.call(t, 'write')).allow).toBe(true)
})

for (const args of [{ limit: 100 }, { offset: 1 }, { offset: 1, limit: 100 }]) {
  it(`allows overwrite after a complete short read with ${JSON.stringify(args)}`, async () => {
    const f = fixture(), t = f.turn()
    writeFileSync(f.path, 'one\ntwo')
    await f.call(t, 'read', f.path, '', false, { args })
    expect((await f.call(t, 'write')).allow).toBe(true)
  })
}
const page = (offset: number, outputLines: number, truncated: boolean) => ({
  args: { offset }, result: { details: { truncation: { outputLines, truncated } } }
})
it('allows overwrite after three consecutive pages cover an unchanged 5000-line file', async () => {
  const f = fixture(), t = f.turn()
  writeFileSync(f.path, Array.from({ length: 5000 }, (_, n) => `line ${n}`).join('\n'))
  await f.call(t, 'read', f.path, '', false, page(1, 2000, true))
  expect(await f.call(t, 'write')).toEqual({ allow: false, reason: expect.stringContaining('change it with edit, which is checked against what you read, or read every page first') })
  await f.call(t, 'read', f.path, '', false, page(2001, 2000, true))
  expect((await f.call(t, 'write')).allow).toBe(false)
  await f.call(t, 'read', f.path, '', false, page(4001, 1000, false))
  expect((await f.call(t, 'write')).allow).toBe(true)
})
it('does not combine pages from different versions or across a gap', async () => {
  const f = fixture(), t = f.turn()
  writeFileSync(f.path, Array.from({ length: 5000 }, () => 'one').join('\n'))
  await f.call(t, 'read', f.path, '', false, page(1, 2000, true))
  writeFileSync(f.path, readFileSync(f.path, 'utf8').replace('one', 'two'))
  await f.call(t, 'read', f.path, '', false, page(2001, 2000, true))
  await f.call(t, 'read', f.path, '', false, page(4001, 1000, false))
  expect((await f.call(t, 'write')).allow).toBe(false)
  await f.call(t, 'read', f.path, '', false, page(1, 2000, true))
  await f.call(t, 'read', f.path, '', false, page(4001, 1000, false))
  expect((await f.call(t, 'write')).allow).toBe(false)
})
it('a short partial read explains how to read the file whole', async () => {
  const f = fixture(), t = f.turn()
  await f.call(t, 'read', f.path, '', false, { args: { limit: 1 } })
  expect(await f.call(t, 'write')).toEqual({ allow: false, reason: expect.stringContaining('read it again without offset or limit') })
})
it('a file created under a symlinked folder permits its first edit', async () => {
  const f = fixture(), t = f.turn(), directory = join(f.files, 'real'), alias = join(f.files, 'alias')
  mkdirSync(directory)
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const path = join(alias, 'new.md')
  expect((await f.call(t, 'write', path, 'one\n')).allow).toBe(true)
  expect((await f.call(t, 'edit', path)).allow).toBe(true)
  expect(readFileSync(join(directory, 'new.md'), 'utf8')).toBe('mine\n')
})
it('metadata catches a same-size rewrite with restored mtime', async () => {
  const f = fixture(), t = f.turn()
  const fd = fs.openSync(f.path, 'r+')
  fs.ftruncateSync(fd, 4 * 1024 * 1024); fs.closeSync(fd)
  const stat = fs.statSync(f.path)
  await f.call(t, 'read')
  const writer = fs.openSync(f.path, 'r+')
  fs.writeSync(writer, 'two', 0, 'utf8'); fs.closeSync(writer)
  fs.utimesSync(f.path, stat.atime, stat.mtime)
  expect(await f.call(t, 'write')).toEqual({ allow: false, reason: refusal })
})
