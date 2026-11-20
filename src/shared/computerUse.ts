/**
 * Computer use: agents see and operate apps on this computer through Cua Driver (`cua-driver`, MIT,
 * https://cua.ai/docs/cua-driver), which Mousse finds or installs rather than bundles. The driver is about 65 MB a
 * platform and updates often, and on macOS its own signed app holds the Accessibility and Screen Recording grants, so a
 * copy inside Mousse would grow every download and ask for those grants again.
 *
 * Threads get it by default (Settings → Computer use can turn it off). A personal bot needs "use the computer"
 * (`BOT_COMPUTER_PERMISSION`), and a thread a bot started gets it only while that bot holds it.
 */

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

export const COMPUTER_USE_METHODS = ['computerUse.status', 'computerUse.install'] as const
export type ComputerUseMethod = (typeof COMPUTER_USE_METHODS)[number]

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
