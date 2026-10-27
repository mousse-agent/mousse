/**
 * PR 6 §3: the locked Claude Code gate writes the run's tool ledger for built-ins. `canUseTool`
 * writes a `started` row before a granted built-in runs, with its neutral class's idempotency
 * (reads idempotent; edit, write and shell not), and the post-tool hooks commit or fail it. A denied
 * call writes nothing; Mousse's own tools are the registry's to write. `PreToolUse` counts
 * built-ins on the activation and never refuses on a count.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { ClaudeLockedGate, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'
import type { NeutralTool } from '../../src/shared/harness/tools'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { tools?: NeutralTool[]; appTools?: string[]; charge?: 'ok' | 'refused'; ledger?: boolean; shell?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'claude-locked-ledger-'))
  dirs.push(base)
  const root = join(base, 'root')
  const scratch = join(base, 'scratch')
  mkdirSync(root)
  mkdirSync(scratch)
  const charge = vi.fn(() => (options.charge === 'refused' ? { ok: false as const, count: 3, limit: 3 } : { ok: true as const, count: 1 }))
  const authority = createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: {
      tools: options.tools ?? ['read', 'list', 'search', 'edit', 'write', 'shell', 'web_fetch', 'web_search'],
      appTools: options.appTools ?? ['thread_read'],
      mcp: [],
      skills: [],
      workspace: { roots: [root], access: 'write', scratch }
    },
    waiting: () => false,
    counters: { charge },
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
  const rows: Array<{ id: string; name: string; idempotent?: boolean; status: string }> = []
  const ledger: ToolLedger = {
    start: (call, opts) => {
      const id = `row-${rows.length + 1}`
      rows.push({ id, name: call.name, ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}), status: 'started' })
      return id
    },
    commit: (id) => { rows.find((row) => row.id === id)!.status = 'committed' },
    failed: (id) => { rows.find((row) => row.id === id)!.status = 'failed' }
  }
  const turn: ClaudeLockedTurn = {
    authority,
    ...(options.ledger === false ? {} : { ledger }),
    cwd: scratch,
    shellContained: options.shell ?? true,
    temps: [],
    systemPrompt: ''
  }
  return { gate: new ClaudeLockedGate(turn, true), rows, charge, root, scratch }
}

describe('locked Claude Code: built-in ledger rows', () => {
  it('an allowed built-in writes started, then committed; a failed one is failed', () => {
    const { gate, rows, root } = fixture()
    expect(gate.canUse('Read', { file_path: join(root, 'a.txt') }, 'tu-1')).toEqual({ ok: true })
    expect(gate.canUse('Edit', { file_path: join(root, 'a.txt'), old_string: 'a', new_string: 'b' }, 'tu-2')).toEqual({ ok: true })
    expect(rows.map((row) => row.status)).toEqual(['started', 'started'])
    gate.committed('tu-1')
    gate.failed('tu-2')
    expect(rows.map((row) => [row.name, row.status])).toEqual([['Read', 'committed'], ['Edit', 'failed']])
    // A second end of the same call, or one for an unknown call, changes nothing.
    gate.committed('tu-2')
    gate.failed('tu-unknown')
    expect(rows.map((row) => row.status)).toEqual(['committed', 'failed'])
  })

  it('a denied call writes no row', () => {
    const { gate, rows } = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'claude-locked-outside-'))
    dirs.push(outside)
    expect(gate.canUse('Read', { file_path: join(outside, 'secret.txt') }, 'tu-1').ok).toBe(false)
    expect(gate.canUse('Agent', { prompt: 'x' }, 'tu-2').ok).toBe(false)
    expect(gate.canUse('NotebookEdit', { notebook_path: 'n.ipynb' }, 'tu-3').ok).toBe(false)
    expect(rows).toEqual([])
  })

  it('reads, searches, web tools and ToolSearch are written idempotent; Edit, Write and Bash are not', () => {
    const { gate, rows, root } = fixture()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: join(root, 'a') }],
      ['Glob', { pattern: '**/*.ts', path: root }],
      ['Grep', { pattern: 'x', path: root }],
      ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
      ['WebSearch', { query: 'x' }],
      ['ToolSearch', { query: 'select:mcp__mousse__thread_read' }],
      ['Edit', { file_path: join(root, 'a'), old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: join(root, 'b'), content: 'x' }],
      ['Bash', { command: 'ls' }]
    ]
    calls.forEach(([name, args], index) => expect(gate.canUse(name, args, `tu-${index}`), name).toEqual({ ok: true }))
    expect(rows.map((row) => [row.name, row.idempotent])).toEqual([
      ['Read', true], ['Glob', true], ['Grep', true], ['WebFetch', true], ['WebSearch', true], ['ToolSearch', true],
      ['Edit', false], ['Write', false], ['Bash', false]
    ])
  })

  it('Mousse\'s own tools are not written here: the registry writes their rows', () => {
    const { gate, rows } = fixture()
    expect(gate.canUse('mcp__mousse__thread_read', { limit: 5 }, 'tu-1')).toEqual({ ok: true })
    expect(gate.canUse('mcp__mousse__thread_send', { text: 'x' }, 'tu-2').ok).toBe(false)
    expect(rows).toEqual([])
  })

  it('without the run\'s ledger, a built-in does not run', () => {
    const { gate, root } = fixture({ ledger: false })
    expect(gate.canUse('Read', { file_path: join(root, 'a') }, 'tu-1')).toEqual({ ok: false, reason: expect.stringContaining('could not be recorded') })
  })

  it('PreToolUse counts built-ins only, writes no row, and never refuses on a count', () => {
    const { gate, rows, charge, root } = fixture({ charge: 'refused' })
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') })).toEqual({ ok: true })
    expect(gate.preToolUse('Edit', { file_path: join(root, 'a'), old_string: 'a', new_string: 'b' })).toEqual({ ok: true })
    expect(gate.preToolUse('mcp__mousse__thread_read', {})).toEqual({ ok: true })
    expect(gate.preToolUse('ToolSearch', { query: 'x' })).toEqual({ ok: true })
    expect(charge.mock.calls).toEqual([['tool'], ['tool']])
    // A denied call is not counted.
    expect(gate.preToolUse('Agent', {}).ok).toBe(false)
    expect(charge).toHaveBeenCalledTimes(2)
    expect(rows).toEqual([])
  })
})

describe('locked Claude Code: the gate fails closed (PR 6 review M2)', () => {
  it('a count that throws (a busy bots.db) denies the call in PreToolUse, and writes nothing', () => {
    const { gate, rows, root, charge } = fixture()
    charge.mockImplementation(() => { throw new Error('database is locked') })
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') })).toEqual({ ok: false, reason: expect.stringContaining('could not be checked') })
    expect(rows).toEqual([])
  })

  it('a check that throws denies the call in both hooks, and writes no row', () => {
    const { gate, rows, root } = fixture()
    const authority = (gate as unknown as { turn: ClaudeLockedTurn }).turn.authority
    authority.check = () => { throw new Error('bots.db is busy') }
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') }).ok).toBe(false)
    expect(gate.canUse('Read', { file_path: join(root, 'a') }, 'tu-1')).toEqual({ ok: false, reason: expect.stringContaining('could not be checked') })
    expect(gate.canUse('mcp__mousse__thread_read', {}, 'tu-2').ok).toBe(false)
    expect(rows).toEqual([])
  })

  it('a ledger that throws denies the call', () => {
    const { gate, root } = fixture()
    const turn = (gate as unknown as { turn: ClaudeLockedTurn }).turn
    turn.ledger = { start: () => { throw new Error('disk full') }, commit: () => {}, failed: () => {} }
    expect(gate.canUse('Read', { file_path: join(root, 'a') }, 'tu-1').ok).toBe(false)
  })

  it('a Glob or Grep pattern that leaves its folder is refused, braces included', () => {
    const { gate, root } = fixture()
    for (const pattern of ['{..,x}/secret', '../**', '~/**', '/etc/*', 'C:/x/*', '$HOME/*'])
      expect(gate.preToolUse('Glob', { pattern, path: root }).ok, pattern).toBe(false)
    expect(gate.preToolUse('Grep', { pattern: 'x', path: root, glob: '{..}/*.ts' }).ok).toBe(false)
    expect(gate.preToolUse('Glob', { pattern: 'src/**/*.{ts,tsx}', path: root }).ok).toBe(true)
  })
})
