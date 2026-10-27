import { describe, expect, it } from 'vitest'
import { approvalFingerprint, type FingerprintInput } from '../../src/mms/run/approvalFingerprint'

const base = { instanceId: 'claude', cwd: '/work/app' }
const claude = (toolName: string, input: unknown, permissionKey = 'claude:command', extra: Partial<FingerprintInput> = {}): string | null =>
  approvalFingerprint({ ...base, permissionKey, toolName, input, ...extra })

describe('approval fingerprints (SPEC §17.5)', () => {
  it('ignores a presentation-only description and nothing else', () => {
    const plain = claude('Bash', { command: 'npm test' })
    expect(plain).toMatch(/^[0-9a-f]{64}$/)
    expect(claude('Bash', { command: 'npm test', description: 'Run the tests' })).toBe(plain)
    expect(claude('Bash', { command: 'npm test -- --watch' })).not.toBe(plain)
    expect(claude('Bash', { command: 'npm test', timeout: 5000 })).not.toBe(plain)
    expect(claude('Bash', { command: 'npm test', run_in_background: true })).not.toBe(plain)
    // A field nobody listed is part of the action: it is never silently dropped.
    expect(claude('Bash', { command: 'npm test', dangerouslyDisableSandbox: true })).not.toBe(plain)
  })

  it('a shell is part of the fingerprint: a PowerShell request never matches a Bash grant for the same text', () => {
    expect(claude('PowerShell', { command: 'npm test' })).not.toBe(claude('Bash', { command: 'npm test' }))
  })

  it('where it runs is part of it: another instance or directory does not match', () => {
    const plain = claude('Bash', { command: 'ls' })
    expect(claude('Bash', { command: 'ls' }, 'claude:command', { instanceId: 'claude-work' })).not.toBe(plain)
    expect(claude('Bash', { command: 'ls' }, 'claude:command', { cwd: '/work/other' })).not.toBe(plain)
    expect(claude('Bash', { command: 'ls' }, 'claude:command', { cwd: undefined })).not.toBe(plain)
  })

  it('an omitted and an explicit default match; any execution-affecting difference does not', () => {
    const edit = { file_path: '/a.ts', old_string: 'a', new_string: 'b' }
    const plain = claude('Edit', edit, 'claude:edit')
    expect(claude('Edit', { ...edit, replace_all: false }, 'claude:edit')).toBe(plain)
    expect(claude('Edit', { ...edit, replace_all: true }, 'claude:edit')).not.toBe(plain)
    expect(claude('Edit', { ...edit, new_string: 'c' }, 'claude:edit')).not.toBe(plain)

    const multi = { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }
    expect(claude('MultiEdit', { ...multi, edits: [{ old_string: 'a', new_string: 'b', replace_all: false }] }, 'claude:edit')).toBe(claude('MultiEdit', multi, 'claude:edit'))
    expect(claude('MultiEdit', { ...multi, edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }, 'claude:edit')).not.toBe(claude('MultiEdit', multi, 'claude:edit'))

    const notebook = { notebook_path: '/n.ipynb', new_source: 'x = 1', cell_id: 'c1' }
    const replaced = claude('NotebookEdit', notebook, 'claude:edit')
    expect(claude('NotebookEdit', { ...notebook, edit_mode: 'replace' }, 'claude:edit')).toBe(replaced)
    expect(claude('NotebookEdit', { ...notebook, edit_mode: 'insert' }, 'claude:edit')).not.toBe(replaced)
    expect(claude('NotebookEdit', { ...notebook, cell_type: 'markdown' }, 'claude:edit')).not.toBe(replaced)
    expect(claude('Write', { file_path: '/w.ts', content: 'one' }, 'claude:edit')).not.toBe(claude('Write', { file_path: '/w.ts', content: 'two' }, 'claude:edit'))
  })

  it('an input that does not have the shape its tool declares has no fingerprint, so no grant', () => {
    expect(claude('Bash', { description: 'no command' })).toBeNull()
    expect(claude('Bash', { command: 42 })).toBeNull()
    expect(claude('Bash', 'ls')).toBeNull()
    expect(claude('Bash', null)).toBeNull()
    expect(claude('Edit', { file_path: '/a.ts', old_string: 'a' }, 'claude:edit')).toBeNull()
    expect(claude('MultiEdit', { file_path: '/a.ts', edits: [{ old_string: 'a' }] }, 'claude:edit')).toBeNull()
    expect(claude('NotebookEdit', { notebook_path: '/n.ipynb' }, 'claude:edit')).toBeNull()
  })

  it('any other tool is its whole input minus the description', () => {
    expect(claude('WebFetch', { url: 'https://a.test', description: 'x' }, 'claude:tool:WebFetch')).toBe(claude('WebFetch', { url: 'https://a.test' }, 'claude:tool:WebFetch'))
    expect(claude('WebFetch', { url: 'https://b.test' }, 'claude:tool:WebFetch')).not.toBe(claude('WebFetch', { url: 'https://a.test' }, 'claude:tool:WebFetch'))
  })

  it('Codex, the Pi agent and Mousse tools use their arguments; an ACP request is its raw input as given', () => {
    expect(approvalFingerprint({ ...base, permissionKey: 'codex:command', toolName: 'commandExecution', input: { command: 'make', cwd: '/work/app' } })).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalFingerprint({ ...base, permissionKey: 'pi:command', toolName: 'bash', input: { command: 'ls', description: 'x' } }))
      .toBe(approvalFingerprint({ ...base, permissionKey: 'pi:command', toolName: 'bash', input: { command: 'ls' } }))
    expect(approvalFingerprint({ ...base, permissionKey: 'mousse:integrate', toolName: 'integrate_delegation', input: { delegationId: 'd1' } }))
      .not.toBe(approvalFingerprint({ ...base, permissionKey: 'mousse:integrate', toolName: 'integrate_delegation', input: { delegationId: 'd2' } }))
    const acp = (rawInput: unknown) => approvalFingerprint({ ...base, permissionKey: 'acp:execute', toolName: 'execute', input: rawInput })
    expect(acp({ command: ['ls'] })).toBe(acp({ command: ['ls'] }))
    expect(acp({ command: ['ls'] })).not.toBe(acp({ command: ['rm'] }))
    // No raw input, no fingerprint.
    expect(acp(undefined)).toBeNull()
    expect(acp(null)).toBeNull()
    // Keys are order-independent.
    expect(acp({ a: 1, b: 2 })).toBe(acp({ b: 2, a: 1 }))
  })
})
