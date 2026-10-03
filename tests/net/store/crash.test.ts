import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqliteNetStore } from '../../../src/mms/net/store'
import { profile } from './helpers'

const roots: string[] = []
let executable: string
beforeAll(() => {
  const directory = profile(); roots.push(directory); executable = join(directory, 'crash-child.cjs')
  buildSync({ entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))], outfile: executable, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' })
})
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function crash(mode: string) {
  const root = profile(); roots.push(root)
  const result = spawnSync(process.execPath, [executable, root, mode], { timeout: 20_000, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(77)
  const state = JSON.parse(readFileSync(join(root, 'test-state.json'), 'utf8'))
  return { root, state }
}

describe('real process loss before SQLite commits', () => {
  it('cannot publish a partially committed execution, reservation or acceptance receipt', () => {
    const { root, state } = crash('admission'); const store = new SqliteNetStore({ profileDir: root })
    try {
      expect(store.executions.find(state.key)).toBeUndefined()
      expect(store.budgets.remaining(state.bot, state.space, state.now)).toBe(100)
      expect(store.outbox.get(state.receipt)).toBeUndefined()
    } finally { store.close() }
  })
  it('keeps the old generation/cursor when activation loses its process before commit', () => {
    const { root, state } = crash('snapshot'); const store = new SqliteNetStore({ profileDir: root })
    try {
      expect(store.streams.cursor(state.stream)).toMatchObject({ epoch: 1, seq: 1 })
      expect(store.database.prepare("SELECT count(*) AS n FROM net_generations WHERE state='staging'").get()!.n).toBe(0)
    } finally { store.close() }
  })
  it('exposes uncertain after an external effect when completion/accounting/receipt lost their transaction', () => {
    const { root, state } = crash('completion'); const store = new SqliteNetStore({ profileDir: root })
    try {
      expect(existsSync(join(root, 'external-effect'))).toBe(true)
      expect(store.executions.find(state.key)?.state).toBe('running')
      store.executions.recoverAfterRestart(state.now)
      expect(store.executions.find(state.key)?.state).toBe('uncertain')
      expect(store.budgets.remaining(state.bot, state.space, state.now)).toBe(0)
      expect(store.outbox.get(state.receipt)).toBeUndefined()
      expect(store.executions.admit(state.key, 'a'.repeat(64), state.now, () => { throw new Error('must never automatically retry') }).kind).toBe('duplicate')
    } finally { store.close() }
  })
})
