import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grokArgs } from '../acp/presets/grok'
import type { ArgumentAllowlist } from '../oneShot/launch'
import { GROK_HELD_SWITCHES } from './held'

/**
 * Grok's account route for single requests (`acp:grok`): `acpOneShot` (`drivers/acp.ts`) on its sealed launch, with
 * these preset inputs, written into the request's place:
 * - a Grok home of the request's own whose whole config is `GROK_ONE_SHOT_CONFIG`: every tool denied, nothing sent
 *   again (`models.max_retries = 0`), Grok's own session title sent to port 0 on the loopback, where nothing can
 *   receive it, and no saved answer standing in for a rule;
 * - the sign-in: `GROK_AUTH_PATH` names the entry's own `auth.json` (`grokAuthPath`), which Grok reads and refreshes in
 *   place under that file's own locks, as on the held home (#1995). Nothing is copied or linked, so a sign-in replaced
 *   on disk is the one the next request reads;
 * - every source Grok reads from Claude Code's, Cursor's and Codex's setups off (their rules too), memory and turn
 *   summaries off, no plugin, no self-update.
 * Grok still offers its own tools over ACP, and its retries are not counted here: the route is best-effort
 * (`GROK_ACP_FACTS`), and a tool it reports ends the request (`AcpSessions.oneShot`).
 */

/** The one-shot home's whole `config.toml`. */
export const GROK_ONE_SHOT_CONFIG = [
  '# Written by Mousse for one request with no tools.',
  '[permission]',
  'rules = [ { action = "deny", tool = "any" } ]',
  '',
  '[models]',
  'max_retries = 0',
  'session_summary = "mousse-no-title"',
  '',
  '# Grok names its own session from the prompt: that request is sent to port 0, where nothing can receive it.',
  '[model.mousse-no-title]',
  'model = "none"',
  'base_url = "http://127.0.0.1:0/v1"',
  'api_key = "mousse-none"',
  '',
  '[features]',
  'worktree_inherits_main_approvals = false',
  '',
  '[ui]',
  'remember_tool_approvals = false',
  ''
].join('\n')

/** Grok's switches for what it reads from other agents' setups: every one off in a single request, their rules too. */
const IMPORT_SWITCHES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  ['CLAUDE', 'CURSOR', 'CODEX'].flatMap((agent) => ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'].map((kind) => [`GROK_${agent}_${kind}_ENABLED`, '0']))
))

/**
 * The preset inputs of one request (`AcpRuntimeHooks.oneShot.inputs`): its Grok home, written under `root` (the place's
 * folder for inputs), and the variables that point Grok at it and at the entry's own sign-in (`authPath`).
 */
export function grokOneShotInputs(root: string, authPath: string): Record<string, string> {
  const home = join(root, 'grok-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'config.toml'), GROK_ONE_SHOT_CONFIG, { mode: 0o600 })
  return {
    ...GROK_HELD_SWITCHES,
    ...IMPORT_SWITCHES,
    GROK_HOME: home,
    GROK_AUTH_PATH: authPath,
    GROK_WORKTREE_INHERITS_MAIN_APPROVALS: 'false',
    GROK_MEMORY: '0',
    GROK_TURN_SUMMARY: '0'
  }
}

/** A single request's arguments are the preset's own: the entry's are never passed on. */
export const GROK_ONE_SHOT_ARGUMENTS: ArgumentAllowlist = () => grokArgs()
