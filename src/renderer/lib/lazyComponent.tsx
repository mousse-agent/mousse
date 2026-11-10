import { Component, lazy, useReducer, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { reloadWindow } from '../services/reloadWindow'

export interface LoadFailedProps {
  /** Loads the chunk again. */
  retry: () => void
  /**
   * Present once a Retry has failed too: something the chunk imports may have failed, which only a reload of the
   * window repairs. Saves pending edits and asks before discarding unsaved ones.
   */
  reload?: () => void
}

/** What a split-out component shows when its chunk failed to load. */
export type LoadFailedView = ComponentType<LoadFailedProps>

export type PreloadableComponent<C extends ComponentType<any>> = ComponentType<ComponentProps<C>> & {
  /** Starts loading the module; the same promise serves later renders. A failed load is retried next time. */
  preload: () => Promise<unknown>
}

/** Errors from a chunk that did not load, as opposed to errors the loaded component throws. */
const loadFailures = new WeakSet<object>()
const loadFailure = (error: unknown): Error => {
  const failure = error instanceof Error ? error : new Error(String(error))
  loadFailures.add(failure)
  return failure
}

/**
 * The chunk a failed dynamic import names ("Failed to fetch dynamically imported module: <url>"), when it is one of
 * this window's own files. Chromium remembers a failed import per URL for the life of the page, so importing the
 * same specifier again fails again; the chunk's own URL with a new query is a fresh fetch.
 */
export function failedChunkUrl(error: unknown, base: string = document.baseURI): string | undefined {
  const message = error instanceof Error ? error.message : ''
  const url = message.match(/[a-z][\w+.-]*:\/\/[^\s'"]+?\.js(?=$|[\s'"?#])/gi)?.at(-1)
  if (!url) return undefined
  return url.startsWith(new URL('./', base).href) ? url : undefined
}

/** The default failed state: one short line in place of the component. */
export function LoadFailed({ retry, reload }: LoadFailedProps) {
  return (
    <div className="lazy-load-failed" role="alert">
      Couldn't load. <button type="button" className="lazy-load-failed-retry" onClick={retry}>Retry</button>
      {reload && <>{' · '}<button type="button" className="lazy-load-failed-retry" onClick={reload}>Reload window</button></>}
    </div>
  )
}

interface BoundaryProps {
  failed: LoadFailedView
  onRetry: () => void
  children: ReactNode
}

/**
 * Catches a chunk that did not load; anything else the component throws goes on to the boundaries above. A load
 * that fails again after a Retry also offers to reload the window. Only the person reloads it.
 */
class LoadBoundary extends Component<BoundaryProps, { error: unknown; retried: boolean }> {
  state: { error: unknown; retried: boolean } = { error: null, retried: false }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  render() {
    const { error, retried } = this.state
    if (error === null) return this.props.children
    if (typeof error !== 'object' || !loadFailures.has(error)) throw error
    const Failed = this.props.failed
    return <Failed
      retry={() => {
        this.props.onRetry()
        this.setState({ error: null, retried: true })
      }}
      reload={retried ? () => { void reloadWindow() } : undefined}
    />
  }
}

/**
 * A named export loaded on first render, split from the startup bundle. `preload` fetches it ahead of time so
 * opening it later does not wait. A chunk that fails to load shows `failed` (by default one "Couldn't load. Retry"
 * line) in its place instead of taking down the window; Retry runs the import again.
 *
 * React keeps a lazy component's rejection for good, so Retry swaps in a new one, for every place it is used. Only
 * Retry does: React re-renders a failed component on its own, and a new import each time could loop. A failed
 * `preload` alone leaves nothing behind; the first render imports again.
 */
export function lazyNamed<M extends { [P in K]: ComponentType<any> }, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  failed: LoadFailedView = LoadFailed
): PreloadableComponent<M[K]> {
  type Props = ComponentProps<M[K]>
  let pending: Promise<M> | undefined
  let failure: Error | undefined
  let attempt = 0
  /** After a failure: the failed chunk again under a new URL; if that is not this module (a chunk it imports
   *  failed), the original import, which shows the failure again. */
  const loadAgain = async (): Promise<M> => {
    const url = failedChunkUrl(failure)
    if (!url) return load()
    attempt += 1
    const module = await import(/* @vite-ignore */ `${url}?retry=${attempt}`) as Partial<M>
    return typeof module[name] === 'function' ? module as M : load()
  }
  const preload = (): Promise<M> => (pending ??= (failure ? loadAgain() : load()).then((module) => {
    failure = undefined
    return module
  }, (error: unknown) => {
    pending = undefined
    failure = loadFailure(error)
    throw failure
  }))
  const create = () => lazy(async () => ({ default: (await preload())[name] as ComponentType<Props> }))
  let current = create()

  function SplitComponent(props: Props) {
    const [, rerender] = useReducer((count: number) => count + 1, 0)
    const Loaded = current
    const retry = () => {
      if (Loaded === current) current = create()
      rerender()
    }
    return (
      <LoadBoundary failed={failed} onRetry={retry}>
        <Loaded {...props} />
      </LoadBoundary>
    )
  }
  SplitComponent.displayName = `Split(${String(name)})`
  return Object.assign(SplitComponent, { preload })
}

const idle = (): Promise<void> => new Promise((resolve) => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 2_000 })
  else setTimeout(resolve, 50)
})

/** How long the warm-up waits for one module before going on to the next; the slow one keeps loading. */
const PRELOAD_STEP_DEADLINE_MS = 10_000

/**
 * Loads split-out modules one at a time while the renderer is idle, after the window has painted, so the first
 * paint never waits for them and opening them later is instant. A module that has not loaded within the deadline
 * does not hold up the rest. Failures are left for the real render to retry.
 */
export function preloadWhenIdle(loaders: ReadonlyArray<() => Promise<unknown>>, deadlineMs = PRELOAD_STEP_DEADLINE_MS): Promise<void> {
  return (async () => {
    for (const load of loaders) {
      await idle()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.resolve().then(load).catch(() => undefined),
        new Promise((done) => { timer = setTimeout(done, deadlineMs) })
      ])
      clearTimeout(timer)
    }
  })()
}
