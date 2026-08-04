import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readRendererComponent = (name: string): string =>
  readFileSync(new URL(`../src/renderer/components/${name}`, import.meta.url), 'utf8')

describe('composer rendering performance', () => {
  it.each(['OrchestratorChat.tsx', 'MousseAgentChat.tsx'])(
    'keeps transcript derivation and element construction out of %s input renders',
    (name) => {
      const source = readRendererComponent(name)

      // These are separate boundaries on purpose: the first prevents transcript-sized data
      // transforms on a keypress, and the second prevents React from reconciling every message.
      expect(source).toMatch(/const timelineState = useMemo\(\(\) => \{/)
      expect(source).toMatch(/const timelineContent = useMemo\(\(\) => \{/)
    }
  )
})
