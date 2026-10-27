import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/** Own only this disposable Mousse home; never change the OS user's home. */
export function createIsolatedMousseHome(environment: NodeJS.ProcessEnv) {
  const temporaryRoot = realpathSync(tmpdir())
  const home = mkdtempSync(join(temporaryRoot, 'mousse-vitest-'))
  // Even an inherited MOUSSE_HOME could refer to a developer's installation.
  // Tests can explicitly select their own fixtures after this setup runs.
  environment.MOUSSE_HOME = home
  // The default profile reuses the terminal CLI sign-ins; point each CLI at an empty home so
  // tests never see or change the developer's accounts.
  // Codex refuses a CODEX_HOME that doesn't exist, so each home is created empty.
  const cliHomes = {
    CLAUDE_CONFIG_DIR: 'claude-cli-config',
    CODEX_HOME: 'codex-cli-home',
    GROK_HOME: 'grok-cli-home',
    GEMINI_HOME: 'gemini-cli-home',
    PI_CODING_AGENT_DIR: 'pi-agent-dir'
  }
  for (const [variable, folder] of Object.entries(cliHomes)) {
    environment[variable] = join(home, folder)
    mkdirSync(environment[variable]!, { recursive: true })
  }
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
