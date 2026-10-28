/**
 * The snapshot of a computer's private lists stream: its size with a long list of threads, what leaves it
 * above 256 KiB, and that it is a document the display stream can carry.
 */
import { describe, expect, it } from 'vitest'
import { MmsListsSource } from '../../../../src/mms/bridge/remote/MmsListsSource'
import { REMOTE_LISTS_CACHE_MAX_BYTES } from '../../../../src/mms/net/store/remoteLists'
import {
  canonicalJson,
  MAX_DISPLAY_JSON_NODES,
  parseBoundedJsonDocument
} from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'
import type { Thread } from '../../../../src/shared/types'

const T0 = 1_700_000_000_000
const iso = (n: number): string => new Date(T0 + n * 1000).toISOString()

describe('the snapshot an owner sends', () => {
  const services = (threads: Thread[]) =>
    ({
      projects: { listProjects: () => [] },
      threads: { listAllThreads: () => threads },
      orchestrator: { getTurnSnapshot: () => ({}) },
      threadRuntimes: { getActivitySnapshot: () => ({}) },
      platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } }
    }) as never
  const row = (n: number, extra: Partial<Thread> = {}): Thread => ({
    id: `0b1c2d3e-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `A conversation about something that took a while ${n}`,
    projectId: `0b1c2d3e-1111-4000-8000-${String(n % 20).padStart(12, '0')}`,
    createdAt: iso(-n),
    updatedAt: iso(-n + 5),
    order: -n,
    startedAt: iso(-n),
    startedFrom: {
      node: newId('node'),
      projectId: `0b1c2d3e-2222-4000-8000-${String(n % 20).padStart(12, '0')}`
    },
    permissionMode: 'accept_edits',
    ...extra
  })

  it('stays within what a computer keeps of another’s lists with 2,000 threads', () => {
    const threads = Array.from({ length: 2000 }, (_, n) => row(n))
    const source = new MmsListsSource(services(threads), undefined, { private: true })
    const bytes = Buffer.byteLength(JSON.stringify(source.snapshot()))
    expect(source.snapshot().threads).toHaveLength(2000)
    // About 430 bytes a thread: 2,000 threads are under a megabyte, half of what a computer keeps of another's.
    expect(bytes).toBeLessThan(1024 * 1024)
    expect(bytes).toBeLessThan(REMOTE_LISTS_CACHE_MAX_BYTES)
  })

  it('is a document the display stream can carry, though not the wire parser: it has far more than 16,384 nodes', () => {
    const threads = Array.from({ length: 2000 }, (_, n) => row(n))
    const value = new MmsListsSource(services(threads), undefined, { private: true }).snapshot()
    expect(() => canonicalJson(value)).toThrow(expect.objectContaining({ code: 'too_large' }))
    const bytes = canonicalJson(value, MAX_DISPLAY_JSON_NODES)
    expect(() => parseBoundedJsonDocument(bytes, 32 * 1024 * 1024)).toThrow(
      expect.objectContaining({ code: 'too_large' })
    )
    expect(parseBoundedJsonDocument(bytes, 32 * 1024 * 1024, MAX_DISPLAY_JSON_NODES)).toMatchObject(
      {
        kind: 'mousse.lists'
      }
    )
    // The larger bound is a bound: a document with more nodes than it is refused.
    expect(() =>
      canonicalJson(
        Array.from({ length: MAX_DISPLAY_JSON_NODES }, () => 1),
        MAX_DISPLAY_JSON_NODES
      )
    ).toThrow(expect.objectContaining({ code: 'too_large' }))
  })

  it('leaves out threads archived more than 30 days ago, and the subagents under them, above 256 KiB', () => {
    const day = 24 * 3600_000
    const old = new Date(Date.now() - 60 * day).toISOString()
    const recent = new Date(Date.now() - 2 * day).toISOString()
    const threads: Thread[] = Array.from({ length: 2000 }, (_, n) =>
      row(n, n < 1500 ? { settledAt: old } : n < 1600 ? { settledAt: recent } : {})
    )
    // A subagent under a dropped parent goes with it; one under a kept parent stays.
    threads.push(
      row(5000, {
        lineage: {
          parentThreadId: threads[0]!.id,
          rootThreadId: threads[0]!.id,
          relationship: 'subagent'
        }
      }),
      row(5001, {
        lineage: {
          parentThreadId: threads[1700]!.id,
          rootThreadId: threads[1700]!.id,
          relationship: 'subagent'
        }
      })
    )
    const source = new MmsListsSource(services(threads), undefined, { private: true })
    const snapshot = source.snapshot()
    const ids = new Set(snapshot.threads.map((thread) => thread.id))
    expect(ids.has(threads[0]!.id)).toBe(false)
    expect(ids.has(threads[2000]!.id)).toBe(false)
    expect(ids.has(threads[1550]!.id)).toBe(true)
    expect(ids.has(threads[2001]!.id)).toBe(true)
    expect(snapshot.threads).toHaveLength(500 + 1)
    // A small list is never cut, however old its archive.
    const small = new MmsListsSource(services(threads.slice(0, 50)), undefined, { private: true })
    expect(small.snapshot().threads).toHaveLength(50)
    // A phone's list is its own and is not trimmed.
    const phone = new MmsListsSource(services(threads), undefined)
    expect(phone.snapshot().threads.length).toBeGreaterThan(500)
  })
})
