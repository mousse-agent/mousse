import type { CliType } from '../../shared/types'

/** Flags appended to interactive CLI commands (PTY spawn). */
export const INTERACTIVE_PERMISSION_BYPASS_ARGS: Record<CliType, string[]> = {
  mousse: [],
  'claude-code': ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  opencode: ['--dangerously-skip-permissions'],
  'cursor-agents-cli': ['--trust', '--force']
}

/** Flags merged into headless subcommand args (after exec/run/-p). */
export const HEADLESS_PERMISSION_BYPASS_ARGS: Record<CliType, string[]> = {
  mousse: [],
  'claude-code': ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  opencode: ['--dangerously-skip-permissions'],
  'cursor-agents-cli': ['--force']
}

export function appendInteractivePermissionFlags(baseCommand: string, cliType: CliType): string {
  const flags = INTERACTIVE_PERMISSION_BYPASS_ARGS[cliType]
  if (!flags.length) return baseCommand
  const missing = flags.filter((flag) => !baseCommand.includes(flag))
  if (missing.length === 0) return baseCommand
  return `${baseCommand} ${missing.join(' ')}`
}

export function mergeHeadlessPermissionArgs(cliType: CliType, args: string[]): string[] {
  const flags = HEADLESS_PERMISSION_BYPASS_ARGS[cliType]
  const merged = [...args]
  for (const flag of flags) {
    if (!merged.includes(flag)) {
      merged.push(flag)
    }
  }
  return merged
}
