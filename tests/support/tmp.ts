import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * A disposable directory under the canonical temp root. The path is already resolved through
 * any symlink (macOS keeps its temp directory behind one), so ownership checks in the product
 * compare like with like. Deferred disposers run in reverse order before the files go.
 */
export interface OwnedTemp {
  readonly path: string
  /** A path inside the directory. */
  child(...parts: string[]): string
  /** Run before the directory is removed; later registrations run first. */
  defer(dispose: () => void | Promise<void>): void
  /** Dispose resources, then remove the directory. Safe to call twice. */
  close(): Promise<void>
}

export function ownedTemp(prefix: string): OwnedTemp {
  const root = realpathSync(tmpdir())
  const path = realpathSync(mkdtempSync(join(root, prefix)))
  const disposers: Array<() => void | Promise<void>> = []
  let closed = false
  return {
    path,
    child: (...parts) => join(path, ...parts),
    defer: (dispose) => {
      disposers.push(dispose)
    },
    async close() {
      if (closed) return
      closed = true
      let failure: unknown
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose()
        } catch (error) {
          failure ??= error
        }
      }
      const owned = relative(root, path)
      if (isAbsolute(owned) || owned.startsWith('..') || !basename(path).startsWith(prefix) || resolve(path) === root) {
        throw new Error(`Refusing to remove a directory outside the owned temp root: ${path}`)
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      if (failure) throw failure
    }
  }
}
