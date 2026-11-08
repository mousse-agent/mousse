/** The method a service that understands a browsed `root` also has; an older one ignores `root`. */
export const BROWSE_METHOD = 'files.drives'

export const BROWSE_NEEDS_NEWER_SERVICE =
  'The Mousse service is older than this app and cannot open folders outside the thread. Restart Mousse to update it.'

/**
 * Whether the running service accepts a browsed `root`, asked once per service instance. An older service
 * would drop `root` and answer for the thread's folder instead, so a save meant for `D:\notes\todo.md` would
 * write `todo.md` in the thread's folder.
 */
export function browseSupport(
  instanceOf: () => string | undefined,
  methodsOf: () => Promise<unknown>
): () => Promise<boolean> {
  let known: { instance: string | undefined; supported: Promise<boolean> } | undefined
  return () => {
    const instance = instanceOf()
    if (known && known.instance === instance) return known.supported
    const entry = {
      instance,
      supported: methodsOf().then(
        (result) => {
          const methods = (result as { methods?: unknown } | null)?.methods
          return Array.isArray(methods) && methods.includes(BROWSE_METHOD)
        },
        () => {
          // Not known: asked again next time.
          if (known === entry) known = undefined
          return false
        }
      )
    }
    known = entry
    return entry.supported
  }
}

/** The `root` params of a Files call: none without a root, and a refusal when the service would ignore it. */
export async function browsedRootParams(root: unknown, supported: () => Promise<boolean>): Promise<{ root?: string }> {
  if (typeof root !== 'string' || !root) return {}
  if (!(await supported())) throw new Error(BROWSE_NEEDS_NEWER_SERVICE)
  return { root }
}
