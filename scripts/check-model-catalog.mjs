#!/usr/bin/env node
// Developer check of the model catalog's Claude models on this machine's signed-in Claude Code
// (docs/providers/model-catalog.md, "Changing the file"). Run it on your own machine, never in CI,
// and paste its output into a PR that adds or retires a Claude model.
//
//   node scripts/check-model-catalog.mjs [--claude <path to the Claude Code program>]
//
// It starts one idle Claude Code query, sends no prompt, and switches it to each catalog model with a
// `claude` route, newest first. Each prints as runs, refused, remapped or unknown. It never signs in:
// when Claude Code is not signed in, every model comes out unknown or refused.
//
// The outcome rules mirror claudeOlderModelCheck (src/mms/harness/vendors/claude/
// ClaudeSubscriptionProviderService.ts). That module cannot load here without bundling, so the rules
// are copied below; change both together.
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** How long one `setModel` or `get_settings` call may take before the model counts as unknown. */
const CALL_MS = 15_000

// Copied from ClaudeSubscriptionProviderService.ts.
const REFUSED_MODEL = /model not changed|unknown provider for model/i
const PASSING_FAILURE = /\b(?:408|429|5\d\d)\b|time(?:d)? ?out|network|ECONN|ETIMEDOUT|ENOTFOUND|overloaded/i
const CLAUDE_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION'
]
const bareModelId = (id) => id.replace(/\[[^\]]*\]$/, '')

/** `claude` on PATH or in `~/.local/bin`, as the service looks for it (a Windows `.cmd` shim needs --claude). */
function claudeOnPath() {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const directory of [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined
}

function parseArgs(argv) {
  if (argv.length === 0) return {}
  if (argv[0] === '--claude' && argv[1] && argv.length === 2) return { claude: resolve(argv[1]) }
  throw new Error('Usage: node scripts/check-model-catalog.mjs [--claude <path to the Claude Code program>]')
}

/** The catalog's `claude` routes, newest `released` first (ties keep file order). */
function candidates() {
  const catalog = JSON.parse(readFileSync(join(root, 'src/mms/models/models.json'), 'utf8'))
  return catalog.models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => model.routes?.claude?.id)
    .sort((a, b) => b.model.released.localeCompare(a.model.released) || a.index - b.index)
    .map(({ model }) => ({ name: model.name, routeId: model.routes.claude.id }))
}

/** Rejects when `pending` takes longer than CALL_MS. */
function bounded(pending) {
  let timer
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), CALL_MS)
    })
  ]).finally(() => clearTimeout(timer))
}

/** One candidate's outcome, by claudeOlderModelCheck's rules. */
async function check(q, routeId) {
  try {
    await bounded(q.setModel(routeId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (REFUSED_MODEL.test(message) && !PASSING_FAILURE.test(message)) return { outcome: 'refused' }
    return { outcome: 'unknown', detail: message.slice(0, 120) }
  }
  let applied
  try {
    applied = (await bounded(q.getSettings()))?.applied
  } catch (error) {
    return { outcome: 'unknown', detail: `get_settings: ${String(error?.message ?? error).slice(0, 120)}` }
  }
  if (typeof applied?.model !== 'string' || !applied.model) return { outcome: 'unknown', detail: 'no applied model reported' }
  if (bareModelId(applied.model) !== routeId) return { outcome: 'remapped', detail: `to ${applied.model}` }
  return { outcome: 'runs', ...(typeof applied.effort === 'string' ? { detail: `default effort ${applied.effort}` } : {}) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const claude = options.claude ?? claudeOnPath()
  if (!claude) throw new Error('Claude Code was not found on PATH or in ~/.local/bin. Pass --claude <path>.')
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', ...CLAUDE_SESSION_MARKERS]) delete env[key]
  // A folder of its own, so no project's settings or CLAUDE.md load.
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-model-catalog-check-'))
  const controller = new AbortController()
  // Streaming input stays empty: the query initializes and switches models, and never gets a prompt.
  const idle = async function* () {
    await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true }))
  }
  const q = query({
    prompt: idle(),
    options: {
      pathToClaudeCodeExecutable: claude,
      cwd,
      env,
      abortController: controller,
      tools: [],
      canUseTool: async () => ({ behavior: 'deny', message: 'The model catalog check cannot run tools' })
    }
  })
  const counts = { runs: 0, refused: 0, remapped: 0, unknown: 0 }
  try {
    if (typeof q.getSettings !== 'function') throw new Error('This Claude Agent SDK has no getSettings; no model can be checked.')
    const listed = await bounded(q.supportedModels())
    const live = new Set(listed.flatMap((model) => [model.value, model.resolvedModel].filter(Boolean).map(bareModelId)))
    console.log(`Claude Code: ${claude}`)
    console.log(`Listed live: ${listed.map((model) => (model.resolvedModel ? `${model.value} (${model.resolvedModel})` : model.value)).join(', ')}`)
    console.log('')
    for (const { name, routeId } of candidates()) {
      const result = await check(q, routeId)
      counts[result.outcome]++
      const listedNote = live.has(routeId) ? ', listed live' : ''
      console.log(`${result.outcome.padEnd(8)} ${routeId} (${name}${listedNote})${result.detail ? `: ${result.detail}` : ''}`)
    }
    console.log('')
    console.log(Object.entries(counts).map(([outcome, count]) => `${count} ${outcome}`).join(', '))
  } finally {
    controller.abort()
    q.close()
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows may still hold the folder for the exiting process; it is in the temp folder.
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
)
