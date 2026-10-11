import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readAppletAppearance,
  subscribeAppletAppearance
} from '../src/renderer/components/applets/appearance'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})
function environment() {
  const root = { dataset: { theme: 'dark' } }
  const body = {}
  const values: Record<string, string> = {
    '--surface-base': '#111122',
    '--surface-strong': '#222233',
    '--surface-soft': '#333344',
    '--bg-primary': 'rgba(1,2,3,.3)',
    '--bg-secondary': 'var(--glass-bg-strong)',
    '--bg-tertiary': 'rgba(4,5,6,.3)',
    '--accent': 'var(--accent-hover)',
    '--accent-hover': '#aa88cc',
    '--glass-bg': 'rgba(1,2,3,.3)',
    '--text-primary': '#eeeeee'
  }
  const queries = new Map<
    string,
    {
      matches: boolean
      addEventListener: ReturnType<typeof vi.fn>
      removeEventListener: ReturnType<typeof vi.fn>
    }
  >()
  const frames: Array<() => void> = []
  let mutation: () => void = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('document', { documentElement: root, body })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => values[name] ?? '',
    fontFamily: '"Mousse Font", sans-serif',
    fontSize: '15px'
  }))
  vi.stubGlobal('matchMedia', (query: string) => {
    let value = queries.get(query)
    if (!value) {
      value = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      queries.set(query, value)
    }
    return value
  })
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        mutation = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return { root, values, queries, frames, change: () => mutation(), disconnect }
}
describe('applet renderer appearance', () => {
  it('inherits actual font and whitelisted colors, resolves variables and makes acrylic backgrounds solid', () => {
    environment()
    const appearance = readAppletAppearance()
    expect(appearance.fontFamily).toBe('"Mousse Font", sans-serif')
    expect(appearance.fontSize).toBe('15px')
    expect(appearance.tokens['--accent']).toBe('#aa88cc')
    expect(appearance.tokens['--bg-primary']).toBe('#111122')
    expect(appearance.tokens['--bg-secondary']).toBe('#222233')
    expect(appearance.tokens['--bg-tertiary']).toBe('#333344')
    expect(appearance.tokens).not.toHaveProperty('--glass-bg')
  })
  it('updates subscribers without runtime recreation and deduplicates unchanged mutations', () => {
    const env = environment()
    const changes = vi.fn()
    const unsubscribe = subscribeAppletAppearance(changes)
    cleanups.push(unsubscribe)
    expect(changes).toHaveBeenCalledTimes(1)
    env.change()
    env.frames.shift()!()
    expect(changes).toHaveBeenCalledTimes(1)
    env.root.dataset.theme = 'light'
    env.values['--text-primary'] = '#111111'
    env.change()
    env.frames.shift()!()
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'light',
        colorScheme: 'light',
        tokens: expect.objectContaining({ '--text-primary': '#111111' })
      })
    )
    unsubscribe()
    cleanups.pop()
    expect(env.disconnect).toHaveBeenCalledTimes(1)
    for (const query of env.queries.values())
      expect(query.removeEventListener).toHaveBeenCalledTimes(1)
  })
  it('tracks system scheme and reduced motion media changes', () => {
    const env = environment()
    env.root.dataset.theme = 'system'
    const changes = vi.fn()
    cleanups.push(subscribeAppletAppearance(changes))
    const scheme = env.queries.get('(prefers-color-scheme: light)')!
    scheme.matches = true
    const motion = env.queries.get('(prefers-reduced-motion: reduce)')!
    motion.matches = true
    scheme.addEventListener.mock.calls[0][1]()
    env.frames.shift()!()
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({ colorScheme: 'light', reducedMotion: true })
    )
  })
})
