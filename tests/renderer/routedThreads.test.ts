import { describe, expect, it } from 'vitest'
import { NO_REMOTE_SIDEBAR_THREADS, routedThreadsOn } from '../../src/renderer/lib/remoteThreadList'
import { skippedLine, THREAD_SEARCH_DEBOUNCE_MS } from '../../src/renderer/lib/threadSearchSkipped'
import { sameThreadSnapshot } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

const features = (netBridge: boolean, netBridgeThreads: boolean) =>
  ({ features: { netBridge, netBridgeThreads, netSpaces: false } }) as never

describe('the separate rows of other computers', () => {
  it('are left out of the sidebar only while Bridge and the routing flag are both on', () => {
    expect(routedThreadsOn(features(true, true))).toBe(true)
    expect(routedThreadsOn(features(true, false))).toBe(false)
    expect(routedThreadsOn(features(false, true))).toBe(false)
    expect(routedThreadsOn({} as never)).toBe(false)
    expect(routedThreadsOn(undefined)).toBe(false)
    expect(NO_REMOTE_SIDEBAR_THREADS.all).toEqual([])
    expect(NO_REMOTE_SIDEBAR_THREADS.unfiled).toEqual([])
    expect(NO_REMOTE_SIDEBAR_THREADS.byProject.size).toBe(0)
  })
})

describe('the thread list of the sidebar', () => {
  const row = (extra: Partial<Thread> = {}): Thread =>
    ({ id: 'n:t', name: 'T', createdAt: 'a', updatedAt: 'b', order: 0, ...extra }) as Thread

  it('changes when a thread of another computer goes offline or comes back, and not for a row that says the same', () => {
    expect(sameThreadSnapshot([row({ node: 'n' })], [row({ node: 'n' })])).toBe(true)
    expect(sameThreadSnapshot([row({ node: 'n' })], [row({ node: 'n', offline: true })])).toBe(
      false
    )
    expect(sameThreadSnapshot([row({ node: 'n', offline: true })], [row({ node: 'n' })])).toBe(
      false
    )
    expect(sameThreadSnapshot([row()], [row({ node: 'n' })])).toBe(false)
  })
})

describe('a search across computers', () => {
  it('waits a quarter of a second for typing to pause', () => {
    expect(THREAD_SEARCH_DEBOUNCE_MS).toBe(250)
  })

  it('names the computers it could not ask, and why, in one line', () => {
    expect(skippedLine(undefined)).toBe('')
    expect(skippedLine([])).toBe('')
    expect(
      skippedLine([
        { node: 'a', name: 'Laptop', reason: 'offline' },
        { node: 'b', name: 'Server', reason: 'slow' },
        { node: 'c', name: 'Desktop', reason: 'unavailable' }
      ])
    ).toBe(
      'Not searched: Laptop (offline), Server (did not answer in time), Desktop (not available)'
    )
  })
})
