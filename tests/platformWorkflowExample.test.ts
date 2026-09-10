import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileWorkflow, loadWorkflowDirectory } from '../src/mms/workflows'

const EXAMPLE = join(process.cwd(), 'examples', 'workflows', 'summarize-files')

describe('summarize_files example bundle', () => {
  it('matches architecture 6.3 and stages fileInputs without executing collect.mjs', () => {
    const loaded = loadWorkflowDirectory(EXAMPLE)
    expect(loaded.bundle.manifest.slug).toBe('summarize_files')
    expect(loaded.bundle.manifest.instructionsFile).toBe('instructions.md')
    expect(loaded.bundle.assets.some((asset) => asset.relativePath === 'scripts/collect.mjs')).toBe(true)
    expect(loaded.bundle.assets.some((asset) => asset.relativePath === 'instructions.md')).toBe(true)
    expect(loaded.bundle.editor?.schemaVersion).toBe(1)

    const instructions = readFileSync(join(EXAMPLE, 'instructions.md'), 'utf8')
    expect(instructions).toContain('Collect the selected files using the stored script')

    const script = readFileSync(join(EXAMPLE, 'scripts/collect.mjs'), 'utf8')
    expect(script).toContain('MOUSSE_INPUT_DIR')
    expect(script).toContain('process.stdout.write')

    const collect = loaded.bundle.manifest.nodes.find((node) => node.id === 'collect')
    expect(collect?.type).toBe('script')
    expect(collect?.config.fileInputs).toEqual([
      {
        pointer: '/files',
        source: 'thread-workspace',
        destination: 'input-dir',
        rewrite: 'relative-staged-paths',
        maxTotalBytes: 200000
      }
    ])

    const compiled = compileWorkflow(loaded.bundle.manifest, {
      knownAssets: new Set(loaded.bundle.assets.map((asset) => asset.relativePath))
    })
    expect(compiled.runnable).toBe(true)
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })
})
