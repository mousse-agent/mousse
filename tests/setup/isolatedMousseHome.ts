import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/** Credentials and sign-in routes a CLI reads from the environment ahead of its home. */
const CREDENTIAL_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_OAUTH_', 'CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_HOST_', 'CLAUDE_CODE_ACCOUNT_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_API_KEY_', 'AWS_', 'AZURE_', 'GCLOUD_', 'CLOUDSDK_', 'GROK_AUTH']
const CREDENTIAL_NAMES = ['GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_BASE_URL', 'ACCESS_TOKEN']
const CREDENTIAL_SUFFIXES = ['_API_KEY', '_TOKEN', '_SECRET', '_ACCESS_KEY', '_ACCESS_KEY_ID', '_SECRET_ACCESS_KEY']

function isInheritedCredential(name: string): boolean {
  const upper = name.toUpperCase()
  if (upper === 'ANTHROPIC_CONFIG_DIR') return false
  return CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))
    || CREDENTIAL_NAMES.includes(upper)
    || CREDENTIAL_SUFFIXES.some((suffix) => upper.endsWith(suffix))
}

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
  // The sign-in stores that outrank the config dir stay inside the test home too.
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = environment.CLAUDE_CONFIG_DIR
  environment.ANTHROPIC_CONFIG_DIR = join(home, 'anthropic')
  // A CLI started by a test would otherwise sign in with a token or key inherited from whatever
  // launched the test run, whatever its empty home says.
  for (const name of Object.keys(environment)) {
    if (isInheritedCredential(name)) delete environment[name]
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
