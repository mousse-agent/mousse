import { COMPUTER_TOOLS_TOOL, COMPUTER_USE_REASON_MAX, COMPUTER_USE_REQUEST_TOOL, COMPUTER_USE_TOOL, extractComputerUseRequestOutcome } from './computerUse'
import { mousseServerToolOf } from './harness/mcpNames'

/**
 * What a transcript keeps of a computer use call (`computer_tools`, `computer_use`, `computer_use_request`, directly or
 * through a bot's `use_tool`). The model gets the driver's whole result; a saved row keeps only what this allowlist
 * lets through, because a call's arguments and results can carry what the agent typed, a clipboard, a script or its
 * output. Every runtime's tool events go through it when they are saved (`createRuntimeToolMapper`, Pi's engine), and
 * the renderer applies it again to rows saved before it existed.
 *
 * A `use_tool` call whose inner tool is not known yet (its arguments have not arrived, or name nothing) keeps nothing
 * but a neutral title, until they say which tool it runs.
 */

export const USE_TOOL = 'use_tool'

export type CuaTool = typeof COMPUTER_TOOLS_TOOL | typeof COMPUTER_USE_TOOL | typeof COMPUTER_USE_REQUEST_TOOL

const CUA_TOOLS: ReadonlySet<string> = new Set([COMPUTER_TOOLS_TOOL, COMPUTER_USE_TOOL, COMPUTER_USE_REQUEST_TOOL])

export function isCuaTool(name: unknown): name is CuaTool {
  return typeof name === 'string' && CUA_TOOLS.has(name)
}

/**
 * How a call reads for the transcript:
 * - `cua`: a computer use tool called directly.
 * - `use_tool_pending`: a bot's `use_tool` whose inner tool is not known (yet).
 * - `use_tool_cua`: a `use_tool` that runs a computer use tool.
 * - `use_tool_other`: a `use_tool` that runs any other tool (`inner`).
 * - `other`: anything else.
 */
export type CuaCall =
  | { kind: 'cua'; tool: CuaTool }
  | { kind: 'use_tool_pending' }
  | { kind: 'use_tool_cua'; tool: CuaTool }
  | { kind: 'use_tool_other'; inner: string }
  | { kind: 'other' }

/** A call whose row keeps only what this module allows. */
export function isGuardedCall(call: CuaCall): call is Extract<CuaCall, { kind: 'cua' | 'use_tool_pending' | 'use_tool_cua' }> {
  return call.kind === 'cua' || call.kind === 'use_tool_pending' || call.kind === 'use_tool_cua'
}

/**
 * The Mousse tool a call's name names, in any runtime's spelling (`mousseServerToolOf`: `mcp__mousse__x`,
 * Antigravity's `mcp_mousse_x`, OpenCode's `mousse_<12 hex>_x`, `mousse.x`, `x (mousse MCP Server)`...) or as a bare snake-case name (Pi, Cursor
 * without a server); undefined for a relayed tool or any other name.
 */
export function mousseToolOfName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  const served = mousseServerToolOf(trimmed)
  if (served) return served.server === 'mousse' ? served.tool : undefined
  return /^[a-z][a-z0-9_]*$/.test(trimmed) ? trimmed : undefined
}

/** Longest inner tool name a row keeps. */
const TARGET_CHARS = 120

/**
 * A `use_tool` call's `tool` as the registry reads it (`useToolCall`: trimmed, without `mcp__mousse__`), with any other
 * spelling of a Mousse tool read as that tool; undefined when it names nothing.
 */
export function normalizeUseToolTarget(tool: unknown): string | undefined {
  if (typeof tool !== 'string') return undefined
  const name = tool.trim().replace(/^mcp__mousse__/, '')
  if (!name) return undefined
  return (mousseToolOfName(name) ?? name).slice(0, TARGET_CHARS)
}

/**
 * The tool a `use_tool` call's arguments name, or undefined when the registry would refuse them: `tool` missing, not a
 * string or empty, or `arguments` given but not an object.
 */
export function useToolTargetOf(args: unknown): string | undefined {
  const call = record(args)
  if (!call) return undefined
  const given = call.arguments ?? {}
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return undefined
  return normalizeUseToolTarget(call.tool)
}

/**
 * How a call named `toolName` reads, given its arguments (`input`) or the inner tool its runtime already read
 * (`useToolTarget`). Either naming a computer use tool is enough to treat the call as one.
 */
export function classifyCuaCall(toolName: unknown, hints: { input?: unknown; useToolTarget?: unknown } = {}): CuaCall {
  const tool = mousseToolOfName(toolName)
  if (isCuaTool(tool)) return { kind: 'cua', tool }
  if (tool !== USE_TOOL) return { kind: 'other' }
  const targets = [normalizeUseToolTarget(hints.useToolTarget), useToolTargetOf(hints.input)].filter((target): target is string => Boolean(target))
  const cua = targets.find(isCuaTool)
  if (cua) return { kind: 'use_tool_cua', tool: cua }
  return targets[0] ? { kind: 'use_tool_other', inner: targets[0] } : { kind: 'use_tool_pending' }
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

const TOOL_CHARS = 80
const SHORT_CHARS = 60
const STEP_TOOLS = 10

/** Driver arguments a row keeps as numbers: where and how long, never what. */
const NUMBER_KEYS = [
  'x', 'y', 'fromX', 'fromY', 'toX', 'toY', 'startX', 'startY', 'endX', 'endY', 'width', 'height',
  'dx', 'dy', 'deltaX', 'deltaY', 'clicks', 'count', 'delayMs', 'durationMs', 'timeoutMs'
] as const

/** Driver arguments a row keeps as short words: which button, window or key, never text to type. */
const SHORT_KEYS = [
  'button', 'direction', 'app', 'window', 'windowTitle', 'title', 'monitor', 'display', 'key', 'keys', 'shortcut',
  'modifiers', 'format', 'quality'
] as const

function short(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return text || undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A driver tool's arguments, held to the allowlist; `steps` (`run_steps`) become how many and which tools. */
function sanitizeDriverArgs(args: unknown): Record<string, unknown> {
  const source = record(args)
  if (!source) return {}
  const out: Record<string, unknown> = {}
  for (const key of NUMBER_KEYS) {
    const value = finite(source[key])
    if (value !== undefined) out[key] = value
  }
  for (const key of SHORT_KEYS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string') {
      const text = short(value, SHORT_CHARS)
      if (text) out[key] = text
    } else if (Array.isArray(value)) {
      const words = value.slice(0, STEP_TOOLS).map((item) => short(item, SHORT_CHARS)).filter((item): item is string => Boolean(item))
      if (words.length) out[key] = words
    }
  }
  const steps = Array.isArray(source.steps) ? source.steps : undefined
  if (steps) {
    out.stepCount = steps.length
    const tools = steps.slice(0, STEP_TOOLS).map((step) => short(record(step)?.tool ?? record(step)?.name, TOOL_CHARS)).filter((tool): tool is string => Boolean(tool))
    if (tools.length) out.stepTools = tools
  } else {
    // Already held to the allowlist (a saved row read again).
    const stepCount = finite(source.stepCount)
    if (stepCount !== undefined && Number.isInteger(stepCount) && stepCount >= 0) out.stepCount = stepCount
    const tools = Array.isArray(source.stepTools) ? source.stepTools.slice(0, STEP_TOOLS).map((tool) => short(tool, TOOL_CHARS)).filter((tool): tool is string => Boolean(tool)) : []
    if (tools.length) out.stepTools = tools
  }
  return out
}

/** A computer use call's arguments as a row keeps them. */
export function sanitizeCuaInput(tool: CuaTool, input: unknown): Record<string, unknown> {
  const args = record(input) ?? {}
  switch (tool) {
    case COMPUTER_TOOLS_TOOL: {
      const name = short(args.tool, TOOL_CHARS)
      return name ? { tool: name } : {}
    }
    case COMPUTER_USE_REQUEST_TOOL: {
      const reason = short(args.reason, COMPUTER_USE_REASON_MAX)
      return reason ? { reason } : {}
    }
    case COMPUTER_USE_TOOL: {
      const name = short(args.tool, TOOL_CHARS)
      const kept = sanitizeDriverArgs(args.arguments)
      return { ...(name ? { tool: name } : {}), ...(Object.keys(kept).length ? { arguments: kept } : {}) }
    }
  }
}

/** A call's arguments as its row keeps them: held to the allowlist, or nothing for a `use_tool` not yet resolved. */
export function guardedInput(call: CuaCall, input: unknown): Record<string, unknown> | undefined {
  switch (call.kind) {
    case 'cua':
      return sanitizeCuaInput(call.tool, input)
    case 'use_tool_cua':
      return { tool: call.tool, arguments: sanitizeCuaInput(call.tool, record(input)?.arguments) }
    case 'use_tool_pending':
      return undefined
    default:
      return record(input)
  }
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export const CUA_FAILED = 'Computer action failed'

/** Mousse's own failure texts, each kept as a fixed label; anything else reads `CUA_FAILED`. */
const FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Computer use is off/i, 'Computer use is off'],
  [/not available in this Mousse/i, 'Computer use is not available'],
  [/Cua Driver is not installed/i, 'Driver not installed'],
  [/Cua Driver is being installed/i, 'Driver is being installed'],
  [/Cua Driver didn'?t start/i, "Driver didn't start"],
  [/Cua Driver stopped during/i, 'Driver stopped during the action'],
  [/may not use the computer/i, 'Not allowed in this thread'],
  [/timed out|timeout/i, 'Action timed out'],
  [/^\s*\{\s*"refused"\s*:/, 'Computer action refused']
]

const LABELS: ReadonlySet<string> = new Set([CUA_FAILED, ...FAILURES.map(([, label]) => label)])

/** A failed computer use call's result as a row keeps it: a fixed label, never the text. */
export function cuaFailureLabel(text: unknown): string {
  if (typeof text !== 'string') return CUA_FAILED
  const trimmed = text.trim()
  if (LABELS.has(trimmed)) return trimmed
  return FAILURES.find(([pattern]) => pattern.test(trimmed))?.[1] ?? CUA_FAILED
}

/** Longest `computer_tools` summary. */
const TOOLS_SUMMARY_CHARS = 300

function toolsSummary(text: string): string {
  const names = [...text.matchAll(/^- ([A-Za-z0-9_.-]{1,60}):/gm)].map((match) => match[1]!)
  if (names.length) {
    let line = `Listed ${names.length} tool${names.length === 1 ? '' : 's'}: `
    let shown = 0
    for (const name of names) {
      const next = `${shown ? ', ' : ''}${name}`
      if (line.length + next.length + 2 > TOOLS_SUMMARY_CHARS) break
      line += next
      shown += 1
    }
    return shown < names.length ? `${line}, …` : line
  }
  const trimmed = text.trim()
  if (trimmed.length <= TOOLS_SUMMARY_CHARS && /^Listed \d+ tools?(?:: [A-Za-z0-9_.-]+(?:, [A-Za-z0-9_.-]+)*(?:, …)?)?$/.test(trimmed)) return trimmed
  if (/^Described [A-Za-z0-9_.-]{1,60}$/.test(trimmed)) return trimmed
  const described = /^([A-Za-z0-9_.-]{1,60})\r?\n[\s\S]*Input schema:/.exec(trimmed)
  return described ? `Described ${described[1]}` : 'Completed'
}

function useSummary(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return /^Captured (?:screenshot|\d{1,3} images)$/.test(trimmed) ? trimmed : 'Completed'
}

/** A computer use call's result as a row keeps it; `failed` keeps only a fixed label. */
export function sanitizeCuaOutput(tool: CuaTool, output: unknown, failed = false): string | undefined {
  if (failed) return cuaFailureLabel(output)
  if (typeof output !== 'string') return undefined
  switch (tool) {
    case COMPUTER_USE_REQUEST_TOOL:
      return extractComputerUseRequestOutcome(output)
    case COMPUTER_TOOLS_TOOL:
      return output.trim() ? toolsSummary(output) : undefined
    case COMPUTER_USE_TOOL:
      return useSummary(output)
  }
}

/** A call's result as its row keeps it: held to the allowlist, nothing for a `use_tool` not yet resolved. */
export function guardedOutput(call: CuaCall, output: unknown, failed = false): string | undefined {
  switch (call.kind) {
    case 'cua':
    case 'use_tool_cua':
      return sanitizeCuaOutput(call.tool, output, failed)
    case 'use_tool_pending':
      return undefined
    default:
      return typeof output === 'string' ? output : undefined
  }
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** The title a guarded call's row gets in place of its runtime's. */
export function guardedTitle(call: CuaCall, input?: unknown): string {
  switch (call.kind) {
    case 'use_tool_pending':
      return 'Using tool'
    case 'cua':
    case 'use_tool_cua': {
      if (call.tool === COMPUTER_TOOLS_TOOL) return 'Computer: list tools'
      if (call.tool === COMPUTER_USE_REQUEST_TOOL) return 'Ask to set up computer use'
      const args = call.kind === 'use_tool_cua' ? record(record(input)?.arguments) : record(input)
      const action = short(args?.tool, TOOL_CHARS)
      return action ? `Computer: ${action}` : 'Using the computer'
    }
    default:
      return ''
  }
}

/** A driver tool's name in words: `mouse_click` reads "Mouse click", `getWindowState` "Get window state". */
export function humanizeCuaAction(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/** The one detail a row shows of a driver call: how many steps, where, which app, or which key. */
function actionDetail(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const steps = finite(args.stepCount)
  if (steps !== undefined) return `${steps} step${steps === 1 ? '' : 's'}`
  const x = finite(args.x)
  const y = finite(args.y)
  if (x !== undefined && y !== undefined) return `(${x}, ${y})`
  const app = short(args.app, SHORT_CHARS)
  if (app) return app
  for (const key of ['key', 'keys', 'shortcut'] as const) {
    const value = args[key]
    if (typeof value === 'string' && short(value, SHORT_CHARS)) return short(value, SHORT_CHARS)
    if (Array.isArray(value)) {
      const words = value.map((item) => short(item, SHORT_CHARS)).filter(Boolean)
      if (words.length) return words.join('+')
    }
  }
  return undefined
}

/**
 * What a computer use row says, from its kept arguments: the driver tool in words (`computer_use`) and one detail.
 * Empty when the row recorded no action (a row saved before arguments were kept): it then says only that it used the
 * computer, never a guessed action.
 */
export function cuaCallWords(tool: CuaTool, input: unknown): { action?: string; detail?: string } {
  const args = record(input)
  if (tool === COMPUTER_TOOLS_TOOL) {
    const name = short(args?.tool, TOOL_CHARS)
    return name ? { detail: name } : {}
  }
  if (tool !== COMPUTER_USE_TOOL) return {}
  const name = short(args?.tool, TOOL_CHARS)
  const action = name ? humanizeCuaAction(name) : undefined
  const detail = actionDetail(record(args?.arguments))
  return { ...(action ? { action } : {}), ...(detail ? { detail } : {}) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
