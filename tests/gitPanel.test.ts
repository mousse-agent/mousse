import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../src/renderer/components/GitPanel.tsx', import.meta.url),
  'utf8'
)

describe('GitPanel', () => {
  it('loads status and diffs from the active project path', () => {
    expect(source).toMatch(/git\.status\(undefined, projectPath\)/)
    expect(source).toMatch(/git\.diff\(path, staged, undefined, projectPath\)/)
  })

  it('shows diff request failures instead of leaving the pane blank', () => {
    expect(source).toContain('Could not load diff:')
  })
})
