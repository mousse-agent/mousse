import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readRendererComponent = (name: string): string =>
  readFileSync(new URL(`../src/renderer/components/${name}`, import.meta.url), 'utf8')

describe('composer rendering performance', () => {
  it.each(['OrchestratorChat.tsx'])(
    'keeps transcript derivation and element construction out of %s input renders',
    (name) => {
      const source = readRendererComponent(name)
      // The agent-elements pipeline (mousseToUIMessages -> MousseAgentChatShell)
      // isolates transcript derivation from input renders.
      expect(source).toMatch(/const uiMessages = useMemo\(\(\) => mousseToUIMessages\(messages\)/)
      expect(source).toMatch(/MousseAgentChatShell/)
    }
  )

  it('keeps mention search in a debounced effect in ChatComposer.tsx', () => {
    const source = readRendererComponent('ChatComposer.tsx')
    expect(source).toMatch(/const MENTION_SEARCH_DEBOUNCE_MS = \d+/)
    // The search runs once, inside the effect that waits for the debounce, and keys on the query and scope only.
    const effect = /useEffect\(\(\) => \{[^]*?MENTION_SEARCH_DEBOUNCE_MS[^]*?\}, \[mentionQueryText, mentionScopeKey\]\)/.exec(source)
    expect(effect).not.toBeNull()
    expect(effect![0]).toMatch(/setTimeout\(run, MENTION_SEARCH_DEBOUNCE_MS\)/)
    expect(effect![0]).toMatch(/isMentionResultCurrent\(/)
    expect(source.match(/\brequest\(query\)/g)).toHaveLength(1)
    expect(effect![0]).toMatch(/\brequest\(query\)/)
    // Typing never calls the search directly.
    expect(source.match(/searchMentionsRef\.current\b/g)?.length).toBeGreaterThanOrEqual(2)
    expect(source).not.toMatch(/searchMentions\(/)
  })

  it('never lets an input method composition pick or send in ChatComposer.tsx', () => {
    const source = readRendererComponent('ChatComposer.tsx')
    expect(source).toMatch(/onCompositionStart=/)
    expect(source).toMatch(/onCompositionEnd=/)
    expect(source).toMatch(/if \(isImeComposing\(keyInfo\)\) return/)
    expect(source).toMatch(/composingRef\.current\) return/)
  })
})
