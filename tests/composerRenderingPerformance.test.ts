import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readRendererComponent = (name: string): string =>
  readFileSync(new URL(`../src/renderer/components/${name}`, import.meta.url), 'utf8')

describe('composer rendering performance', () => {
  it.each(['OrchestratorChat.tsx', 'MousseAgentChat.tsx'])(
    'keeps transcript derivation and element construction out of %s input renders',
    (name) => {
      const source = readRendererComponent(name)
      // The agent-elements pipeline (mousseToUIMessages -> MousseAgentChatShell)
      // isolates transcript derivation from input renders.
      expect(source).toMatch(/const uiMessages = useMemo\(\(\) => mousseToUIMessages\(messages\)/)
      expect(source).toMatch(/MousseAgentChatShell/)
    }
  )
})
