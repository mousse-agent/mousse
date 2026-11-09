/**
 * The daemon's view of the threads that live in `thread.db`: a copy of what each one holds, and the save that writes
 * only what changed.
 *
 * For each thread it keeps, per row, the row's identity (`rid`), its order and a skeleton of what was written
 * (`jsonSkeleton.ts`). A save walks the thread it is given and compares it with those skeletons: unchanged text is the
 * same string instance, so the walk costs a visit per field, not per byte, and catches every change however it was
 * made (an edit in place, a replaced object, a removal, a context change). Only rows that differ are serialized and
 * sent to the write worker.
 *
 * Rows keep their identity through edits: an object this store handed out is known by its `rid`; a replaced object
 * claims the row with its message id (the n-th occurrence of an id claims the n-th row with it); context messages,
 * which have no id, claim the row at their position. A row another process added since this store last looked is
 * never removed by a save that did not include it.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { compose, decompose, TRANSCRIPT, type StoredThreadData } from './collections'
import { fromSkeleton, sameAsSkeleton, skeletonOf, type Skeleton } from './jsonSkeleton'
import { ORD_STEP, THREAD_DB_FILE, type DbChanges, type DbInfo, type DbLoad, type SaveRequest } from './threadDbEngine'
import type { ThreadDbClient } from './threadDbClient'

interface Row { rid: number; ord: number; id: string | null; skel: Skeleton }

interface Entry {
  info: DbInfo
  collections: Map<string, Row[]>
  state: Map<string, Skeleton>
  ridOf: WeakMap<object, number>
  /**
   * Rows another process wrote, with the first load that handed them out. A save removes such a row only when the
   * thread it is given came from that load or a later one; a view older than the row never had it.
   */
  external: Map<number, number | undefined>
  /** The load each handed-out object came from. */
  viewOf: WeakMap<object, number>
  loads: number
  usedAt: number
}

/** The parts of a thread a save replaces; a part left out keeps what is stored. */
export interface ThreadDataChange {
  messages?: StoredThreadData['messages']
  agents?: StoredThreadData['agents']
  tasks?: StoredThreadData['tasks']
  /** null removes the model context. */
  llmContext?: StoredThreadData['llmContext'] | null
  /** null removes every subagent session. */
  mousseAgentSessions?: StoredThreadData['mousseAgentSessions'] | null
}

export interface SaveStats { inserted: number; updated: number; deleted: number; state: number; bytes: number }

function rowId(collection: string, value: unknown): string | null {
  if (collection !== TRANSCRIPT && !/^s:\d+:m$/.test(collection)) return null
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

function sortRows(rows: Row[]): void {
  rows.sort((a, b) => a.ord - b.ord || a.rid - b.rid)
}

const MAX_CACHED_THREADS = 64

export class ThreadDbStore {
  private readonly entries = new Map<string, Entry>()
  /** Loads a save or synchronous read had to do without a warm copy; tests assert entry points never cause one. */
  coldLoads = 0
  lastSave?: SaveStats

  constructor(readonly client: ThreadDbClient) {}

  static usesDb(dir: string): boolean {
    return existsSync(join(dir, THREAD_DB_FILE))
  }

  private entryFrom(load: DbLoad): Entry {
    const collections = new Map<string, Row[]>()
    for (const row of load.rows) {
      const value = JSON.parse(row.payload) as unknown
      let rows = collections.get(row.coll)
      if (!rows) collections.set(row.coll, (rows = []))
      rows.push({ rid: row.rid, ord: row.ord, id: rowId(row.coll, value), skel: skeletonOf(value) ?? null })
    }
    for (const rows of collections.values()) sortRows(rows)
    const state = new Map<string, Skeleton>(load.state.map((row) => [row.key, skeletonOf(JSON.parse(row.payload)) ?? null]))
    return { info: load.info, collections, state, ridOf: new WeakMap(), external: new Map(), viewOf: new WeakMap(), loads: 0, usedAt: Date.now() }
  }

  private remember(dir: string, entry: Entry): Entry {
    this.entries.delete(dir)
    this.entries.set(dir, entry)
    while (this.entries.size > MAX_CACHED_THREADS) this.entries.delete(this.entries.keys().next().value!)
    return entry
  }

  private applyChanges(entry: Entry, changes: DbChanges): void {
    for (const removed of changes.removed) {
      const rows = entry.collections.get(removed.coll)
      if (!rows) continue
      const index = rows.findIndex((row) => row.rid === removed.rid)
      if (index >= 0) rows.splice(index, 1)
      entry.external.delete(removed.rid)
    }
    const touched = new Set<string>()
    for (const row of changes.rows) {
      const value = JSON.parse(row.payload) as unknown
      let rows = entry.collections.get(row.coll)
      if (!rows) entry.collections.set(row.coll, (rows = []))
      const next: Row = { rid: row.rid, ord: row.ord, id: rowId(row.coll, value), skel: skeletonOf(value) ?? null }
      const index = rows.findIndex((existing) => existing.rid === row.rid)
      if (index >= 0) rows[index] = next
      else {
        rows.push(next)
        entry.external.set(row.rid, undefined)
      }
      touched.add(row.coll)
    }
    for (const coll of touched) sortRows(entry.collections.get(coll)!)
    for (const key of changes.removedState) entry.state.delete(key)
    for (const row of changes.state) entry.state.set(row.key, skeletonOf(JSON.parse(row.payload)) ?? null)
    entry.info = changes.info
  }

  /** The thread's current rows: from memory when no other writer moved it, otherwise caught up first. */
  private fresh(dir: string): Entry {
    const entry = this.entries.get(dir)
    if (!entry) {
      this.coldLoads += 1
      return this.remember(dir, this.entryFrom(this.client.callSync('load', dir)))
    }
    const info = this.client.callSync('info', dir)
    if (info.dbId !== entry.info.dbId) return this.remember(dir, this.entryFrom(this.client.callSync('load', dir)))
    if (info.seq !== entry.info.seq || info.epoch !== entry.info.epoch) {
      const changes = this.client.callSync('changes', dir, entry.info.seq, entry.info.epoch)
      if (changes.reset) return this.remember(dir, this.entryFrom(changes))
      this.applyChanges(entry, changes)
    }
    entry.usedAt = Date.now()
    return entry
  }

  isWarm(dir: string): boolean {
    return this.entries.has(dir)
  }

  /** Loads a thread off the event loop, so later synchronous reads and saves find it in memory. */
  async warm(dir: string): Promise<void> {
    if (this.entries.has(dir)) return
    const load = await this.client.call('load', dir)
    const current = this.entries.get(dir)
    if (current && current.info.dbId === load.info.dbId && current.info.seq >= load.info.seq) return
    this.remember(dir, this.entryFrom(load))
  }

  forget(dir: string): void {
    this.entries.delete(dir)
  }

  forgetAll(): void {
    this.entries.clear()
  }

  /** What `loadThreadData` returns: new objects every time, each known by its row. */
  load(dir: string): StoredThreadData {
    return this.materialize(this.fresh(dir))
  }

  /**
   * `load` that builds the thread's data only when a field is first read. For a save that may not look at the
   * transcript (saving agents or tasks), which then costs nothing for the transcript.
   */
  loadLazy(dir: string): StoredThreadData {
    const entry = this.fresh(dir)
    let data: StoredThreadData | undefined
    const get = (): StoredThreadData => (data ??= this.materialize(entry))
    const lazy = {} as StoredThreadData
    for (const key of ['messages', 'agents', 'tasks', 'llmContext', 'mousseAgentSessions'] as const) {
      Object.defineProperty(lazy, key, { enumerable: true, configurable: true, get: () => get()[key] })
    }
    return lazy
  }

  /** Small state values (agents, tasks, session headers) without building the transcript. */
  readState(dir: string): { agents: unknown[]; tasks: unknown[]; sessions: number } {
    const entry = this.fresh(dir)
    const list = (key: string): unknown[] => {
      const skel = entry.state.get(key)
      return Array.isArray(skel) ? fromSkeleton<unknown[]>(skel) : []
    }
    return { agents: list('agents'), tasks: list('tasks'), sessions: list('sessions').length }
  }

  private materialize(entry: Entry): StoredThreadData {
    const view = ++entry.loads
    for (const [rid, seen] of entry.external) if (seen === undefined) entry.external.set(rid, view)
    const collections = new Map<string, unknown[]>()
    for (const [coll, rows] of entry.collections) {
      collections.set(coll, rows.map((row) => {
        const value = fromSkeleton<unknown>(row.skel)
        if (value && typeof value === 'object') {
          entry.ridOf.set(value, row.rid)
          entry.viewOf.set(value, view)
        }
        return value
      }))
    }
    const state = new Map<string, unknown>()
    for (const [key, skel] of entry.state) state.set(key, fromSkeleton(skel))
    return compose(collections, state)
  }

  info(dir: string): DbInfo {
    return this.fresh(dir).info
  }

  messageCount(dir: string): number {
    const entry = this.entries.get(dir)
    if (entry) return this.fresh(dir).collections.get(TRANSCRIPT)?.length ?? 0
    return this.client.callSync('summary', dir).messages
  }

  /**
   * Writes what differs between `change` and the stored thread, in one transaction, and returns once it is on disk.
   * Throws if it could not be saved; memory then still describes what is on disk.
   */
  save(dir: string, change: ThreadDataChange, info?: Record<string, string>): SaveStats {
    for (let attempt = 0; ; attempt++) {
      const entry = this.fresh(dir)
      const plan = this.plan(entry, change)
      if (!plan.request.inserts.length && !plan.request.updates.length && !plan.request.deletes.length && !plan.request.state.length && !info) {
        this.registerObjects(entry, plan, [])
        return (this.lastSave = { inserted: 0, updated: 0, deleted: 0, state: 0, bytes: 0 })
      }
      if (info) plan.request.info = info
      const result = this.client.callSync('save', dir, plan.request)
      if (!result.ok) {
        // Another process wrote between our look and our write; look again and redo the difference.
        if (attempt >= 3) throw new Error('Thread data kept changing during the save')
        continue
      }
      this.commit(entry, plan, result.rids, result.info)
      const stats: SaveStats = {
        inserted: plan.request.inserts.length,
        updated: plan.request.updates.length,
        deleted: plan.request.deletes.length,
        state: plan.request.state.length,
        bytes: plan.bytes
      }
      return (this.lastSave = stats)
    }
  }

  private plan(entry: Entry, change: ThreadDataChange): Plan {
    const target = new Map<string, unknown[]>()
    const targetState = new Map<string, unknown | null>()
    const replacedPrefixes: string[] = []
    if (change.messages !== undefined) target.set(TRANSCRIPT, change.messages)
    if (change.agents !== undefined) targetState.set('agents', change.agents)
    if (change.tasks !== undefined) targetState.set('tasks', change.tasks)
    if (change.llmContext !== undefined) {
      replacedPrefixes.push('c:')
      targetState.set('context', null)
      if (change.llmContext !== null) {
        const parts = decompose({ messages: [], agents: [], tasks: [], llmContext: change.llmContext })
        for (const [coll, items] of parts.collections) if (coll.startsWith('c:')) target.set(coll, items)
        targetState.set('context', parts.state.get('context'))
      }
    }
    if (change.mousseAgentSessions !== undefined) {
      replacedPrefixes.push('s:')
      const sessions = change.mousseAgentSessions ?? []
      targetState.set('sessions', null)
      if (sessions.length) {
        const parts = decompose({ messages: [], agents: [], tasks: [], mousseAgentSessions: sessions })
        for (const [coll, items] of parts.collections) if (coll.startsWith('s:')) target.set(coll, items)
        targetState.set('sessions', parts.state.get('sessions'))
      }
    }
    // A collection that is part of a replaced group but no longer present (a retired list dropped, a session gone).
    for (const coll of entry.collections.keys()) {
      if (!target.has(coll) && replacedPrefixes.some((prefix) => coll.startsWith(prefix))) target.set(coll, [])
    }

    const plan: Plan = {
      request: { baseSeq: entry.info.seq, epochBump: false, inserts: [], updates: [], deletes: [], state: [] },
      collections: new Map(),
      state: new Map(),
      bytes: 0,
      moved: new Map()
    }
    for (const [coll, items] of target) this.planCollection(entry, coll, items, plan)
    for (const [key, value] of targetState) {
      const current = entry.state.get(key)
      if (value === null || value === undefined) {
        if (entry.state.has(key)) {
          plan.request.state.push({ key, payload: null })
          plan.state.set(key, null)
        }
        continue
      }
      if (current !== undefined && sameAsSkeleton(value, current)) continue
      const payload = JSON.stringify(value)
      plan.bytes += payload.length
      plan.request.state.push({ key, payload })
      plan.state.set(key, skeletonOf(value) ?? null)
    }
    return plan
  }

  private planCollection(entry: Entry, coll: string, items: unknown[], plan: Plan): void {
    const old = entry.collections.get(coll) ?? []
    const byRid = new Map<number, Row>(old.map((row) => [row.rid, row]))
    const byId = new Map<string, Row[]>()
    for (const row of old) {
      if (row.id === null) continue
      let list = byId.get(row.id)
      if (!list) byId.set(row.id, (list = []))
      list.push(row)
    }
    const claimed = new Set<number>()
    const matches: Array<Row | undefined> = new Array(items.length)
    let newestView = 0
    for (const item of items) {
      const view = item && typeof item === 'object' ? entry.viewOf.get(item) : undefined
      if (view !== undefined && view > newestView) newestView = view
    }
    const hasIds = coll === TRANSCRIPT || /^s:\d+:m$/.test(coll)
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      let row: Row | undefined
      const known = item && typeof item === 'object' ? entry.ridOf.get(item) : undefined
      if (known !== undefined) {
        const candidate = byRid.get(known)
        if (candidate && !claimed.has(candidate.rid)) row = candidate
      }
      if (!row && hasIds) {
        const id = rowId(coll, item)
        if (id !== null) row = byId.get(id)?.find((candidate) => !claimed.has(candidate.rid))
      }
      if (!row && !hasIds) {
        const candidate = old[j]
        if (candidate && !claimed.has(candidate.rid)) row = candidate
      }
      if (row) {
        claimed.add(row.rid)
        matches[j] = row
      }
    }
    // Kept rows must stay in their stored order; a row that would move is written again instead.
    let lastOrd = -Infinity
    for (let j = 0; j < items.length; j++) {
      const row = matches[j]
      if (!row) continue
      if (row.ord > lastOrd) lastOrd = row.ord
      else {
        claimed.delete(row.rid)
        matches[j] = undefined
        plan.request.epochBump = true
      }
    }
    const survivors: Row[] = []
    for (const row of old) {
      if (claimed.has(row.rid)) continue
      const seen = entry.external.get(row.rid)
      if (entry.external.has(row.rid) && (seen === undefined || newestView < seen)) survivors.push(row)
      else plan.request.deletes.push({ rid: row.rid, coll })
    }

    // Orders for new rows: between the rows they sit between, or after the last one.
    const ords: number[] = new Array(items.length)
    let renumber = false
    let prev = 0
    for (let j = 0; j < items.length; ) {
      if (matches[j]) {
        prev = matches[j]!.ord
        ords[j] = prev
        j++
        continue
      }
      let k = j
      while (k < items.length && !matches[k]) k++
      const count = k - j
      const next = k < items.length ? matches[k]!.ord : Infinity
      if (next === Infinity) {
        for (let i = 0; i < count; i++) ords[j + i] = prev + ORD_STEP * (i + 1)
      } else if (next - prev > count) {
        const step = (next - prev) / (count + 1)
        for (let i = 0; i < count; i++) ords[j + i] = Math.floor(prev + step * (i + 1))
      } else {
        renumber = true
        const step = (next - prev) / (count + 1)
        for (let i = 0; i < count; i++) ords[j + i] = prev + step * (i + 1)
      }
      prev = ords[k - 1]!
      j = k
    }
    if (renumber) {
      plan.request.epochBump = true
      const merged: Array<{ ord: number; j?: number; row?: Row }> = [
        ...items.map((_, j) => ({ ord: ords[j]!, j })),
        ...survivors.map((row) => ({ ord: row.ord, row }))
      ].sort((a, b) => a.ord - b.ord)
      merged.forEach((slot, index) => {
        const ord = (index + 1) * ORD_STEP
        if (slot.j !== undefined) ords[slot.j] = ord
        else if (slot.row && slot.row.ord !== ord) {
          plan.request.updates.push({ rid: slot.row.rid, coll, ord })
          plan.moved.set(slot.row.rid, ord)
        }
      })
    }

    const planned: PlannedRow[] = []
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      const row = matches[j]
      const ord = ords[j]!
      if (row) {
        const same = sameAsSkeleton(item, row.skel)
        if (same && row.ord === ord) {
          planned.push({ item, rid: row.rid, ord, skel: row.skel })
          continue
        }
        const payload = same ? undefined : JSON.stringify(item)
        if (payload !== undefined) plan.bytes += payload.length
        plan.request.updates.push({ rid: row.rid, coll, ord, payload })
        planned.push({ item, rid: row.rid, ord, skel: same ? row.skel : skeletonOf(item) ?? null })
      } else {
        const payload = JSON.stringify(item)
        plan.bytes += payload.length
        const tmp = plan.request.inserts.length
        plan.request.inserts.push({ tmp, coll, ord, payload })
        planned.push({ item, tmp, ord, skel: skeletonOf(item) ?? null })
      }
    }
    plan.collections.set(coll, { planned, survivors })
  }

  private registerObjects(entry: Entry, plan: Plan, rids: number[]): void {
    for (const { planned } of plan.collections.values()) {
      for (const slot of planned) {
        const rid = slot.rid ?? rids[slot.tmp!]
        if (rid !== undefined && slot.item && typeof slot.item === 'object') entry.ridOf.set(slot.item, rid)
      }
    }
  }

  private commit(entry: Entry, plan: Plan, rids: number[], info: DbInfo): void {
    for (const [coll, { planned, survivors }] of plan.collections) {
      const rows: Row[] = planned.map((slot) => {
        const rid = slot.rid ?? rids[slot.tmp!]!
        entry.external.delete(rid)
        return { rid, ord: slot.ord, id: rowId(coll, slot.item), skel: slot.skel }
      })
      for (const survivor of survivors) rows.push({ ...survivor, ord: plan.moved.get(survivor.rid) ?? survivor.ord })
      sortRows(rows)
      if (rows.length) entry.collections.set(coll, rows)
      else entry.collections.delete(coll)
    }
    for (const deleted of plan.request.deletes) entry.external.delete(deleted.rid)
    for (const [key, skel] of plan.state) {
      if (skel === null) entry.state.delete(key)
      else entry.state.set(key, skel)
    }
    this.registerObjects(entry, plan, rids)
    entry.info = info
  }
}

interface PlannedRow { item: unknown; rid?: number; tmp?: number; ord: number; skel: Skeleton }

interface Plan {
  request: SaveRequest
  collections: Map<string, { planned: PlannedRow[]; survivors: Row[] }>
  state: Map<string, Skeleton | null>
  bytes: number
  moved: Map<number, number>
}
