import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/** Own only this disposable Mousse home; never change the OS user's home. */
export function createIsolatedMousseHome(environment: NodeJS.ProcessEnv) {
  const temporaryRoot = realpathSync(tmpdir())
  const home = mkdtempSync(join(temporaryRoot, 'mousse-vitest-'))
  // Even an inherited MOUSSE_HOME could refer to a developer's installation.
  // Tests can explicitly select their own fixtures after this setup runs.
  environment.MOUSSE_HOME = home
  return {
    home,
    ensureDefault() {
      if (!environment.MOUSSE_HOME) environment.MOUSSE_HOME = home
    },
    cleanup() {
      const owned = relative(temporaryRoot, realpathSync(home))
      if (isAbsolute(owned) || owned.startsWith('..') || !owned.startsWith('mousse-vitest-') || owned.includes('/') || owned.includes('\\')) {
        throw new Error('Refusing to clean up an unexpected Vitest home')
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
