import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { promptDisplayText, promptSegments } from '../src/renderer/chat/components/agent-elements/prompt-links'
import { linkLabel, shortGitHubLabel } from '../src/renderer/chat/components/agent-elements/link-label'
import { markdownToSearchBlocks } from '../src/renderer/chat/components/agent-elements/find/search-text'
import { searchableParts } from '../src/renderer/chat/components/agent-elements/find/find-index'

const pr = 'https://github.com/acme/app/pull/35130'

describe('promptSegments', () => {
  it('splits out Markdown links with their label as written', () => {
    expect(promptSegments(`faster ([#35130](${pr}), [#2](https://github.com/acme/app/issues/2)):`)).toEqual([
      { kind: 'text', text: 'faster (' },
      { kind: 'link', text: '#35130', href: pr },
      { kind: 'text', text: ', ' },
      { kind: 'link', text: '#2', href: 'https://github.com/acme/app/issues/2' },
      { kind: 'text', text: '):' }
    ])
  })

  it('shortens a bare GitHub pull request, issue or commit address and leaves its trailing punctuation as text', () => {
    expect(promptDisplayText(`see ${pr}.`)).toBe('see #35130.')
    expect(promptDisplayText('(https://github.com/acme/app/commit/0123456789abcdef)')).toBe('(0123456)')
    expect(shortGitHubLabel('https://github.com/acme/app/tree/main')).toBeNull()
  })

  it('keeps other addresses whole, and a bracket that belongs to the address', () => {
    expect(promptSegments('docs: https://en.wikipedia.org/wiki/Foo_(bar), ok')).toEqual([
      { kind: 'text', text: 'docs: ' },
      { kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', text: ', ok' }
    ])
  })

  it('leaves text without a web address alone', () => {
    expect(promptSegments('no links [here](./file.ts) or javascript:alert(1)')).toEqual([
      { kind: 'text', text: 'no links [here](./file.ts) or javascript:alert(1)' }
    ])
  })
})

describe('find in a prompt with links', () => {
  it('reads the labels the bubble shows, not the addresses', () => {
    const message = { id: 'u1', role: 'user', parts: [{ type: 'text', text: `Review [#35130](${pr}) and ${pr}` }] } as unknown as UIMessage
    expect(searchableParts(message)).toEqual([{ partIndex: 0, blocks: ['Review #35130 and #35130'] }])
  })
})

describe('linkLabel', () => {
  it('shortens only a bare GitHub address, never a label someone wrote', () => {
    expect(linkLabel(pr, pr)).toBe('#35130')
    expect(linkLabel(pr, 'the speed PR')).toBe('the speed PR')
    expect(linkLabel('https://example.com/a', 'https://example.com/a')).toBe('https://example.com/a')
  })
})

describe('find in a reply with links', () => {
  it('reads a bare GitHub address as its short label, and a written label as written', () => {
    expect(markdownToSearchBlocks(`See ${pr} and [the docs](https://example.com).`)).toEqual(['See #35130 and the docs.'])
    expect(markdownToSearchBlocks(`See [#1](${pr}).`)).toEqual(['See #1.'])
  })
})
