import type { ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessAppError } from '../../../shared/harness/types'
import { withUserEnv } from '../cliConfig'
import { grokHeldEnv } from './held'

/**
 * Grok's one-shot route (a chat title, a branch name, a pull request draft, a commit message, a bot's name or digest):
 * one headless `grok` run with no tools, on a home of the request's own. Proven per version and platform by the held
 * check (`heldCheck.ts`), against a stub model:
 * - one model request: `models.max_retries = 0` (a 429, 503 or 401 is not sent again), `--max-turns 1` (a tool call
 *   ends the run instead of asking the model again), turn summaries off, and Grok's own session title sent to a model
 *   at port 0 on the loopback: Grok still tries that request, but nothing can listen there, so it is never delivered
 *   (the check also watches, through a proxy, that nothing else is sent anywhere);
 * - no tools: every built-in the version offers is disallowed (the check records their names), web search and
 *   subagents are off, and a deny rule for every tool stops any that is left;
 * - only Mousse's text: Mousse's system prompt replaces Grok's, the prompt is sent as written, memory is off, nothing
 *   is read from Claude Code, Cursor or Codex, and the person's home is an empty folder, so no skill or setting of
 *   theirs loads. What stays is Grok's own fixed preamble (the platform, the date, and rules built into Grok).
 * The sign-in is the entry's own (`grokHeldEnv`), read in place.
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
  '[ui]',
  'remember_tool_approvals = false',
  ''
].join('\n')

/**
 * Grok's built-in tools as of 1.0.92, disallowed on every one-shot. A version that offers another is caught by its
 * check (the stub sees a tool in the request), and its names are added from the check's record (`GrokHeldRecord.tools`).
 */
export const GROK_KNOWN_TOOLS: readonly string[] = Object.freeze([
  'run_terminal_command', 'read_file', 'search_replace', 'write', 'list_dir', 'grep', 'kill_command_or_subagent', 'todo_write',
  'get_command_or_subagent_output', 'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'web_search', 'x_search', 'web_fetch'
])

/** Grok's switches for what it reads from other agents' setups; every one is off in a one-shot. */
const IMPORT_SWITCHES = ['CLAUDE', 'CURSOR', 'CODEX'].flatMap((agent) => ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'].map((kind) => `GROK_${agent}_${kind}_ENABLED`))

export interface GrokOneShotFiles {
  /** The request's own folder: its home, an empty person's home, an empty working folder, and the prompt. */
  root: string
  system: string
  prompt: string
}

/** Writes the request's folder and returns where each part is. */
export function writeGrokOneShotFiles(files: GrokOneShotFiles): { home: string; user: string; cwd: string; system: string; promptFile: string } {
  const home = join(files.root, 'home')
  const user = join(files.root, 'user')
  const cwd = join(files.root, 'cwd')
  for (const dir of [home, user, cwd]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'config.toml'), GROK_ONE_SHOT_CONFIG, { mode: 0o600 })
  const promptFile = join(files.root, 'prompt.txt')
  writeFileSync(promptFile, files.prompt, { mode: 0o600 })
  return { home, user, cwd, system: files.system, promptFile }
}

/** The arguments after the program's own: one headless request with no tools. */
export function grokOneShotArgs(input: { system: string; promptFile: string; model?: string; effort?: string; tools?: readonly string[] }): string[] {
  const tools = [...new Set([...GROK_KNOWN_TOOLS, ...(input.tools ?? [])])]
  return [
    '--prompt-file', input.promptFile,
    // On the command line: `--system-prompt-file` and `--no-memory` are newer than 1.0.89 (`GROK_MEMORY=0` turns memory off).
    '--system-prompt-override', input.system,
    '--verbatim',
    '--output-format', 'json',
    '--no-subagents',
    '--disable-web-search',
    '--max-turns', '1',
    '--disallowed-tools', tools.join(','),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--reasoning-effort', input.effort] : [])
  ]
}

/** The one-shot's environment: the held one (the entry's sign-in read in place) on the request's own home. */
export function grokOneShotEnv(env: NodeJS.ProcessEnv, paths: { home: string; user: string }, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const held = grokHeldEnv(env, paths.home, platform)
  return withUserEnv(held, {
    HOME: paths.user,
    USERPROFILE: paths.user,
    GROK_MEMORY: '0',
    GROK_TURN_SUMMARY: '0',
    GROK_DISABLE_AUTOUPDATER: '1',
    ...Object.fromEntries(IMPORT_SWITCHES.map((name) => [name, '0']))
  }, platform)
}

/** What a headless run printed, read as the answer or as the reason it has none. */
export function grokOneShotResult(label: string, run: { code: number | null; stdout: string; stderr: string }): string {
  let parsed: Record<string, unknown> | undefined
  const out = run.stdout.trim()
  try {
    const value = JSON.parse(out.slice(out.indexOf('{'))) as unknown
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    // Not JSON: read as an error below.
  }
  if (parsed && typeof parsed.text === 'string' && parsed.stopReason === 'end_turn' && run.code === 0) return parsed.text
  if (parsed?.stopReason === 'max_turn_requests')
    throw harnessAppError({ code: 'one_shot_tool_refused', message: `${label} tried to use a tool in a request that runs none, so Mousse stopped it.` })
  const message = typeof parsed?.message === 'string' ? parsed.message : run.stderr.trim().split('\n').filter(Boolean).pop() ?? `${label} exited with code ${run.code}.`
  if (/\b429\b|rate.?limit/i.test(message)) throw harnessAppError({ code: 'rate_limited', message: `${label} is rate limited: ${message}` })
  if (/\b401\b|unauthori[sz]ed|not signed in|authentication required/i.test(message)) throw harnessAppError({ code: 'signed_out', message: `${label} answered that this request is not signed in.` })
  if (/\b50[23]\b|unavailable|overloaded/i.test(message)) throw harnessAppError({ code: 'service_unavailable', message: `${label}: ${message}` })
  throw harnessAppError({ code: 'protocol', message: `${label} did not answer: ${message}` })
}

/** Reads a child's output to its end; `signal` ends its tree. */
export function collectRun(child: ChildProcess, signal: AbortSignal, kill: () => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const abort = () => kill()
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr })
    })
  })
}
