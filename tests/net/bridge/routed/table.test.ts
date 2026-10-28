import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_LOCAL_METHODS,
  ROUTED_METHODS,
  ROUTED_STAGED_KEY,
  ROUTED_TRANSPORT_METHODS,
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

type Snapshot = Record<string, { version: number; digest: string; security: string }>

const short = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** The keys of a row at its current version, in one stable text. */
function digestOf(row: RoutedRow): string {
  const keys = routedKeysAt(row, row.version)
    .map((key) => `${key}@${row.since?.[key] ?? 1}`)
    .sort()
  return short({ keys, required: [...(row.required ?? [])].sort() })
}

/**
 * The columns that decide who may call a row and what it may touch. Changing one is not a change of keys
 * and needs no new version, but it must be a deliberate edit of `routedVersions.json`, so a reviewer sees it.
 */
function securityOf(row: RoutedRow): string {
  return short({
    capability: row.capability,
    durable: row.durable,
    target: row.target,
    via: row.via,
    terminal: row.terminal ?? false,
    absolutePath: row.absolutePath ?? false,
    threadIds: row.threadIds ?? ['threadId'],
    owned: Object.entries(row.owned ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    routeOnly: [...(row.routeOnly ?? [])].sort(),
    // Which values a caller may send ahead of the call is part of what the row lets through.
    ...(row.stageable?.length ? { stageable: [...row.stageable].sort() } : {}),
    // A numbered change keeps no ledger, and a terminal's starting folder is the one `cwd` a call may carry.
    ...(row.sequenced ? { sequenced: true } : {}),
    ...(row.startsIn ? { startsIn: true } : {})
  })
}

/**
 * What is wrong with `table` compared with the versions on record: a row whose keys changed without
 * a higher version, a row that went back to an older version, a row whose security columns changed,
 * and rows that are not on record.
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
    else if (securityOf(row) !== recorded.security)
      problems.push(
        `${method} changed its capability, target, ownership or other security columns: review it and update routedVersions.json`
      )
  }
  for (const method of Object.keys(snapshot))
    if (!table[method]) problems.push(`${method} is on record but no longer a row`)
  return problems
}

/**
 * The transport methods (`routed.page`, `routed.stage`, `routed.stream.open`) as rows, so their keys and
 * capability are on record like any other row's and cannot change without a new version.
 */
const transportRows = (): Record<string, RoutedRow> =>
  Object.fromEntries(
    Object.entries(ROUTED_TRANSPORT_METHODS).map(([name, row]) => [
      `routed.${name}`,
      {
        capability: row.capability,
        durable: name === 'stage',
        version: row.version,
        target: 'computer',
        keys: row.keys,
        required: row.required,
        via: 'protocol'
      } satisfies RoutedRow
    ])
  )

const snapshotOf = (table: Readonly<Record<string, RoutedRow>>): Snapshot =>
  Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, row]) => [
        method,
        { version: row.version, digest: digestOf(row), security: securityOf(row) }
      ])
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

  it('keeps the direct save, the Files folder and permanent delete out of the table', () => {
    for (const method of ['files.writeDirect', 'files.root', 'threads.purge']) {
      expect(ROUTED_METHODS[method]).toBeUndefined()
      expect(classifyRoutedMethod(method)).toMatchObject({ kind: 'local' })
    }
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      for (const key of ROUTED_FORBIDDEN_KEYS)
        // A terminal's starting folder is the one `cwd`: it must lie inside the thread's own, and the owner checks it.
        if (!(key === 'cwd' && row.startsIn))
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
      // Everything that changes something goes through the ledger, except numbered terminal input; reads keep nothing on disk.
      expect(row.durable, label('durability')).toBe(row.capability !== 'read' && !row.sequenced)
      // Only the terminal rows need the terminal switch.
      expect(Boolean(row.terminal), label('terminal')).toBe(method.startsWith('pty.'))
    }
  })

  it('routes the terminal changes, with the shell and environment left to the owner', () => {
    const terminals = Object.entries(ROUTED_METHODS)
      .filter(([method]) => method.startsWith('pty.'))
      .map(([method]) => method)
      .sort()
    expect(terminals).toEqual([
      'pty.create',
      'pty.isAlive',
      'pty.kill',
      'pty.list',
      'pty.lookup',
      'pty.outputSince',
      'pty.resize',
      'pty.scrollback',
      'pty.write'
    ])
    for (const method of ['pty.create', 'pty.kill', 'pty.write', 'pty.resize']) {
      const row = ROUTED_METHODS[method]
      expect(row.capability, method).toBe('write')
      expect(row.terminal, method).toBe(true)
      // No shell, shell arguments or environment, ever; only `pty.create` may name a folder, and only one inside the thread's.
      for (const key of ['command', 'env', 'shellArgs']) expect(row.keys, method).not.toContain(key)
      expect(row.keys.includes('cwd'), method).toBe(method === 'pty.create')
    }
    // Input and resizes are numbered and kept out of the ledger; the rest of the terminal changes are in it.
    expect(
      Object.entries(ROUTED_METHODS)
        .filter(([, row]) => row.sequenced)
        .map(([method]) => method)
        .sort()
    ).toEqual(['pty.resize', 'pty.write'])
    for (const method of ['pty.write', 'pty.resize']) {
      expect(ROUTED_METHODS[method].durable, method).toBe(false)
      expect(ROUTED_METHODS[method].keys, method).toContain('seq')
      expect(ROUTED_METHODS[method].required, method).toContain('seq')
    }
    for (const method of ['pty.create', 'pty.kill']) expect(ROUTED_METHODS[method].durable, method).toBe(true)
    expect(
      Object.entries(ROUTED_METHODS)
        .filter(([, row]) => row.startsIn)
        .map(([method]) => method)
    ).toEqual(['pty.create'])
  })

  it('advertises one version per row and per transport method', () => {
    const versions = routedVersions()
    expect(Object.keys(versions).sort()).toEqual(
      [...Object.keys(ROUTED_METHODS), ...Object.keys(ROUTED_TRANSPORT_METHODS)].sort()
    )
    expect(Object.values(versions).every((v) => v >= 1)).toBe(true)
    // A transport method never shares a name with a protocol method, so `routed.<name>` is unambiguous.
    for (const name of Object.keys(ROUTED_TRANSPORT_METHODS))
      expect(ROUTED_METHODS[name], name).toBeUndefined()
  })

  it('lets only the rows that carry large values stage them, and never a key the row lacks', () => {
    const staging = Object.entries(ROUTED_METHODS).filter(([, row]) => row.stageable)
    expect(staging.map(([method]) => method).sort()).toEqual([
      'files.write',
      'orchestrator.send',
      'orchestrator.steer',
      'queue.edit',
      'queue.enqueue'
    ])
    for (const [method, row] of staging) {
      // The key is new at version 2, so an owner at version 1 is never sent it.
      expect(row.keys, method).toContain(ROUTED_STAGED_KEY)
      expect(row.since?.[ROUTED_STAGED_KEY], method).toBe(2)
      expect(routedKeysAt(row, 1), method).not.toContain(ROUTED_STAGED_KEY)
      for (const key of row.stageable!) expect(row.keys, `${method} stages ${key}`).toContain(key)
      // Only content-like values are staged, never an id, a path or a mode.
      for (const key of row.stageable!)
        expect(['content', 'images', 'text'], `${method} stages ${key}`).toContain(key)
    }
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      if (!row.stageable) expect(row.keys, method).not.toContain(ROUTED_STAGED_KEY)
  })

  it('matches the versions on record, and a changed row needs a new version', () => {
    const everyRow = { ...ROUTED_METHODS, ...transportRows() }
    const fresh = snapshotOf(everyRow)
    if (process.env.UPDATE_ROUTED_VERSIONS === '1')
      writeFileSync(VERSIONS_FILE, JSON.stringify(fresh, null, 2) + '\n')
    const recorded = JSON.parse(readFileSync(VERSIONS_FILE, 'utf8')) as Snapshot
    expect(routedVersionProblems(everyRow, recorded)).toEqual([])

    // The transport methods are on record too: a changed key or capability needs a new version.
    expect(
      routedVersionProblems(
        {
          ...everyRow,
          'routed.page': {
            ...everyRow['routed.page'],
            keys: [...everyRow['routed.page'].keys, 'size']
          }
        },
        recorded
      )
    ).toEqual([expect.stringContaining('routed.page changed its keys without a new version')])
    expect(
      routedVersionProblems(
        { ...everyRow, 'routed.stage': { ...everyRow['routed.stage'], capability: 'read' } },
        recorded
      )
    ).toEqual([expect.stringContaining('routed.stage changed its capability')])

    // A row with a new key and the same version fails.
    const changed = {
      ...everyRow,
      'queue.list': {
        ...ROUTED_METHODS['queue.list'],
        keys: [...ROUTED_METHODS['queue.list'].keys, 'limit']
      }
    }
    expect(routedVersionProblems(changed, recorded)).toEqual([
      expect.stringContaining('queue.list changed its keys without a new version')
    ])
    // The columns that make a row safe are on record too: each change needs a deliberate update of the record.
    const row = ROUTED_METHODS['files.write']
    const edits: Array<[string, Partial<RoutedRow>]> = [
      ['capability', { capability: 'read' }],
      ['target', { target: 'project' }],
      ['via', { via: 'backend' }],
      ['terminal', { terminal: true }],
      ['absolutePath', { absolutePath: true }],
      ['owned', { owned: { content: 'run' } }],
      ['routeOnly', { routeOnly: ['content'] }],
      ['threadIds', { threadIds: ['path'] }],
      ['stageable', { stageable: ['path'] }]
    ]
    for (const [column, edit] of edits)
      expect(
        routedVersionProblems({ ...everyRow, 'files.write': { ...row, ...edit } }, recorded),
        column
      ).toEqual([expect.stringContaining('files.write changed its capability')])
    // Raising the version is noticed until the record is updated, and a key that says which version added it is fine.
    const bumped = {
      ...everyRow,
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
      routedVersionProblems({ ...everyRow, 'queue.size': ROUTED_METHODS['queue.list'] }, recorded)
    ).toEqual([expect.stringContaining('queue.size is not on record')])
    const { 'queue.list': _dropped, ...rest } = everyRow
    expect(routedVersionProblems(rest, recorded)).toEqual([
      expect.stringContaining('queue.list is on record but no longer a row')
    ])
  })
})
