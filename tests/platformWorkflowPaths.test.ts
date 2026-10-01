import { describe, expect, it } from 'vitest'
import { checkBundleRelativePath, isInsideRoot, isUnsafeWorkspaceFileInput } from '../src/mms/workflows/pathSafety'
import { compileWorkflow } from '../src/mms/workflows/compiler/compileWorkflow'

describe('workflow asset path safety', () => {
  it('accepts ordinary relative asset paths', () => {
    expect(checkBundleRelativePath('scripts/collect.mjs')).toEqual({
      ok: true,
      relativePath: 'scripts/collect.mjs',
      segments: ['scripts', 'collect.mjs']
    })
  })

  it('rejects traversal, absolute, ADS, and device paths', () => {
    expect(checkBundleRelativePath('../secret.txt').ok).toBe(false)
    expect(checkBundleRelativePath('foo/../../etc/passwd').ok).toBe(false)
    expect(checkBundleRelativePath('/etc/passwd').ok).toBe(false)
    expect(checkBundleRelativePath('C:/Windows/notepad.exe').ok).toBe(false)
    expect(checkBundleRelativePath('file.txt:stream').ok).toBe(false)
    expect(checkBundleRelativePath('NUL').ok).toBe(false)
    expect(checkBundleRelativePath('CON.txt').ok).toBe(false)
    expect(checkBundleRelativePath('foo\\..\\bar').ok).toBe(false)
    expect(isUnsafeWorkspaceFileInput('../outside.txt')).toBe(true)
    expect(isUnsafeWorkspaceFileInput('README.md')).toBe(false)
  })

  it('flags unsafe instructionsFile during compile', () => {
    const compiled = compileWorkflow({
      schemaVersion: 1,
      id: '66666666-6666-4666-8666-666666666666',
      name: 'unsafe',
      slug: 'unsafe_paths',
      instructionsFile: '../README.md',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'end', type: 'end', version: 1, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'end' }]
    })
    expect(compiled.diagnostics.some((d) => d.code === 'ASSET_UNSAFE')).toBe(true)
  })

  it('uses the host filesystem case rules for containment', () => {
    const sameCase = isInsideRoot('/tmp/ProfileRoot', '/tmp/ProfileRoot/file.txt')
    expect(sameCase).toBe(true)
    if (process.platform !== 'win32') expect(isInsideRoot('/tmp/ProfileRoot', '/tmp/profileroot/file.txt')).toBe(false)
  })
})
