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
  async function call(t: ReturnType<typeof turn>, toolName: string, target = path, content = 'mine\n', fail = false) {
    const thread = { turn: t, cwd: files }
    const toolCallId = String(++n)
    const input = { path: target, content, oldText: 'one', newText: 'mine' }
    const answer = await rpc.gate(thread, { attemptToken: 't', toolCallId, toolName, input })
    if (answer.allow) {
      if (!fail) {
        if (toolName === 'write') writeFileSync(target, content)
        if (toolName === 'edit') writeFileSync(target, readFileSync(target, 'utf8').replace('one', 'mine'))
        if (toolName === 'read') accessSync(target)
      }
      rpc.turnEvent(thread, t, { type: 'tool_execution_end', toolCallId, toolName, args: input, isError: fail, result: {} })
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
    const original = fs.readFileSync
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
