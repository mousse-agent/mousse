/**
 * Computer use: agents see and operate apps on this computer through Cua Driver (`cua-driver`, MIT,
 * https://cua.ai/docs/cua-driver), which Mousse finds or installs rather than bundles. The driver is about 65 MB a
 * platform and updates often, and on macOS its own signed app holds the Accessibility and Screen Recording grants, so a
 * copy inside Mousse would grow every download and ask for those grants again.
 *
 * Threads get it by default (Settings → Computer use can turn it off). A personal bot needs "use the computer"
 * (`BOT_COMPUTER_PERMISSION`), and a thread a bot started gets it only while that bot holds it.
 */

import { mousseServerToolOf } from './harness/mcpNames'

/** The two Mousse tools that reach the driver: list its tools, and run one. */
export const COMPUTER_TOOLS_TOOL = 'computer_tools'
export const COMPUTER_USE_TOOL = 'computer_use'
export const COMPUTER_TOOL_NAMES: readonly string[] = [COMPUTER_TOOLS_TOOL, COMPUTER_USE_TOOL]

/** Where the driver came from: the path the person chose, the PATH, or the installer's default folder. */
export type ComputerDriverSource = 'chosen' | 'path' | 'default'

/**
 * The driver as Settings shows it:
 * - `found`: it runs and said its version.
 * - `missing`: none was found (or the chosen path has none).
 * - `broken`: a file is there but did not run or say a version.
 * - `installing`: the official installer runs now.
 */
export interface ComputerUseStatus {
  state: 'found' | 'missing' | 'broken' | 'installing'
  /** Off in Settings: agents get no computer tools, whatever the driver's state. */
  enabled: boolean
  path?: string
  version?: string
  source?: ComputerDriverSource
  /** What went wrong, in one line: the driver's or the installer's error. */
  error?: string
  /** Whether this platform has a one-click install (Windows, macOS, Linux). */
  installable: boolean
  /** The command the installer runs, shown so the person can run it themselves. */
  installCommand?: string
}

export const COMPUTER_USE_METHODS = ['computerUse.status', 'computerUse.install', 'computerUse.setupRequest.get', 'computerUse.setupRequest.dismiss'] as const
export type ComputerUseMethod = (typeof COMPUTER_USE_METHODS)[number]

/**
 * The tool an agent calls when it needs computer use and it isn't set up here: it shows the person a setup card above
 * the composer and returns at once, never waiting for them. What the person does there applies from the next turn.
 */
export const COMPUTER_USE_REQUEST_TOOL = 'computer_use_request'

/** A thread's open setup card changed (asked for, dismissed, installed, enabled); carries only the thread id. */
export const COMPUTER_USE_SETUP_REQUEST_EVENT = 'computerUse.setupRequest.changed'

/** An open setup card, as `computerUse.setupRequest.get` returns it. */
export interface ComputerUseSetupRequestView {
  requestId: string
  /** The thread the card shows in: the thread that asked, or a bot's chat for any of its turns. */
  threadId: string
  /** The thread whose agent asked. */
  originThreadId: string
  /** This computer's name. */
  hostName: string
  /** Why the agent asked, as plain text, clipped. */
  reason: string
  createdAt: string
}

/** Longest `reason` a card keeps. */
export const COMPUTER_USE_REASON_MAX = 240

/**
 * What `computer_use_request` returned, as the first thing of its result: `setup_needed` (a card is shown), `ready`
 * (computer use works here) or `declined` (the person said Not now). Saved transcripts keep only this line, so a
 * window of another computer can say a past request happened without any of the call's other text.
 */
export type ComputerUseRequestOutcome = 'setup_needed' | 'ready' | 'declined'

/** Longest outcome line, marker included. */
export const COMPUTER_USE_OUTCOME_MAX = 240

const OUTCOME_LINE = /^\[computer-use:(setup_needed|ready|declined)\][^\r\n]*/

/** A host name as an outcome line carries it: one line, no colon or brackets, at most 64 characters. */
export function outcomeHostName(name: string): string {
  return name.replace(/[\r\n:[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'this computer'
}

/** `[computer-use:<outcome>] <text>`, on one line and within `COMPUTER_USE_OUTCOME_MAX`. */
export function computerUseOutcomeText(outcome: ComputerUseRequestOutcome, text: string): string {
  return `[computer-use:${outcome}] ${text.replace(/\s+/g, ' ').trim()}`.slice(0, COMPUTER_USE_OUTCOME_MAX)
}

/** The outcome line a `computer_use_request` result starts with, within bounds; undefined when it has none. */
export function extractComputerUseRequestOutcome(output: string | undefined): string | undefined {
  if (typeof output !== 'string') return undefined
  const match = OUTCOME_LINE.exec(output.trimStart())
  return match ? match[0].slice(0, COMPUTER_USE_OUTCOME_MAX) : undefined
}

/** An outcome line's outcome, and for `setup_needed` the host it names; undefined for anything else. */
export function parseComputerUseOutcome(output: string | undefined): { outcome: ComputerUseRequestOutcome; hostName?: string } | undefined {
  const line = extractComputerUseRequestOutcome(output)
  if (!line) return undefined
  const outcome = OUTCOME_LINE.exec(line)![1] as ComputerUseRequestOutcome
  const host = outcome === 'setup_needed' ? / set up on ([^:\r\n[\]]{1,64}):/.exec(line)?.[1]?.trim() : undefined
  return { outcome, ...(host ? { hostName: host } : {}) }
}

/**
 * The Mousse tool a call's name names, in any runtime's spelling (`mousseServerToolOf`: `mcp__mousse__x`, Antigravity's
 * `mcp_mousse_x`, OpenCode's `mousse_<12 hex>_x`, `mousse.x`, an ACP title `x (mousse MCP Server)`) or a bare name;
 * undefined for a relayed tool or any other name.
 */
function mousseToolName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined
  const served = mousseServerToolOf(name)
  if (served) return served.server === 'mousse' ? served.tool : undefined
  return /^[a-z][a-z0-9_]*$/.exec(name.trim())?.[0]
}

/** Whether a call named `toolName` with `input` is `computer_use_request`, directly or through a bot's `use_tool`. */
export function isComputerUseRequestCall(toolName: string | undefined, input?: unknown): boolean {
  const tool = mousseToolName(toolName)
  if (tool === COMPUTER_USE_REQUEST_TOOL) return true
  if (tool !== 'use_tool' || !input || typeof input !== 'object') return false
  const inner = (input as { tool?: unknown }).tool
  return typeof inner === 'string' && mousseToolName(inner) === COMPUTER_USE_REQUEST_TOOL
}

/** The official installers (https://cua.ai/docs/cua-driver). */
export const CUA_INSTALL_PS1 = 'https://cua.ai/driver/install.ps1'
export const CUA_INSTALL_SH = 'https://cua.ai/driver/install.sh'

/** The command that installs the driver on `platform`, as a person would type it. */
export function cuaInstallCommand(platform: NodeJS.Platform | string): string | undefined {
  if (platform === 'win32') return `irm ${CUA_INSTALL_PS1} | iex`
  if (platform === 'darwin' || platform === 'linux') return `/bin/bash -c "$(curl -fsSL ${CUA_INSTALL_SH})"`
  return undefined
}

/** Longest driver path a setting keeps. */
export const MAX_DRIVER_PATH = 1024

/** A chosen driver path as the setting keeps it: an absolute path, or nothing. */
export function normalizeDriverPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  if (!path || path.length > MAX_DRIVER_PATH || /[\0\r\n]/.test(path)) return undefined
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path) ? path : undefined
}
