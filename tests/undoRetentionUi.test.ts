import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/stores/appStore', () => {
  let state = { profileId: 'default' }
  const listeners = new Set<(state: typeof state, previous: typeof state) => void>()
  const store = Object.assign((selector: (state: typeof state) => unknown) => selector(state), {
    getState: () => state,
    setState: (next: typeof state) => { const previous = state; state = next; for (const listener of listeners) listener(state, previous) },
    subscribe: (listener: (state: typeof state, previous: typeof state) => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  })
  return { useAppStore: store }
})
vi.mock('react', async (load) => ({
  ...await load<typeof import('react')>(),
  useEffect: (effect: () => unknown) => { effect() },
  useState: (initial?: unknown) => [initial, () => undefined],
  useRef: () => ({ current: null }),
  useId: () => 'retention-row',
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useDebugValue: () => undefined
}))
import { readThreadActionHistory } from '../src/renderer/utils/threadActionHistory'
import { useAppStore } from '../src/renderer/stores/appStore'
afterEach(() => { vi.unstubAllGlobals() })

it('rejects an old profile RPC completion when the new profile reuses its task ID', async () => {
  const completions: Array<(value: unknown) => void> = []
  const list = vi.fn(() => new Promise((resolve) => { completions.push(resolve) }))
  vi.stubGlobal('window', { mousse: { actions: { list } } })
  useAppStore.setState({ profileId: 'retention-profile-a' })
  const previous = readThreadActionHistory('same-task').catch((error) => error)
  useAppStore.setState({ profileId: 'retention-profile-b' })
  const current = readThreadActionHistory('same-task')
  expect(list).toHaveBeenCalledTimes(2)
  completions[0]!({ actions: [], receipts: [], journalGeneration: 1 })
  completions[1]!({ actions: [], receipts: [], journalGeneration: 2 })
  expect(await previous).toBeInstanceOf(Error)
  expect((await current).journalGeneration).toBe(2)
})
