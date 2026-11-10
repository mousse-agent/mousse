import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export type PreloadableComponent<C extends ComponentType<any>> = LazyExoticComponent<C> & {
  /** Starts loading the module; the same promise serves later renders. */
  preload: () => Promise<unknown>
}

/**
 * A named export loaded on first render, split from the startup bundle. `preload` fetches it ahead of time so
 * opening it later does not wait. A failed load is not cached: the next render or preload tries again.
 */
export function lazyNamed<M extends { [P in K]: ComponentType<any> }, K extends keyof M>(
  load: () => Promise<M>,
  name: K
): PreloadableComponent<M[K]> {
  let pending: Promise<M> | undefined
  const preload = (): Promise<M> => (pending ??= load().catch((error: unknown) => {
    pending = undefined
    throw error
  }))
  const component = lazy(async () => ({ default: (await preload())[name] }))
  return Object.assign(component, { preload })
}

const idle = (): Promise<void> => new Promise((resolve) => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 2_000 })
  else setTimeout(resolve, 50)
})

/**
 * Loads split-out modules one at a time while the renderer is idle, after the window has painted, so the first
 * paint never waits for them and opening them later is instant. Failures are left for the real render to retry.
 */
export function preloadWhenIdle(loaders: ReadonlyArray<() => Promise<unknown>>): void {
  void (async () => {
    for (const load of loaders) {
      await idle()
      await load().catch(() => undefined)
    }
  })()
}
