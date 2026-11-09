import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { GitScope, GitUpstreamCheck } from '../../shared/types'

/**
 * What the last quiet look at each folder's upstream found, so the side card can say Pull before anything else
 * without anyone pressing Fetch. A folder is named by its key (`folderKey`), never a path on disk.
 *
 * A look runs when the card shows a folder and again when the window comes back to the front, at most once per
 * interval. The service fetches into a private ref and touches nothing a person sees, so a look costs one network
 * round trip and never holds up a commit.
 */

/** A look younger than this is good enough: the remote is not asked again until it is older. */
export const UPSTREAM_CHECK_INTERVAL_MS = 5 * 60_000

interface UpstreamCheckEntry {
  check: GitUpstreamCheck
  /** When this window last asked, whatever the answer; the interval counts from here. */
  askedAt: number
}

interface UpstreamCheckState {
  entries: Record<string, UpstreamCheckEntry>
}

export const useUpstreamCheckStore = create<UpstreamCheckState>(() => ({ entries: {} }))

const flights = new Map<string, Promise<void>>()
/**
 * Bumped for a folder each time its look is forgotten. A look that was under way then answers about a remote a
 * push or pull has since changed, so it is dropped instead of written back; the next look starts afresh.
 */
const generations = new Map<string, number>()

/**
 * Asks the service how far the folder's branch is from its upstream, unless a look is under way or one was made
 * within the interval (`force` skips the interval, not a look already under way). Never rejects: a service from
 * before the upstream check, or any other failure, leaves the card with what the status says.
 */
export function checkUpstream(key: string, scope: GitScope, options: { force?: boolean; now?: number } = {}): Promise<void> {
  const flight = flights.get(key)
  if (flight) return flight
  const now = options.now ?? Date.now()
  const entry = useUpstreamCheckStore.getState().entries[key]
  if (!options.force && entry && now - entry.askedAt < UPSTREAM_CHECK_INTERVAL_MS) return Promise.resolve()
  const generation = generations.get(key) ?? 0
  const run = (async () => {
    let check: GitUpstreamCheck
    try {
      check = await window.mousse.git.checkUpstream(scope)
    } catch {
      check = { state: 'none' }
    }
    if ((generations.get(key) ?? 0) !== generation) return
    useUpstreamCheckStore.setState((state) => ({ entries: { ...state.entries, [key]: { check, askedAt: now } } }))
  })().finally(() => {
    if (flights.get(key) === run) flights.delete(key)
  })
  flights.set(key, run)
  return run
}

/**
 * Forgets a folder's look, so the next one asks again at once: a push, pull or fetch has just changed what it would
 * say. A look still under way is dropped when it answers.
 */
export function forgetUpstreamCheck(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  flights.delete(key)
  useUpstreamCheckStore.setState((state) => {
    if (!state.entries[key]) return state
    const { [key]: _gone, ...rest } = state.entries
    return { entries: rest }
  })
}

/**
 * The folder's last look, kept fresh while `enabled`: on mount and whenever the window comes back to the front,
 * at most once per interval. Null until a look has answered.
 */
export function useUpstreamCheck(key: string | null, scope: GitScope, enabled: boolean): GitUpstreamCheck | null {
  const check = useUpstreamCheckStore((state) => (key ? state.entries[key]?.check ?? null : null))
  const { projectId, workspaceThreadId } = scope
  const readScope = useMemo<GitScope>(() => ({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const missing = useUpstreamCheckStore((state) => (key ? !state.entries[key] : false))
  useEffect(() => {
    if (!key || !enabled) return
    const look = () => {
      if (document.visibilityState === 'visible') void checkUpstream(key, readScope)
    }
    look()
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
    // `missing` asks again at once after `forgetUpstreamCheck`.
  }, [key, readScope, enabled, missing])
  return check
}
