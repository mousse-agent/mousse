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

  it('any other tool is its whole input: only a tool\'s own schema says a field is a label, so none is dropped', () => {
    const tool = (input: unknown, name = 'mcp__tickets__update') => claude(name, input, `claude:tool:${name}`)
    // For a ticket tool, `description` is the content being changed.
    expect(tool({ id: 7, description: 'ship it' })).not.toBe(tool({ id: 7, description: 'delete everything' }))
    expect(tool({ id: 7, description: 'ship it' })).toBe(tool({ id: 7, description: 'ship it' }))
    expect(claude('WebFetch', { url: 'https://b.test' }, 'claude:tool:WebFetch')).not.toBe(claude('WebFetch', { url: 'https://a.test' }, 'claude:tool:WebFetch'))
    expect(claude('WebFetch', { url: 'https://a.test', description: 'x' }, 'claude:tool:WebFetch')).not.toBe(claude('WebFetch', { url: 'https://a.test' }, 'claude:tool:WebFetch'))
  })

  it('a command or an edit without the directory it runs in is not identified, so it gets no fingerprint', () => {
    expect(claude('Bash', { command: 'ls' }, 'claude:command', { cwd: undefined })).toBeNull()
    expect(approvalFingerprint({ instanceId: 'pi:openai', permissionKey: 'pi:command', toolName: 'bash', input: { command: 'ls' } })).toBeNull()
    // The same relative call in another project is another action.
    const pi = (cwd: string) => approvalFingerprint({ instanceId: 'pi:openai', cwd, permissionKey: 'pi:edit', toolName: 'edit', input: { path: 'src/a.ts', oldText: 'a', newText: 'b' } })
    expect(pi('/work/app')).toMatch(/^[0-9a-f]{64}$/)
    expect(pi('/work/app')).not.toBe(pi('/work/app-worktree'))
    // An action that is not about files or commands needs no directory.
    expect(approvalFingerprint({ instanceId: 'claude', permissionKey: 'claude:tool:WebFetch', toolName: 'WebFetch', input: { url: 'https://a.test' } })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Codex and the Pi agent use their arguments, and a Mousse tool gets none: what it acts on changes before a continuation', () => {
    expect(approvalFingerprint({ ...base, permissionKey: 'codex:command', toolName: 'commandExecution', input: { command: 'make', cwd: '/work/app' } })).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalFingerprint({ ...base, permissionKey: 'pi:command', toolName: 'bash', input: { command: 'ls', description: 'x' } }))
      .not.toBe(approvalFingerprint({ ...base, permissionKey: 'pi:command', toolName: 'bash', input: { command: 'ls' } }))
    for (const [key, name] of [['mousse:integrate', 'integrate_delegation'], ['mousse:merge_back', 'thread_merge_back']] as const)
      expect(approvalFingerprint({ ...base, permissionKey: key, toolName: name, input: { delegationId: 'd1' } })).toBeNull()
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
