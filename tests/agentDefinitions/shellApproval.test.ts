import { describe, expect, it } from 'vitest'
import {
  approvalTooLongReason,
  authorizeTrustedToolDispatch,
  definitionRunUnattended,
  isShellTool,
  prepareTrustedToolDispatch,
  SHELL_APPROVAL_UNAVAILABLE,
  UNATTENDED_SHELL_REFUSAL
} from '../../src/mms/agentDefinitions/runtimePolicy'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'

// #299: where the platform's shell is not contained, a definition's shell command asks a person
// first (bound to the exact command) and an unattended run runs none. Who watches a run fails
// closed: only a host that marks the run attended is watched.

const root = process.cwd()

function policy(overrides: Partial<AgentRuntimePolicy> = {}): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1',
    source: 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [root] },
    script: { enabled: true, allowFilesystem: true, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: [],
    ...overrides
  }
}

const grants: EffectiveAgentGrants = { skills: [], mcpTools: [], builtinTools: [{ id: 'bash', source: 'explicit' }], denied: [] }
const call = (runPolicy: AgentRuntimePolicy, uncontainedShell?: boolean) =>
  prepareTrustedToolDispatch({ policy: runPolicy, grants, toolName: 'bash', args: { command: 'npm test' }, isMcp: false, projectPath: root, ...(uncontainedShell ? { uncontainedShell } : {}) })

describe('who watches a definition run', () => {
  it('only a host that marks the run attended is watched; schedules, channels and workflows never are', () => {
    expect(definitionRunUnattended('editor', { attended: true })).toBe(false)
    expect(definitionRunUnattended('chat', { attended: true })).toBe(false)
    // A host without the mark (a workflow node from the CLI, a bridge dispatch, any later host) is unattended.
    for (const source of ['editor', 'chat', 'cli'] as const) {
      expect(definitionRunUnattended(source), source).toBe(true)
      expect(definitionRunUnattended(source, {}), source).toBe(true)
    }
    for (const source of ['schedule', 'channel', 'workflow'] as const)
      expect(definitionRunUnattended(source, { attended: true }), source).toBe(true)
  })
})

describe('a definition’s shell where the platform’s shell is not contained', () => {
  it('names the shell tools on every runtime', () => {
    expect(['bash', 'run_command', 'powershell'].map(isShellTool)).toEqual([true, true, true])
    expect(['read', 'write', 'edit', 'grep'].some(isShellTool)).toBe(false)
  })

  it('asks a person under grants that ask nothing, and only where the shell is not contained', () => {
    expect(call(policy())).toMatchObject({ allowed: true, needsApproval: false })
    expect(call(policy(), true)).toMatchObject({ allowed: true, needsApproval: true, shellAsk: true, classification: 'script' })
  })

  it('an unattended run is refused before anyone is asked', () => {
    expect(call(policy({ unattended: true }), true)).toMatchObject({ allowed: false, message: UNATTENDED_SHELL_REFUSAL })
    // Where the shell is contained, the run's own rules decide, as before.
    expect(call(policy({ unattended: true }))).toMatchObject({ allowed: true, needsApproval: false })
  })

  it('the earlier refusals still come first', () => {
    expect(call(policy({ script: { ...policy().script, enabled: false } }), true).message).toContain('Script execution is disabled')
  })

  it('the approval is bound to the exact command, and a run with no way to ask says why', async () => {
    const runPolicy = policy()
    const args = { command: 'npm test' }
    const prepared = call(runPolicy, true)
    const base = { prepared, policy: runPolicy, grants, toolName: 'bash', args, isMcp: false, projectPath: root }
    expect(await authorizeTrustedToolDispatch(base)).toEqual({ allowed: false, message: SHELL_APPROVAL_UNAVAILABLE })
    expect(await authorizeTrustedToolDispatch({ ...base, approveToolRequest: async () => ({ status: 'approved', digest: 'another-command' }) })).toMatchObject({ allowed: false, message: expect.stringContaining('stale') })
    expect(await authorizeTrustedToolDispatch({ ...base, approveToolRequest: async (request) => ({ status: 'approved', digest: request.argumentDigest }) })).toEqual({ allowed: true })
  })

  it('a host that cannot show a call in full says so, so the model splits it', () => {
    expect(approvalTooLongReason({ classification: 'script' })).toBe('This command is too long to show for approval in full, so it was not run. Split it into shorter steps.')
    expect(approvalTooLongReason({ classification: 'write' })).toContain('This tool call is too long')
  })
})
