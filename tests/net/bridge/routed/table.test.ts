import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_LOCAL_METHODS,
  ROUTED_METHODS,
  classifyRoutedMethod,
  routedKeysAt,
  routedVersions,
  type RoutedRow
} from '../../../../src/shared/bridge/routed'
import { PROTOCOL_METHODS } from '../../../../src/mms/protocol/types'
import { GUI_REQUIRED_METHODS } from '../../../../src/main/mms/guiDaemonCompatibility'
import { BRIDGE_REMOTE_METHODS } from '../../../../src/mms/bridge/remote/capabilities'
import { cleanup, fixture } from '../hub/fixture'

afterEach(cleanup)

const VERSIONS_FILE = fileURLToPath(new URL('./routedVersions.json', import.meta.url))

type Snapshot = Record<string, { version: number; digest: string }>

/** The keys of a row at its current version, in one stable text. */
function digestOf(row: RoutedRow): string {
  const keys = routedKeysAt(row, row.version)
    .map((key) => `${key}@${row.since?.[key] ?? 1}`)
    .sort()
  return createHash('sha256')
    .update(JSON.stringify({ keys, required: [...(row.required ?? [])].sort() }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * What is wrong with `table` compared with the versions on record: a row whose keys changed without
 * a higher version, a row that went back to an older version, and rows that are not on record.
 */
export function routedVersionProblems(
  table: Readonly<Record<string, RoutedRow>>,
  snapshot: Snapshot
): string[] {
  const problems: string[] = []
  for (const [method, row] of Object.entries(table)) {
    const recorded = snapshot[method]
    if (!recorded) problems.push(`${method} is not on record: add it to routedVersions.json`)
    else if (row.version < recorded.version)
      problems.push(`${method} went back from version ${recorded.version} to ${row.version}`)
    else if (row.version === recorded.version && digestOf(row) !== recorded.digest)
      problems.push(
        `${method} changed its keys without a new version: raise version above ${row.version}`
      )
    else if (row.version > recorded.version)
      problems.push(`${method} is at version ${row.version}: update routedVersions.json`)
  }
  for (const method of Object.keys(snapshot))
    if (!table[method]) problems.push(`${method} is on record but no longer a row`)
  return problems
}

const snapshotOf = (table: Readonly<Record<string, RoutedRow>>): Snapshot =>
  Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, row]) => [method, { version: row.version, digest: digestOf(row) }])
  )

describe('the routed method table', () => {
  it('classifies every protocol and domain method as a row or as local with a reason', async () => {
    const f = await fixture()
    const domain = [...(f.mms.domains?.methods() ?? [])]
    const everything = [
      ...new Set([...PROTOCOL_METHODS, ...domain, ...GUI_REQUIRED_METHODS])
    ].sort()
    expect(domain.length).toBeGreaterThan(50)
    const unclassified = everything.filter((method) => !classifyRoutedMethod(method))
    expect(unclassified).toEqual([])
    for (const method of everything) {
      const found = classifyRoutedMethod(method)!
      if (found.kind === 'local') expect(found.reason.length).toBeGreaterThan(20)
    }
  }, 60_000)

  it('names only methods that exist, and never lists a row as local', async () => {
    const f = await fixture()
    const domain = new Set(f.mms.domains?.methods() ?? [])
    const protocol = new Set<string>(PROTOCOL_METHODS)
    for (const rule of ROUTED_LOCAL_METHODS) {
      expect(rule.reason.length).toBeGreaterThan(20)
      for (const method of rule.methods ?? []) {
        expect(protocol.has(method) || domain.has(method), `${method} is not a method`).toBe(true)
        expect(ROUTED_METHODS[method], `${method} is both a row and local`).toBeUndefined()
      }
    }
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      if (row.via === 'protocol')
        expect(protocol.has(method), `${method} is not a protocol method`).toBe(true)
      if (row.via === 'domain')
        expect(domain.has(method), `${method} is not a domain method`).toBe(true)
      // The backend rows are the ones a linked phone already has, with the checks written for devices.
      if (row.via === 'backend')
        expect(Object.hasOwn(BRIDGE_REMOTE_METHODS, method), `${method} has no backend`).toBe(true)
    }
  }, 60_000)

  it('keeps the file, terminal, purge and sender-naming methods out of the table', () => {
    for (const method of [
      'files.writeDirect',
      'files.root',
      'threads.purge',
      'pty.create',
      'pty.write',
      'pty.kill',
      'pty.resize'
    ]) {
      expect(ROUTED_METHODS[method]).toBeUndefined()
      expect(classifyRoutedMethod(method)).toMatchObject({ kind: 'local' })
    }
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      for (const key of ROUTED_FORBIDDEN_KEYS)
        expect(row.keys, `${method} takes ${key}`).not.toContain(key)
    // Only projects.open names a path of the owner's disk; file and Git rows name a thread or a project.
    expect(
      Object.entries(ROUTED_METHODS)
        .filter(([, row]) => row.absolutePath)
        .map(([method]) => method)
    ).toEqual(['projects.open'])
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      if (method.startsWith('files.') || method.startsWith('git.'))
        expect(row.target, method).toMatch(/^(thread|folder|project)$/)
  })

  it('describes each row consistently', () => {
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      const label = (what: string) => `${method}: ${what}`
      expect(new Set(row.keys).size, label('duplicate keys')).toBe(row.keys.length)
      for (const key of row.required ?? [])
        expect(row.keys, label(`required ${key} is not a key`)).toContain(key)
      for (const key of row.routeOnly ?? [])
        expect(row.keys, label(`routeOnly ${key} is not a key`)).toContain(key)
      for (const key of row.threadIds ?? [])
        expect(row.keys, label(`thread id ${key} is not a key`)).toContain(key)
      for (const key of Object.keys(row.owned ?? {}))
        expect(row.keys, label(`owned ${key} is not a key`)).toContain(key)
      for (const [key, since] of Object.entries(row.since ?? {})) {
        expect(row.keys, label(`since ${key} is not a key`)).toContain(key)
        expect(since, label(`${key} is newer than the row`)).toBeLessThanOrEqual(row.version)
      }
      expect(Number.isSafeInteger(row.version) && row.version >= 1, label('version')).toBe(true)
      // The target's ids are keys of the row.
      if (row.target === 'thread') expect(row.keys).toContain(row.threadIds?.[0] ?? 'threadId')
      if (row.target === 'folder')
        expect(row.keys).toEqual(expect.arrayContaining(['threadId', 'projectId']))
      if (row.target === 'project') expect(row.keys).toContain('projectId')
      // Everything that changes something goes through the ledger; reads keep nothing on disk.
      expect(row.durable, label('durability')).toBe(row.capability !== 'read')
      // Only the terminal rows need the terminal switch.
      expect(Boolean(row.terminal), label('terminal')).toBe(method.startsWith('pty.'))
    }
  })

  it('advertises one version per row', () => {
    const versions = routedVersions()
    expect(Object.keys(versions).sort()).toEqual(Object.keys(ROUTED_METHODS).sort())
    expect(Object.values(versions).every((v) => v >= 1)).toBe(true)
  })

  it('matches the versions on record, and a changed row needs a new version', () => {
    const fresh = snapshotOf(ROUTED_METHODS)
    if (process.env.UPDATE_ROUTED_VERSIONS === '1')
      writeFileSync(VERSIONS_FILE, JSON.stringify(fresh, null, 2) + '\n')
    const recorded = JSON.parse(readFileSync(VERSIONS_FILE, 'utf8')) as Snapshot
    expect(routedVersionProblems(ROUTED_METHODS, recorded)).toEqual([])

    // A row with a new key and the same version fails.
    const changed = {
      ...ROUTED_METHODS,
      'queue.list': {
        ...ROUTED_METHODS['queue.list'],
        keys: [...ROUTED_METHODS['queue.list'].keys, 'limit']
      }
    }
    expect(routedVersionProblems(changed, recorded)).toEqual([
      expect.stringContaining('queue.list changed its keys without a new version')
    ])
    // Raising the version is noticed until the record is updated, and a key that says which version added it is fine.
    const bumped = {
      ...ROUTED_METHODS,
      'queue.list': {
        ...ROUTED_METHODS['queue.list'],
        keys: [...ROUTED_METHODS['queue.list'].keys, 'limit'],
        version: 2,
        since: { limit: 2 }
      }
    }
    expect(routedVersionProblems(bumped, recorded)).toEqual([
      expect.stringContaining('queue.list is at version 2')
    ])
    expect(routedKeysAt(bumped['queue.list'], 1)).toEqual(['threadId'])
    expect(routedKeysAt(bumped['queue.list'], 2)).toEqual(['threadId', 'limit'])
    // A new row and a dropped row are both noticed.
    expect(
      routedVersionProblems(
        { ...ROUTED_METHODS, 'queue.size': ROUTED_METHODS['queue.list'] },
        recorded
      )
    ).toEqual([expect.stringContaining('queue.size is not on record')])
    const { 'queue.list': _dropped, ...rest } = ROUTED_METHODS
    expect(routedVersionProblems(rest, recorded)).toEqual([
      expect.stringContaining('queue.list is on record but no longer a row')
    ])
  })
})
