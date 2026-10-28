import { createRequire } from 'node:module'

/**
 * `ssh2` is loaded the first time an editor connects, not when the daemon starts, so a computer that never
 * carries an editor connection pays nothing for it. It is a CommonJS package, so it is required (a named import
 * fails under Node's own ESM loader). Its optional native add-ons are not built or shipped: without them it
 * uses Node's own crypto.
 */
let loaded: typeof import('ssh2') | undefined

export function ssh2(): typeof import('ssh2') {
  return (loaded ??= createRequire(import.meta.url)('ssh2') as typeof import('ssh2'))
}
