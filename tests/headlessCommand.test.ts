import { describe, expect, it } from 'vitest'
import {
  appendInteractivePermissionFlags,
  mergeHeadlessPermissionArgs
} from '../src/mms/macros/agentPermissionFlags'
import {
  buildHeadlessShellCommand,
  isHeadlessEnabledForAgent,
  resolveHeadlessConfig,
  shellQuote
} from '../src/mms/macros/headlessCommand'

describe('headlessCommand', () => {
  it('quotes prompts for shell execution', () => {
    const quoted = shellQuote("it's fine")
    if (process.platform === 'win32') {
      expect(quoted).toBe("'it''s fine'")
    } else {
      expect(quoted).toBe("'it\\'s fine'")
    }
  })

  it('builds claude-code headless command with model', () => {
    const headless = resolveHeadlessConfig('claude-code')
    const command = buildHeadlessShellCommand(
      'claude-code',
      'Implement login form',
      headless,
      'sonnet'
    )
    expect(command).toContain('claude')
    expect(command).toContain('--model')
    expect(command).toContain('sonnet')
    expect(command).toContain('-p')
    expect(command).toContain('Implement login form')
  })

  it('builds codex exec headless command with model flag', () => {
    const headless = resolveHeadlessConfig('codex')
    const command = buildHeadlessShellCommand('codex', 'Write tests', headless, 'o3')
    expect(command).toContain('codex')
    expect(command).toContain('-m')
    expect(command).toContain('o3')
    expect(command).toContain('exec')
    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(command).toContain('Write tests')
  })

  it('builds opencode run headless command', () => {
    const headless = resolveHeadlessConfig('opencode')
    const command = buildHeadlessShellCommand(
      'opencode',
      'Fix bug',
      headless,
      'openrouter/anthropic/claude-sonnet-4'
    )
    expect(command).toContain('opencode run')
    expect(command).toContain('--dangerously-skip-permissions')
    expect(command).toContain('-m')
    expect(command).toContain('Fix bug')
  })

  it('builds cursor-agents-cli headless command', () => {
    const headless = resolveHeadlessConfig('cursor-agents-cli')
    const command = buildHeadlessShellCommand(
      'cursor-agents-cli',
      'Review changes',
      headless,
      'composer-2.5'
    )
    expect(command).toContain('cursor-agent')
    expect(command).toContain('-p')
    expect(command).toContain('--force')
    expect(command).toContain('composer-2.5')
    expect(command).toContain('Review changes')
  })

  it('defaults headless enabled per agent type', () => {
    expect(isHeadlessEnabledForAgent('claude-code', undefined)).toBe(true)
    expect(isHeadlessEnabledForAgent('codex', { codex: false } as never)).toBe(false)
  })

  it('appends interactive permission bypass flags', () => {
    expect(appendInteractivePermissionFlags('claude', 'claude-code')).toContain(
      '--dangerously-skip-permissions'
    )
    expect(appendInteractivePermissionFlags('codex', 'codex')).toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    )
    expect(appendInteractivePermissionFlags('opencode', 'opencode')).toContain(
      '--dangerously-skip-permissions'
    )
    expect(appendInteractivePermissionFlags('cursor-agent', 'cursor-agents-cli')).toContain('--force')
  })

  it('merges headless permission bypass flags without duplicates', () => {
    const merged = mergeHeadlessPermissionArgs('claude-code', ['-p', '--dangerously-skip-permissions'])
    expect(merged.filter((arg) => arg === '--dangerously-skip-permissions')).toHaveLength(1)
  })
})
