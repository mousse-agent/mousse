import type { BotComputerLimit } from '../../settings'
import type { BotManifest } from './definition'
import type { BotAskRequest } from './escalation'
import { BOT_BROWSER_PERMISSION, BOT_THREADS_PERMISSION, botGrantTool } from './manifest'

/**
 * What bots may do on this computer (Settings → Agents → What bots may do here, `settings.bots.here`, kept once for the
 * installation): a ceiling over every bot's grant, in every profile, set on the computer it protects. A switch that is
 * off takes its permission out of what every bot runs with here (`withinComputerLimit`), whatever its grant holds; the
 * grant itself is kept, so switching it on again gives it back with no new ask. Browser-safe.
 */

export type { BotComputerLimit }

/**
 * One switch: "Run commands" (`shell`), "Use files on this computer" (`files`), "Use the browser" (`browser`), "Use your
 * threads" (`threads`).
 */
export type BotComputerSwitch = keyof BotComputerLimit

/** Every switch on: what a computer allows until its owner changes it. */
export const BOT_COMPUTER_OPEN: Readonly<BotComputerLimit> = Object.freeze({ shell: true, files: true, browser: true, threads: true })

/** Every switch off: what a bot gets here when the setting can't be read. */
export const BOT_COMPUTER_SHUT: Readonly<BotComputerLimit> = Object.freeze({ shell: false, files: false, browser: false, threads: false })

/** Each switch in the owner's words, as an ask card and About name the permission. */
export const BOT_COMPUTER_SWITCH_TITLES: Readonly<Record<BotComputerSwitch, string>> = Object.freeze({
  shell: 'run commands',
  files: 'use files on this computer',
  browser: 'use the browser',
  threads: 'use your threads'
})

/** The short mark About shows beside a permission the bot holds that this computer has switched off. */
export const BOT_OFF_HERE_MARK = 'Off on this computer'

/** What About's tooltip says about such a permission. */
export const BOT_OFF_HERE_NOTE = 'Switched off in Settings → Agents → What bots may do here, so it gives nothing on this computer. Switch it on there to use it again.'

/** About's tooltip for file access switched off while commands are on: a command may still read files, by runtime. */
export const BOT_OFF_HERE_FILES_NOTE = 'Switched off in Settings → Agents → What bots may do here. Its commands may still read files on this computer while Run commands is on, depending on where it runs; switch that off too to stop them.'

/** What About's tooltip says about a permission this computer has switched off (`which`), under `limit`. */
export function offHereNote(which: BotComputerSwitch, limit: BotComputerLimit): string {
  return which === 'files' && limit.shell ? BOT_OFF_HERE_FILES_NOTE : BOT_OFF_HERE_NOTE
}

/**
 * What a bot is told it may ask for, after an ask it wrote wrongly: never file access while this computer has files
 * switched off.
 */
export function whatToAskText(limit: BotComputerLimit): string {
  const kinds = ['a tool', ...(limit.files ? ['file access (any full folder path)'] : []), 'a skill', "the tools of one of your owner's MCP servers", 'a limit']
  return `Ask for ${kinds.join(', ')}, or to export your memory.`
}

/**
 * What a bot is told when it calls or asks for something this computer has switched off: no card is made, and asking
 * again would not help.
 */
export function notOnThisComputerText(off: BotComputerSwitch): string {
  return `Not on this computer: "${BOT_COMPUTER_SWITCH_TITLES[off]}" is switched off here, so you can't use it or ask for it. Don't ask the owner for it. Carry on without it and say what you skipped.`
}

/** The switches' titles as a list in quotes: `"run commands" and "use files on this computer"`. */
function quotedTitles(switches: readonly BotComputerSwitch[]): string {
  const titles = switches.map((which) => `"${BOT_COMPUTER_SWITCH_TITLES[which]}"`)
  return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0] ?? ''
}

/**
 * The bot's chat line when a turn that started with what this computer has just switched off (`switches`) is stopped
 * (`BotEngine.cutForLimit`). It says only what is true when it is posted: the turn stopped, and why. Whether the work
 * goes on in a new turn (it may not: its time may be up) is shown by the work itself.
 */
export function stoppedForLimitText(switches: readonly BotComputerSwitch[]): string {
  return `Stopped: ${quotedTitles(switches)} ${switches.length > 1 ? 'were' : 'was'} switched off on this computer.`
}

/** What the turn that goes on after such a stop is told first. */
export function limitCutLead(switches: readonly BotComputerSwitch[]): string {
  return `${quotedTitles(switches)} ${switches.length > 1 ? 'were' : 'was'} switched off on this computer while you worked, so Mousse stopped your turn; you no longer have ${switches.length > 1 ? 'them' : 'it'} here. Don't ask the owner for ${switches.length > 1 ? 'them' : 'it'}.`
}

/**
 * The switch a permission falls under: file access (any folder) is `files`, commands `shell`, the browser or any one of
 * its tools `browser`. Undefined for everything else (the web, skills, MCP tools, limits), which no switch covers.
 */
export function computerSwitchOf(permission: BotAskRequest | { tool: string }): BotComputerSwitch | undefined {
  if ('path' in permission) return 'files'
  if (!('tool' in permission) || typeof permission.tool !== 'string') return undefined
  const tool = botGrantTool(permission.tool)
  if (tool === 'shell') return 'shell'
  if (tool === BOT_BROWSER_PERMISSION) return 'browser'
  if (tool === BOT_THREADS_PERMISSION) return 'threads'
  return undefined
}

/** The switch `permission` falls under when this computer has it off; undefined when it is on, or none covers it. */
export function switchedOff(limit: BotComputerLimit, permission: BotAskRequest | { tool: string }): BotComputerSwitch | undefined {
  const which = computerSwitchOf(permission)
  return which && !limit[which] ? which : undefined
}

/**
 * `manifest` with what this computer has switched off taken out: commands (`shell`, wherever the grant keeps it),
 * file access (the workspace; the bot's files folder and scratch are not file access and stay), the browser (the
 * permission and any of its tools) and the owner's threads (the permission and any of their tools). The same object when
 * every switch is on.
 */
export function withinComputerLimit(manifest: BotManifest, limit: BotComputerLimit): BotManifest {
  if (limit.shell && limit.files && limit.browser && limit.threads) return manifest
  const kept = (tool: string) => {
    const grant = botGrantTool(tool)
    return !(grant === 'shell' && !limit.shell) && !(grant === BOT_BROWSER_PERMISSION && !limit.browser) && !(grant === BOT_THREADS_PERMISSION && !limit.threads)
  }
  return {
    ...manifest,
    tools: manifest.tools.filter(kept),
    appTools: manifest.appTools.filter(kept),
    workspace: limit.files ? manifest.workspace : null
  }
}
