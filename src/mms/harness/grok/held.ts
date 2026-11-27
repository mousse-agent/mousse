import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withUserEnv } from '../cliConfig'
import { grokHome, grokSystemDir } from './credential'

/**
 * Grok's held launch: every Grok process of a turn, a model listing or a check runs on a home Mousse owns, whose
 * `config.toml` makes Grok ask Mousse before any tool. Grok merges permission rules from every source by severity
 * (deny, then ask, then allow), so an ask rule for every tool outranks the allow rules it also loads from Claude Code's
 * settings and from the project. A saved "always allow" answer would still stand in for asking; with
 * `remember_tool_approvals` off it does not, and a worktree does not take its main checkout's answers either.
 *
 * What starts without a tool call is closed too: the hooks, MCP servers, agents and skills Grok would read from Claude
 * Code, Cursor and Codex are switched off (`GROK_HELD_SWITCHES`); no folder is trusted in the held home, so a project's
 * own hooks and MCP servers never load; no plugin is kept there. Organisation policy (a `requirements.toml` or
 * `managed_config.toml` in the system folder or the held home, or macOS device management) can add hooks and MCP
 * servers Mousse cannot turn off: then the held launch is refused, with that file named (`grokHeldPolicyProblem`).
 * Proven against the real Grok per version and platform (`heldCheck.ts`), never assumed.
 *
 * The sign-in stays where it is: `GROK_AUTH_PATH` points Grok at the entry's own `auth.json`, which it reads and
 * refreshes in place under that file's own locks, the same ones the user's own Grok takes. No copy is made.
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

/**
 * Grok's switches for what it reads from other agents' setups, all off in a held launch but their rules (instruction
 * text): their hooks run commands, their MCP servers start programs, and agents and skills can carry hooks of their
 * own. Official plugins are not installed into the held home, and Grok does not update itself from there.
 */
export const GROK_HELD_SWITCHES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(['CLAUDE', 'CURSOR', 'CODEX'].flatMap((agent) => ['SKILLS', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'].map((kind) => [`GROK_${agent}_${kind}_ENABLED`, '0']))),
  GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER: '0',
  GROK_DISABLE_AUTOUPDATER: '1'
})

/** Variables the held launch sets itself, and the overlays that could set Grok's config around its home. */
const HELD_REPLACED = ['GROK_HOME', 'GROK_AUTH_PATH', 'GROK_WORKTREE_INHERITS_MAIN_APPROVALS', 'GROK_CONFIG', 'GROK_CONFIG_PATH', ...Object.keys(GROK_HELD_SWITCHES)]

/** Files that carry an organisation's policy, in the system folder and in a Grok home. */
const POLICY_FILES = ['requirements.toml', 'managed_config.toml']

/** Where an entry's held home lives: in its own state folder. */
export function grokHeldHome(stateDir: string): string {
  return join(stateDir, 'held-home')
}

/**
 * Makes the held home exactly Mousse's: its `config.toml` (written back when missing or changed), and no folder trust,
 * hooks folder or plugin. Throws when the config cannot be made Mousse's: no held process starts on another one.
 */
export function ensureGrokHeldHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'config.toml')
  const read = () => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
  if (read() !== GROK_HELD_CONFIG) writeFileSync(path, GROK_HELD_CONFIG, { mode: 0o600 })
  if (read() !== GROK_HELD_CONFIG) throw new Error('Mousse could not write the config of Grok’s held home.')
  for (const name of ['trusted_folders.toml', 'hooks']) rmSync(join(home, name), { recursive: true, force: true })
  const plugins = join(home, 'installed-plugins')
  if (existsSync(plugins)) for (const entry of readdirSync(plugins)) if (entry !== 'registry.lock') rmSync(join(plugins, entry), { recursive: true, force: true })
}

/**
 * Why no held launch can run here: an organisation's policy file Grok would read, in the system folder, in the held
 * home (a signed copy Grok may fetch for an organisation's account), or in macOS device management. Undefined when
 * there is none.
 */
export function grokHeldPolicyProblem(heldHome: string, options: { systemDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const systemDir = options.systemDir ?? grokSystemDir(platform, options.env ?? process.env)
  const found = [
    ...POLICY_FILES.map((name) => join(systemDir, name)),
    ...POLICY_FILES.map((name) => join(heldHome, name)),
    ...(platform === 'darwin' && !options.systemDir ? ['/Library/Managed Preferences/ai.x.grok.plist'] : [])
  ].find((path) => existsSync(path))
  return found ? `Grok reads an organisation policy at ${found}, which can add hooks or MCP servers Mousse cannot turn off, so Mousse does not run Grok on a home that asks before every tool.` : undefined
}

/**
 * The environment of a held Grok process: the entry's own (its key, its variables), with the held home in place of its
 * home, the sign-in read from the entry's own home, every startup source switched off, and no config overlay. `env` is
 * the environment the entry's native launch would have: its `GROK_HOME`, when set, names the home the sign-in is in.
 */
export function grokHeldEnv(env: NodeJS.ProcessEnv, heldHome: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const home = variable(env, 'GROK_HOME')
  const authPath = variable(env, 'GROK_AUTH_PATH') ?? join(grokHome(home ? { GROK_HOME: home } : {}), 'auth.json')
  const held: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(held)) if (HELD_REPLACED.includes(platform === 'win32' ? name.toUpperCase() : name)) delete held[name]
  return withUserEnv(held, { ...GROK_HELD_SWITCHES, GROK_HOME: heldHome, GROK_AUTH_PATH: authPath, GROK_WORKTREE_INHERITS_MAIN_APPROVALS: 'false' }, platform)
}

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name && value?.trim()) return value.trim()
  return undefined
}
