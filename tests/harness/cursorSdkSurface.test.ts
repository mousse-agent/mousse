/**
 * The Cursor SDK surface Mousse relies on, pinned (agent CLIs plan v3 "D"): the exact version, and
 * the call expressions the host makes type-checked against it, so a bump that changes an option's
 * shape fails here rather than at a user's first turn.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const PINNED = '1.0.35'

describe('the pinned Cursor SDK', () => {
  it('is pinned exactly, and that version is installed', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; overrides: Record<string, string> }
    expect(manifest.dependencies['@cursor/sdk']).toBe(PINNED)
    // One copy for the agent and the legacy model API alike.
    expect(manifest.overrides['@cursor/sdk']).toBe('$@cursor/sdk')
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', '@cursor', 'sdk', 'package.json'), 'utf8')) as { version: string }
    expect(installed.version).toBe(PINNED)
  })

  it("type-checks the host's calls and the surface they need", () => {
    const config = ts.readConfigFile(join(root, 'tsconfig.node.json'), (path) => ts.sys.readFile(path))
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    const program = ts.createProgram([join(root, 'src', 'mms', 'harness', 'hosts', 'cursorHost.ts'), join(__dirname, 'cursorSdkSurface.types.ts')], { ...options, noEmit: true })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(diagnostics).toEqual([])
  }, 60_000)
})
