import type { CliType, MacroHeadlessConfig } from '../../shared/types'
import type { AgentTypeId } from '../../shared/settings'
import { mergeHeadlessPermissionArgs } from './agentPermissionFlags'

export const DEFAULT_HEADLESS_CONFIGS: Record<CliType, MacroHeadlessConfig> = {
  mousse: {
    command: '',
    args: [],
    appendPrompt: false
  },
  'claude-code': {
    command: 'claude',
    args: ['-p', '--dangerously-skip-permissions'],
    appendPrompt: true
  },
  codex: {
    command: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
    appendPrompt: true
  },
  opencode: {
    command: 'opencode',
    args: ['run', '--dangerously-skip-permissions'],
    appendPrompt: true
  },
  'cursor-agents-cli': {
    command: 'cursor-agent',
    args: ['-p', '--force'],
    appendPrompt: true
  }
}

export function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function buildHeadlessShellCommand(
  cliType: CliType,
  prompt: string,
  headless: MacroHeadlessConfig,
  model: string
): string {
  const trimmedModel = model.trim()
  const args = mergeHeadlessPermissionArgs(cliType, headless.args)
  const parts: string[] = []

  if (cliType === 'codex') {
    parts.push(headless.command)
    if (trimmedModel) {
      parts.push('-m', shellQuote(trimmedModel))
    }
    parts.push(...args)
  } else if (cliType === 'opencode') {
    parts.push(headless.command, ...args)
    if (trimmedModel) {
      parts.push('-m', shellQuote(trimmedModel))
    }
  } else {
    parts.push(headless.command)
    if (trimmedModel) {
      parts.push('--model', shellQuote(trimmedModel))
    }
    parts.push(...args)
  }

  if (headless.appendPrompt !== false) {
    parts.push(shellQuote(prompt))
  }

  return parts.join(' ')
}

export function resolveHeadlessConfig(
  cliType: CliType,
  config?: MacroHeadlessConfig
): MacroHeadlessConfig {
  return config ?? DEFAULT_HEADLESS_CONFIGS[cliType]
}

export function isHeadlessEnabledForAgent(
  cliType: AgentTypeId,
  headlessSettings: Record<AgentTypeId, boolean> | undefined
): boolean {
  if (cliType === 'mousse') return false
  return headlessSettings?.[cliType] ?? true
}
