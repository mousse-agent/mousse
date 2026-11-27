import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withUserEnv } from '../cliConfig'
import { grokHome } from './credential'

/**
 * Grok's held launch: every Grok process of a turn, a model listing or a check runs on a home Mousse owns, whose
 * `config.toml` makes Grok ask Mousse before any tool. Grok merges permission rules from every source by severity
 * (deny, then ask, then allow), so an ask rule for every tool outranks the allow rules it also loads from Claude Code's
 * settings and from the project. A saved "always allow" answer would still stand in for asking; with
 * `remember_tool_approvals` off it does not, and a worktree does not take its main checkout's answers either.
 * Proven against the real Grok per version and platform (`heldCheck.ts`), never assumed.
 *
 * The sign-in stays where it is: `GROK_AUTH_PATH` points Grok at the entry's own `auth.json`, which it reads and
 * refreshes in place under that file's own locks, the same ones the user's own Grok takes. No copy is made, so no
 * copy can refresh and leave the real one behind.
 */

/** The held home's whole `config.toml`; Mousse writes it and nothing else goes in. */
export const GROK_HELD_CONFIG = [
  '# Written by Mousse. Every tool asks Mousse first, and no saved answer stands in for asking.',
  '[permission]',
  'rules = [ { action = "ask", tool = "any" } ]',
  '',
  '[features]',
  'worktree_inherits_main_approvals = false',
  '',
  '[ui]',
  'remember_tool_approvals = false',
  ''
].join('\n')

/** Variables the held launch sets itself, and the overlays that could set Grok's config around its home. */
const HELD_REPLACED = ['GROK_HOME', 'GROK_AUTH_PATH', 'GROK_WORKTREE_INHERITS_MAIN_APPROVALS', 'GROK_CONFIG', 'GROK_CONFIG_PATH']

/** Where an entry's held home lives: in its own state folder. */
export function grokHeldHome(stateDir: string): string {
  return join(stateDir, 'held-home')
}

/** Writes the held home's config when it is not exactly Mousse's (a missing file, or one Grok or a person changed). */
export function ensureGrokHeldHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'config.toml')
  let current: string | undefined
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // Not written yet.
  }
  if (current !== GROK_HELD_CONFIG) writeFileSync(path, GROK_HELD_CONFIG, { mode: 0o600 })
}

/**
 * The environment of a held Grok process: the entry's own (its key, its variables), with the held home in place of its
 * home, the sign-in read from the entry's own home, and no config overlay. `env` is the environment the entry's native
 * launch would have: its `GROK_HOME`, when set, names the home the sign-in is in.
 */
export function grokHeldEnv(env: NodeJS.ProcessEnv, heldHome: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const home = variable(env, 'GROK_HOME')
  const authPath = variable(env, 'GROK_AUTH_PATH') ?? join(grokHome(home ? { GROK_HOME: home } : {}), 'auth.json')
  const held: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(held)) if (HELD_REPLACED.includes(platform === 'win32' ? name.toUpperCase() : name)) delete held[name]
  return withUserEnv(held, { GROK_HOME: heldHome, GROK_AUTH_PATH: authPath, GROK_WORKTREE_INHERITS_MAIN_APPROVALS: 'false' }, platform)
}

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name && value?.trim()) return value.trim()
  return undefined
}
