import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageAgentId } from '../../shared/usageHistory'

/** One model call found in an agent's log. */
export interface LogRecord {
  ts: number
  model: string
  session: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** The same call copied into several files (a resumed or forked session) shares its key. */
  key: string
  /** The cost the agent itself logged, when it logs one. */
  costUsd?: number
  /** Fast or standard mode, when the log says which. */
  speed?: 'fast' | 'standard'
  /** The folder the agent worked in, when the log says. */
  cwd?: string
}

/**
 * Reads one JSONL log line by line. Only lines holding one of `markers` are decoded, so the
 * large lines (tool output, file contents) are skipped without parsing. `state` carries what
 * earlier lines said (a session id, the current model) and is saved with the cache, so an
 * appended file resumes where it stopped.
 */
export interface LineParser<S = unknown> {
  markers: readonly string[]
  initial(): S
  parse(line: string, state: S, path: string): LogRecord[] | LogRecord | null
}

export interface LogSource {
  agent: UsageAgentId
  /** Folders to look in, first the configured ones. */
  roots(): string[]
  /** Which files under a root are this agent's logs. */
  accepts(path: string): boolean
  parser: LineParser<any>
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const tsOf = (value: unknown): number => {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(str(value))
  return Number.isFinite(parsed) ? parsed : 0
}
const speedOf = (value: unknown): 'fast' | 'standard' | undefined => (value === 'fast' ? 'fast' : value === 'standard' ? 'standard' : undefined)
const list = (value: string | undefined): string[] => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : [])
/**
 * `MOUSSE_USAGE_LOG_HOME` reads the logs under another home folder only (a test or a sandbox);
 * otherwise each agent's own folder setting comes first, then its default under the user's home.
 */
const env = (name: string): string[] => (process.env.MOUSSE_USAGE_LOG_HOME ? [] : list(process.env[name]))
const home = () => process.env.MOUSSE_USAGE_LOG_HOME || homedir()
const sep = /[\\/]/

/** Claude Code: one line per content block of an assistant message, each repeating its usage. */
const claudeParser: LineParser<Record<string, never>> = {
  markers: ['"usage"'],
  initial: () => ({}),
  parse(line) {
    const entry = JSON.parse(line)
    if (entry?.type !== 'assistant') return null
    const message = entry.message
    const usage = message?.usage
    const model = str(message?.model)
    if (!usage || !model || model === '<synthetic>') return null
    const ts = tsOf(entry.timestamp)
    if (!ts) return null
    const id = str(message.id) || str(entry.uuid)
    return {
      ts, model, session: str(entry.sessionId),
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      key: `c:${id}`,
      ...(num(entry.costUSD) ? { costUsd: num(entry.costUSD) } : {}),
      ...(speedOf(usage.speed) ? { speed: speedOf(usage.speed)! } : {}),
      ...(str(entry.cwd) ? { cwd: str(entry.cwd) } : {})
    }
  }
}

interface CodexState { session: string; model: string; total: number; tier?: string; cwd?: string }

/**
 * Codex: `token_count` events carry the last request's usage and the session's running total. The
 * model comes from the latest `turn_context`, the speed from the latest applied thread settings (`priority` is
 * fast mode). A repeated running total is the same event again.
 */
const codexParser: LineParser<CodexState> = {
  markers: ['"session_meta"', '"turn_context"', '"token_count"', '"thread_settings_applied"'],
  initial: () => ({ session: '', model: '', total: -1 }),
  parse(line, state) {
    const entry = JSON.parse(line)
    const payload = entry?.payload
    if (entry?.type === 'session_meta') {
      if (!state.session) state.session = str(payload?.id) || str(payload?.session_id)
      if (str(payload?.cwd)) state.cwd = str(payload.cwd)
      return null
    }
    if (entry?.type === 'turn_context') {
      if (str(payload?.model)) state.model = str(payload.model)
      if (str(payload?.cwd)) state.cwd = str(payload.cwd)
      return null
    }
    if (payload?.type === 'thread_settings_applied') {
      const tier = str(payload.thread_settings?.service_tier)
      if (tier) state.tier = tier
      return null
    }
    if (payload?.type !== 'token_count' || !payload.info) return null
    const last = payload.info.last_token_usage
    const total = num(payload.info.total_token_usage?.total_tokens)
    if (!last || !state.model) return null
    if (total && total === state.total) return null
    state.total = total
    const cached = num(last.cached_input_tokens)
    const cacheWrite = num(last.cache_write_input_tokens)
    const input = Math.max(0, num(last.input_tokens) - cached - cacheWrite)
    const output = num(last.output_tokens)
    if (input + cached + cacheWrite + output === 0) return null
    const ts = tsOf(entry.timestamp)
    if (!ts) return null
    // A forked session copies its parent's events with their times: the time and counts match.
    const speed = state.tier === 'priority' ? 'fast' as const : state.tier ? 'standard' as const : undefined
    return { ts, model: state.model, session: state.session, input, cacheRead: cached, cacheWrite, output, key: `x:${ts}:${num(last.input_tokens)}:${output}`, ...(speed ? { speed } : {}), ...(state.cwd ? { cwd: state.cwd } : {}) }
  }
}

/** Grok: one `turn_completed` update per prompt, with usage per model and its own cost. */
const grokParser: LineParser<Record<string, never>> = {
  markers: ['"turn_completed"'],
  initial: () => ({}),
  parse(line) {
    const entry = JSON.parse(line)
    const update = entry?.params?.update
    if (update?.sessionUpdate !== 'turn_completed' || !update.usage) return null
    const ts = tsOf(entry.params?._meta?.agentTimestampMs ?? entry.timestamp)
    if (!ts) return null
    const session = str(entry.params.sessionId)
    const byModel: Record<string, any> = update.usage.modelUsage ?? { grok: update.usage }
    return Object.entries(byModel).map(([model, usage]) => {
      const cacheRead = num(usage.cachedReadTokens)
      const cacheWrite = num(usage.cacheCreationTokens)
      return {
        ts, model, session,
        input: Math.max(0, num(usage.inputTokens) - cacheRead - cacheWrite),
        cacheRead, cacheWrite,
        output: num(usage.outputTokens),
        key: `g:${session}:${str(update.prompt_id)}:${model}`,
        ...(num(usage.costUsdTicks) ? { costUsd: num(usage.costUsdTicks) / 1e10 } : {})
      }
    })
  }
}

/** Pi: a `session` header, then assistant `message` entries carrying usage and often a cost. */
const piParser: LineParser<{ session: string; cwd?: string }> = {
  markers: ['"usage"', '"type":"session"'],
  initial: () => ({ session: '' }),
  parse(line, state) {
    const entry = JSON.parse(line)
    if (entry?.type === 'session') { state.session = str(entry.id); if (str(entry.cwd)) state.cwd = str(entry.cwd); return null }
    const message = entry?.message
    const usage = message?.usage
    if (entry?.type !== 'message' || message?.role !== 'assistant' || !usage) return null
    const ts = tsOf(entry.timestamp ?? message.timestamp)
    const model = str(message.responseModel) || str(message.model)
    if (!ts || !model) return null
    return {
      ts, model, session: state.session,
      input: num(usage.input), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), output: num(usage.output),
      key: `p:${str(entry.id)}:${ts}:${model}`,
      ...(state.cwd ? { cwd: state.cwd } : {}),
      ...(num(usage.cost?.total) ? { costUsd: num(usage.cost.total) } : {})
    }
  }
}

/**
 * Antigravity (`agy` CLI and Mousse's isolated `agy acp` homes): `PLANNER_RESPONSE` steps carry
 * `model`, uncached `input_tokens`, `cache_read_tokens` and `output_tokens`; `CHECKPOINT`
 * compaction steps omit `model` and reuse the session's latest model.
 */
const antigravityParser: LineParser<{ model: string }> = {
  markers: ['"input_tokens"', '"output_tokens"'],
  initial: () => ({ model: '' }),
  parse(line, state, path) {
    const entry = JSON.parse(line)
    const ts = tsOf(entry?.created_at)
    if (!ts) return null
    const loggedModel = str(entry.model)
    if (loggedModel) state.model = loggedModel
    const model = loggedModel || state.model
    if (!model) return null
    const input = num(entry.input_tokens)
    const cacheRead = num(entry.cache_read_tokens)
    const cacheWrite = num(entry.cache_write_tokens ?? entry.cache_creation_tokens)
    const output = num(entry.output_tokens)
    if (input + cacheRead + cacheWrite + output === 0) return null
    const parts = path.split(sep)
    const session = parts.length >= 4 ? parts[parts.length - 4]! : ''
    const step = typeof entry.step_index === 'number' && Number.isFinite(entry.step_index) ? entry.step_index : null
    const key = step !== null ? `a:${session}:${step}` : `a:${session}:${ts}:${input}:${output}`
    return { ts, model, session, input, cacheRead, cacheWrite, output, key }
  }
}

function antigravityBrainDirs(geminiDir: string): string[] {
  return [
    join(geminiDir, 'antigravity-cli', 'brain'),
    join(geminiDir, 'antigravity', 'brain'),
    join(geminiDir, 'antigravity-acp', 'brain')
  ]
}

/** A profile's Antigravity entries: the first one's folder, and each added entry's own home (`harness/antigravity_<slug>/home`). */
function profileAntigravityBrains(profileHome: string): string[] {
  const brains = [join(profileHome, 'providers', 'antigravity', 'gemini-home', 'antigravity-acp', 'brain')]
  try {
    const harnessDir = join(profileHome, 'harness')
    for (const entry of readdirSync(harnessDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('antigravity_')) continue
      brains.push(join(harnessDir, entry.name, 'home', 'gemini-home', 'antigravity-acp', 'brain'))
    }
  } catch {
    // No added entries.
  }
  return brains
}

function mousseAntigravityBrains(): string[] {
  const brains: string[] = []
  for (const mousseDir of [...env('MOUSSE_HOME'), join(home(), '.mousse')]) {
    brains.push(...profileAntigravityBrains(mousseDir))
    try {
      const profilesDir = join(mousseDir, 'profiles')
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        brains.push(...profileAntigravityBrains(join(profilesDir, entry.name)))
      }
    } catch {
      // No profiles folder yet.
    }
  }
  return brains
}

export const LOG_SOURCES: readonly LogSource[] = [
  {
    agent: 'claude-code',
    roots: () => [...env('CLAUDE_CONFIG_DIR'), join(home(), '.claude')].map((dir) => join(dir, 'projects')),
    accepts: (path) => path.endsWith('.jsonl'),
    parser: claudeParser
  },
  {
    agent: 'codex',
    // Archived sessions keep their logs in a folder of their own.
    roots: () => [...env('CODEX_HOME'), join(home(), '.codex')].flatMap((dir) => [join(dir, 'sessions'), join(dir, 'archived_sessions')]),
    accepts: (path) => path.endsWith('.jsonl'),
    parser: codexParser
  },
  {
    agent: 'grok',
    roots: () => [...env('GROK_HOME'), join(home(), '.grok')].map((dir) => join(dir, 'sessions')),
    accepts: (path) => path.split(sep).pop() === 'updates.jsonl',
    parser: grokParser
  },
  {
    agent: 'pi',
    roots: () => [
      ...env('PI_CODING_AGENT_SESSION_DIR'),
      ...env('PI_CODING_AGENT_DIR').map((dir) => join(dir, 'sessions')),
      join(home(), '.pi', 'agent', 'sessions')
    ],
    accepts: (path) => path.endsWith('.jsonl'),
    parser: piParser
  },
  {
    agent: 'antigravity',
    roots: () => [
      ...env('GEMINI_HOME').flatMap(antigravityBrainDirs),
      ...antigravityBrainDirs(join(home(), '.gemini')),
      ...mousseAntigravityBrains()
    ],
    accepts: (path) => {
      const parts = path.split(sep)
      return parts.length >= 4 && parts[parts.length - 1] === 'transcript.jsonl' && parts[parts.length - 2] === 'logs' && parts[parts.length - 3] === '.system_generated'
    },
    parser: antigravityParser
  }
]

/** OpenCode keeps its messages in a SQLite database instead of log files. */
export function openCodeRoots(): string[] {
  const xdg = process.env.MOUSSE_USAGE_LOG_HOME ? undefined : process.env.XDG_DATA_HOME
  return [...env('OPENCODE_DATA_DIR'), ...(xdg ? [join(xdg, 'opencode')] : []), join(home(), '.local', 'share', 'opencode')]
}
