/**
 * The hold rule for a bot's subagents (docs/bots.md, "Subagents of work", "How each runtime holds a subagent"): a
 * subagent is never held less tightly than its work. The work may run a subagent on another of the owner's entries, and
 * the runtimes hold a bot differently, so for the work's entry and the subagent's entry on this computer this compares,
 * power by power, what the facts the drivers and docs already hold say each runtime lets a bot's turn reach. Types and
 * pure functions only, browser-safe.
 */

/** A runtime that can hold a bot: Claude Code, Codex, Pi. */
export type BotRuntimeKind = 'claude' | 'codex' | 'pi'

/** What a provider entry's driver says about how it holds a bot's turn here (`HarnessDriver.botHold`). */
export interface BotRuntimeHold {
  runtime: BotRuntimeKind
  /**
   * Claude Code: whether its sandbox can run here now (`claudeSandboxFact`: Seatbelt on macOS; bubblewrap and socat on
   * the entry's PATH on Linux; never on Windows). A bot's Bash runs in it when it can, and outside any sandbox when not.
   */
  sandbox?: 'available' | 'missing' | 'unsupported'
  /**
   * Codex: whether its hosted web search can be switched off for a bot's turn without the web (`web_search = "disabled"`
   * in the thread's config, read on every checked version), or is offered whatever the bot holds.
   */
  hostedSearch?: 'off_without_web' | 'always'
}

/**
 * How far a bot's commands reach on a runtime, each measure ordered from tightest:
 * - `reads`: 0 the system's own folders and the bot's folders; 1 everything but the home folder; 2 everything but
 *   Mousse's own data; 3 everything the computer's user can read.
 * - `writes`: 0 the bot's folders; 1 everything but Mousse's own data; 2 everything.
 * - `network`: whether a command reaches the network.
 */
export interface BotCommandHold {
  reads: 0 | 1 | 2 | 3
  writes: 0 | 1 | 2
  network: boolean
  /** Restricted Claude Code on Linux also opens /tmp, which Codex closes. */
  sharedTemp?: boolean
}

/** No sandbox at all: what an unknown runtime is taken to be (it fails closed). */
const UNSANDBOXED: BotCommandHold = { reads: 3, writes: 2, network: true }

/**
 * How a runtime holds a bot's commands on `platform`, with or without file access (docs/bots.md, "Run commands" and
 * "File access"):
 * - Claude Code in its sandbox: without file access, on Linux only the system's folders and the bot's are readable, on
 *   macOS everything but the home folder; with it, everything but Mousse's own data, read and write. Writes otherwise
 *   only to the bot's folders, never the network. Where its sandbox can't run (Windows, or Linux without bubblewrap or
 *   socat), Bash runs outside any sandbox.
 * - Codex: without file access on Linux and macOS, Mousse's profile (the system's folders and the bot's, writes to the
 *   bot's); on Windows, and with file access everywhere, the `workspace-write` sandbox, which reads every file and writes
 *   only the bot's folders (with file access, every entry beside Mousse's own data). Never the network.
 * - Pi: `bash` runs with no sandbox anywhere.
 */
export function commandHold(hold: BotRuntimeHold | undefined, platform: string, files: boolean): BotCommandHold {
  if (!hold) return UNSANDBOXED
  if (hold.runtime === 'claude') {
    if (hold.sandbox !== 'available') return UNSANDBOXED
    if (files) return { reads: 2, writes: 1, network: false }
    return { reads: platform === 'linux' ? 0 : 1, writes: 0, network: false, ...(platform === 'linux' ? { sharedTemp: true } : {}) }
  }
  if (hold.runtime === 'codex') {
    if (files) return { reads: 3, writes: 1, network: false }
    return platform === 'linux' || platform === 'darwin' ? { reads: 0, writes: 0, network: false } : { reads: 3, writes: 0, network: false }
  }
  return UNSANDBOXED
}

/** Whether commands held by `sub` reach no further than commands held by `work`, on every measure. */
export function commandsWithin(sub: BotCommandHold, work: BotCommandHold): boolean {
  return sub.reads <= work.reads && sub.writes <= work.writes && (!sub.network || work.network) && (!sub.sharedTemp || work.sharedTemp === true || work.reads > 0)
}

/**
 * What a turn without the web still reaches of it on a runtime: nothing, or a hosted search the runtime offers whatever
 * the bot holds and no thread can switch off. With the web granted, every runtime reaches it only through Mousse's own
 * web tools and a hosted search beside them, which the grant already allows.
 */
export function webWithoutGrant(hold: BotRuntimeHold | undefined): 'none' | 'hosted' {
  if (!hold) return 'hosted'
  return hold.runtime === 'codex' && hold.hostedSearch !== 'off_without_web' ? 'hosted' : 'none'
}

/** A power the rule compares. Files, the browser, the owner's MCP tools and skills are held the same on every runtime. */
export type BotHeldPower = 'shell' | 'web' | 'files' | 'browser' | 'mcp' | 'skills'

/** What the rule decided for one power: the subagent has it as the work does, runs without it, or can't start there. */
export type BotHoldDecision = 'same' | 'withheld' | 'refused'

export interface BotSubagentHold {
  /** One decision per power the work's turn holds (and the web, which matters when it doesn't). */
  decisions: Partial<Record<BotHeldPower, BotHoldDecision>>
  /** The powers the subagent is compiled without. */
  withheld: BotHeldPower[]
  /** The power that can't be withheld on the subagent's runtime: nothing starts there. */
  refused?: BotHeldPower
}

/**
 * The rule, for one subagent: for the work's entry and the subagent's entry here, each power the work's turn holds is
 * kept when the subagent's runtime holds it at least as tightly, withheld when it holds it less tightly and can run
 * without it, and refuses the start when it can't. Commands can be withheld on every runtime (each runs with no command
 * tool). The web matters only when the work has none: a runtime whose hosted search can't be switched off refuses then.
 * Files (each runtime's gate checks every path), the browser, MCP tools and skills (Mousse's own tools on every
 * runtime) are the same everywhere. The same entry is always the same; an unknown runtime is held as tightly as nothing.
 */
export function subagentHold(input: {
  work: BotRuntimeHold | undefined
  sub: BotRuntimeHold | undefined
  sameEntry: boolean
  platform: string
  /** What the work's turn holds now. */
  holds: { shell: boolean; files: boolean; web: boolean; browser?: boolean; mcp?: boolean; skills?: boolean }
}): BotSubagentHold {
  const decisions: Partial<Record<BotHeldPower, BotHoldDecision>> = {}
  const { holds } = input
  for (const power of ['files', 'browser', 'mcp', 'skills'] as const) if (holds[power]) decisions[power] = 'same'
  if (input.sameEntry) {
    if (holds.shell) decisions.shell = 'same'
    decisions.web = 'same'
    return { decisions, withheld: [] }
  }
  if (holds.shell) {
    const within = commandsWithin(commandHold(input.sub, input.platform, holds.files), commandHold(input.work, input.platform, holds.files))
    decisions.shell = within ? 'same' : 'withheld'
  }
  decisions.web = holds.web || webWithoutGrant(input.sub) === 'none' || webWithoutGrant(input.work) === 'hosted' ? 'same' : 'refused'
  const withheld = (Object.entries(decisions) as Array<[BotHeldPower, BotHoldDecision]>).filter(([, decision]) => decision === 'withheld').map(([power]) => power)
  const refused = (Object.entries(decisions) as Array<[BotHeldPower, BotHoldDecision]>).find(([, decision]) => decision === 'refused')?.[0]
  return { decisions, withheld, ...(refused ? { refused } : {}) }
}

/** A power in the owner's words, as About and the asks name it. */
export const BOT_HELD_POWER_TEXT: Readonly<Record<BotHeldPower, string>> = {
  shell: 'run commands',
  web: 'the web',
  files: 'use files on this computer',
  browser: 'use the browser',
  mcp: 'your MCP tools',
  skills: 'skills'
}
