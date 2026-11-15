/**
 * What theme CSS text may hold (`externalLoadIn`): the check the renderer runs on every rule the browser produced and
 * on the whole result, and the daemon runs on a theme an agent writes. The real-window test
 * (tests/renderer/theme-css-electron.test.ts) shows the browser side end to end; this table lists the inputs. The only
 * url() a theme may use is one quoted data: address.
 */
import { describe, expect, it } from 'vitest'
import { externalLoadIn, withoutExternalLoads } from '../src/shared/themes/cssSafety'

describe('externalLoadIn', () => {
  // Inputs: plain and escaped function names, quoted and unquoted addresses, every function that names a resource,
  // nesting, custom properties, @property / @keyframes / @font-face / @import bodies, comments inside url().
  const loads: Array<[string, string]> = [
    ['plain url', 'a { background: url(https://evil.example/x.png) }'],
    ['quoted url', 'a { background: url("https://evil.example/x.png") }'],
    ['protocol-relative url', 'a { background: url(//evil.example/x) }'],
    ['relative url', 'a { background: url(x.png) }'],
    ['upper-case URL', 'a { background: URL(https://evil.example/x) }'],
    ['hex-escaped u', 'a { background: \\75 rl(https://evil.example/x) }'],
    ['six-digit escape', 'a { background: \\000075rl(https://evil.example/x) }'],
    ['escaped letter', 'a { background: u\\rl(https://evil.example/x) }'],
    ['custom property', ':root { --x: url(https://evil.example/x) }'],
    ['escaped custom property', ':root { --x: \\75\\72\\6c(https://evil.example/x) }'],
    ['var() fallback', 'a { background: var(--nope, url(https://evil.example/x)) }'],
    ['nested in a function', 'a { background: f(url(https://evil.example/x)) }'],
    ['nested rule', 'a { & b { background: url(https://evil.example/x) } }'],
    ['@media body', '@media (min-width: 1px) { a { background: url(https://evil.example/x) } }'],
    ['@property initial value', '@property --x { syntax: "<url>"; inherits: false; initial-value: url(https://evil.example/x) }'],
    ['@keyframes frame', '@keyframes k { from { background: url(https://evil.example/x) } }'],
    ['@font-face src', '@font-face { font-family: f; src: url(https://evil.example/f.woff2) }'],
    ['src() with a string', 'a { background: src("https://evil.example/x") }'],
    ['image-set with a string', 'a { background: image-set("https://evil.example/x" 1x) }'],
    ['-webkit-image-set', 'a { background: -webkit-image-set("https://evil.example/x" 1x) }'],
    ['image()', 'a { background: image("https://evil.example/x") }'],
    ['cross-fade', 'a { background: cross-fade(url(#a), url(https://evil.example/x)) }'],
    ['attr()', 'a::after { content: attr(data-secret) }'],
    ['@import', '@import "https://evil.example/x.css";'],
    ['escaped @import', '@\\69mport "https://evil.example/x.css";'],
    ['@namespace', '@namespace url(https://evil.example/ns);'],
    // Inside url() a comment is part of the address: this is a relative URL, not data:.
    ['comment inside url()', 'a { background: url(data/**/:x) }'],
    ['data: url next to a remote one', 'a { background: url(data:image/png;base64,AA), url(https://evil.example/x) }'],
    // The URL parser keeps a no-break space or BOM, so these are relative addresses, not data: or #id.
    ['no-break space before data:', 'a { background: url("\\a0 data:x") }'],
    ['BOM before #id', 'a { background: url("\\feff#x") }'],
    // Only a quoted data: address passes; every other url() is refused, however it is spelled.
    ['unquoted data:', 'a { background: url(data:image/png;base64,AA) }'],
    ['unquoted data: with spaces', 'a { background: url(  data:image/png;base64,AA  ) }'],
    ['quoted http', "a { background: url('http://evil.example/x') }"],
    ['quoted relative path', 'a { background: url("x.png") }'],
    ['quoted #id', 'a { filter: url("#blur") }'],
    ['unquoted #id', 'a { filter: url(#blur) }'],
    ['escaped name, unquoted data:', 'a { background: \\75 rl(data:x) }'],
    ['escaped letters that make a quoted address that is not data:', 'a { background: url("dat\\61 /x.png") }'],
    ['escaped letters that make a quoted http address', 'a { background: url("\\68 ttp://evil.example/x") }'],
    ['comment-split name', 'a { background: u/**/rl(https://evil.example/x) }'],
    ['comment-split name before a quoted address', 'a { background: u/**/rl("x.png") }'],
    ['comment inside a quoted address', 'a { background: url("data/**/:x") }'],
    ['comment before the quote', 'a { background: url(/**/https://evil.example/x) }'],
    ['text after the quoted address', 'a { background: url("data:x" https://evil.example/x) }'],
    // Strings in other declarations cannot pair up across an unquoted address and hide it.
    ['an unquoted data: address between two strings', `a { --x: 'url("data:foo'; background: url(data:image/png;base64,AA); --y: '")'; }`]
  ]
  it.each(loads)('refuses %s', (_name, css) => {
    expect(externalLoadIn(css)).not.toBeNull()
  })

  const safe: Array<[string, string]> = [
    ['colors and layout', 'a { color: #fff; background: rgb(1 2 3 / 50%); border-radius: 4px }'],
    ['quoted data: url', 'a { background: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E") }'],
    ['single-quoted data: url with spaces around it', "a { background: url(  'data:image/png;base64,AA'  ) }"],
    ['two quoted data: urls', 'a { background: url("data:image/png;base64,AA"), url("data:image/png;base64,BB") }'],
    // The address is not scanned again: an SVG in it may name its own parts.
    ['an SVG data: address that uses url(#id) inside', `a { background: url("data:image/svg+xml,<svg><rect fill='url(#g)'/></svg>") }`],
    ['a comment outside the quoted address', 'a { background: /* tiles */ url("data:image/png;base64,AA") }'],
    // An escaped quote is part of the address, not its end.
    ['escaped quotes inside a quoted data: address', 'a { background: url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>") }'],
    ['an escaped quote that stays inside the address', 'a { background: url("data:x\\22 x.png") }'],
    // A backslash before a newline is no escape: `ur\` then `l(` is no url() at all, and the browser drops it as invalid.
    ['a backslash-newline between letters', 'a { background: ur\\\nl(x) }'],
    ['var() and calc()', 'a { padding: calc(var(--space-8) * 2) }'],
    ['gradients', 'a { background: linear-gradient(90deg, red, color-mix(in srgb, red, blue)) }'],
    ['@keyframes', '@keyframes k { from { opacity: 0 } to { opacity: 1 } }']
  ]
  it.each(safe)('keeps %s', (_name, css) => {
    expect(externalLoadIn(css)).toBeNull()
  })
})

describe('withoutExternalLoads: the CSS as written, before it is parsed', () => {
  const run = (css: string) => {
    const dropped: Array<{ text: string; reason: string }> = []
    return { css: withoutExternalLoads(css, dropped), dropped }
  }
  /** Spacing is not what these cases are about. */
  const flat = (css: string) => css.replace(/\s+/g, ' ').replace(/ ?([{};]) ?/g, '$1').trim()

  it('drops only the declaration with a refused url(), and keeps its rule and the quoted data: one', () => {
    const { css, dropped } = run('a { color: red; background: url(data:x); } b { background: url("data:image/png;base64,AA") }')
    expect(flat(css)).toBe(flat('a { color: red; } b { background: url("data:image/png;base64,AA") }'))
    expect(dropped).toEqual([expect.objectContaining({ text: 'background: url(data:x);' })])
  })

  it('drops a rule whose selector or at-rule prelude names an address, and goes into nested blocks', () => {
    expect(flat(run('@supports (background: url(x.png)) { a { color: red } } b { color: blue }').css)).toBe(flat('b { color: blue }'))
    // Quoted text in a selector is text, not an address: the rule stays.
    expect(flat(run('a[title="url(y)"] { color: red }').css)).toBe(flat('a[title="url(y)"] { color: red }'))
    expect(flat(run('@media (min-width: 1px) { a { color: red; background: url(x.png) } b { color: blue } }').css))
      .toBe(flat('@media (min-width: 1px) { a { color: red; } b { color: blue } }'))
  })

  it('keeps a brace inside an unquoted url() out of the split, so the rules around it stay as they are', () => {
    const { css, dropped } = run('a { background: url(data:text/plain,{); color: red } b { color: blue }')
    expect(flat(css)).toBe(flat('a { color: red } b { color: blue }'))
    expect(dropped).toEqual([expect.objectContaining({ text: 'background: url(data:text/plain,{);' })])
    expect(flat(run('a { background: url(data:text/plain,}); color: red } b { color: blue }').css)).toBe(flat('a { color: red } b { color: blue }'))
  })

  it('drops an unquoted address that strings around it try to hide, and keeps the strings', () => {
    const { css } = run(`a { --x: 'url("data:foo'; background: url(data:image/png;base64,AA); --y: '")'; }`)
    expect(flat(css)).toBe(flat(`a { --x: 'url("data:foo'; --y: '")'; }`))
  })

  it('keeps a semicolon or brace inside a quoted address, and a comment, out of the split', () => {
    const css = 'a { background: url("data:image/svg+xml,<svg>;}</svg>") /* ; } */; color: red }'
    expect(run(css)).toEqual({ css, dropped: [] })
  })
})
