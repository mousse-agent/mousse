// @vitest-environment jsdom
/**
 * Website links in chat responses lead with a monochrome vector site mark in `currentColor` (the
 * link's own colour): a brand vector for known hosts, or a globe vector for any other `http(s)` URL.
 * Local file and thread links never receive a website mark, and no external network fetch is made.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { siteMarkForUrl, type SiteMark } from '../../src/renderer/chat/components/agent-elements/link-label'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('siteMarkForUrl', () => {
  const cases: Array<[href: string, expected: SiteMark | null]> = [
    ['https://github.com/mousse-agent/mousse/pull/1781', 'github'],
    ['https://gist.github.com/user/123', 'github'],
    ['https://gitlab.com/group/project', 'gitlab'],
    ['https://www.npmjs.com/package/vitest', 'npm'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://x.com/example/status/1', 'x'],
    ['https://twitter.com/example', 'x'],
    ['https://www.reddit.com/r/typescript', 'reddit'],
    ['https://stackoverflow.com/questions/1', 'stackoverflow'],
    ['https://developer.mozilla.org/en-US/docs/Web', 'mdn'],
    ['https://en.wikipedia.org/wiki/Markdown', 'wikipedia'],
    ['https://cloud.google.com/docs', 'google'],
    ['https://discord.gg/abc', 'discord'],
    ['https://linear.app/team/issue/1', 'linear'],
    ['https://www.figma.com/file/abc', 'figma'],
    ['https://nextjs.org/docs', 'vercel'],
    ['https://developers.cloudflare.com/workers/', 'cloudflare'],
    ['https://supabase.com/docs', 'supabase'],
    ['https://chatgpt.com/', 'openai'],
    ['https://docs.anthropic.com/en/docs', 'anthropic'],
    ['https://huggingface.co/models', 'huggingface'],
    ['https://news.ycombinator.com/item?id=1', 'hackernews'],
    ['https://pypi.org/project/pytest/', 'python'],
    ['https://docs.rs/tokio', 'rust'],
    ['https://stripe.com/docs', 'stripe'],
    ['https://developer.apple.com/documentation', 'apple'],
    ['https://learn.microsoft.com/en-us/', 'microsoft'],
    ['https://example.com/docs', 'web'],
    ['http://localhost:3000/app', 'web'],
    ['mousse-file://open?path=src%2Fapp.ts', null],
    ['file:///home/me/app.ts', null],
    ['src/app.ts:42', null],
    ['mousse://thread/t1', null],
    ['javascript:alert(1)', null],
  ]

  it.each(cases)('%s -> %s', (href, expected) => {
    expect(siteMarkForUrl(href)).toBe(expected)
  })
})

describe('website link marks rendered in chat Markdown', () => {
  it('draws a monochrome currentColor vector on the left of every web link and none on file links', () => {
    const content = [
      'Check [PR #1781](https://github.com/mousse-agent/mousse/pull/1781),',
      '[MDN Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API),',
      '[npm vitest](https://www.npmjs.com/package/vitest),',
      '[Example Docs](https://example.com/guide),',
      'and [app.ts](src/app.ts).',
    ].join(' ')
    act(() => root.render(createElement(Markdown, { content })))

    const links = [...host.querySelectorAll('a')]
    expect(links).toHaveLength(5)

    const [github, mdn, npm, example, file] = links
    for (const [link, mark, usesStroke] of [
      [github!, 'github', false],
      [mdn!, 'mdn', false],
      [npm!, 'npm', false],
      [example!, 'web', true],
    ] as const) {
      const svg = link.querySelector('svg.chat-link-mark')
      expect(svg, link.textContent ?? '').not.toBeNull()
      expect(svg!.getAttribute('data-site-mark')).toBe(mark)
      expect(svg!.getAttribute('aria-hidden')).toBe('true')
      expect(svg!.getAttribute(usesStroke ? 'stroke' : 'fill')).toBe('currentColor')
      // The vector appears before the label text (to the left of the link).
      expect(link.querySelector('img')).toBeNull()
      const wrapper = svg!.parentElement!
      expect(wrapper.firstChild).toBe(svg)
    }

    // Local file link gets no website icon.
    expect(file!.querySelector('svg')).toBeNull()
  })
})
