/**
 * What theme CSS text may hold (`externalLoadIn`): the check the renderer runs on every rule the browser produced and
 * on the whole result, and the daemon runs on a theme an agent writes. The real-window test
 * (tests/renderer/theme-css-electron.test.ts) shows the browser side end to end; this table lists the inputs.
 */
import { describe, expect, it } from 'vitest'
import { externalLoadIn, normalizeCssText } from '../src/shared/themes/cssSafety'

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
    ['escape split by newline', 'a { background: ur\\\nl(https://evil.example/x) }'],
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
    ['data: url next to a remote one', 'a { background: url(data:image/png;base64,AA), url(https://evil.example/x) }']
  ]
  it.each(loads)('refuses %s', (_name, css) => {
    expect(externalLoadIn(css)).not.toBeNull()
  })

  const safe: Array<[string, string]> = [
    ['colors and layout', 'a { color: #fff; background: rgb(1 2 3 / 50%); border-radius: 4px }'],
    ['data: url', 'a { background: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E") }'],
    ['#id url', 'a { filter: url(#blur) }'],
    ['var() and calc()', 'a { padding: calc(var(--space-8) * 2) }'],
    ['gradients', 'a { background: linear-gradient(90deg, red, color-mix(in srgb, red, blue)) }'],
    ['@keyframes', '@keyframes k { from { opacity: 0 } to { opacity: 1 } }'],
    // A comment splits tokens in CSS: `u/**/rl(` is the identifier u then a function rl(.
    ['comment between letters', 'a { background: u/**/rl(x) }']
  ]
  it.each(safe)('keeps %s', (_name, css) => {
    expect(externalLoadIn(css)).toBeNull()
  })
})

describe('normalizeCssText', () => {
  it('decodes escapes the way the CSS tokenizer does', () => {
    expect(normalizeCssText('\\75 rl')).toBe('url')
    expect(normalizeCssText('\\000075rl')).toBe('url')
    expect(normalizeCssText('U\\52L')).toBe('url')
    expect(normalizeCssText('\\0')).toBe('\ufffd')
  })
})
