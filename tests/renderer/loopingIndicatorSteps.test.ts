import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { TURNING_CLASSES } from '../../src/renderer/lib/turning'

// The rule for looping animations (agent-ui.css). Each update of a looping animation redraws the whole window, so
// a fade, pulse, shimmer, dot or ellipsis that can run for as long as an agent works moves in steps (about 15 a
// second) instead of on every frame: a change of opacity or colour at 15 a second does not read as lag. Rotation is
// the exception: a spinner or ring that turns in 12 jumps of 30 degrees reads as a laggy spin, so spinners turn
// smoothly, every frame, and only through Turning (lib/turning.tsx), which turns a span on the compositor. No
// stylesheet rotates anything forever: on an <svg> Chromium would run it on the main thread, and a repeating CSS
// animation wakes the main thread at every turn. These other loops run only while the person acts, or briefly
// while a page loads, and keep their smooth motion.
const SMOOTH_ALLOWED = [
  'ambient-glow-a', 'ambient-glow-b', 'ambient-glow-rim-a', 'ambient-glow-rim-b', // var(--ambient-glow-ease): a stepped linear()
  'empty-logo-wobble',
  'composer-recording-pulse', 'orb-liquid-drift',
  'threads-sidebar-skeleton-shimmer', 'usage-skeleton-pulse', 'usage-bar-stripes', 'ui-loader-breathe',
  'watched-browser-loading' // a watched browser's address bar while a page loads
]

const cssFiles = execFileSync('git', ['ls-files', 'src/renderer/*.css', 'src/renderer/**/*.css'], { encoding: 'utf8' }).trim().split('\n')
const sources = cssFiles.map((file) => ({ file, css: readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '') }))

/** The body of each `@keyframes` block, by name. A name defined more than once keeps every body. */
function keyframesByName(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const { css } of sources) {
    for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      let depth = 1
      let end = match.index + match[0].length
      while (depth > 0 && end < css.length) {
        if (css[end] === '{') depth += 1
        else if (css[end] === '}') depth -= 1
        end += 1
      }
      const body = css.slice(match.index + match[0].length, end - 1)
      found.set(match[1]!, [...(found.get(match[1]!) ?? []), body])
    }
  }
  return found
}

const keyframes = keyframesByName()

/** True when every frame of a keyframes body only rotates: `transform: rotate(...)` or the `rotate` property. */
function bodyOnlyRotates(body: string): boolean {
  const declarations = [...body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)]
  return declarations.length > 0 && declarations.every(([, property, value]) =>
    property === 'rotate' || (property === 'transform' && /^(\s*rotate(?:Z)?\([^)]*\))+\s*$/.test(value!)))
}

/** True when every definition of the named keyframes only rotates. */
function onlyRotates(name: string): boolean {
  const bodies = keyframes.get(name)
  return !!bodies?.length && bodies.every(bodyOnlyRotates)
}

/** Every `animation:` shorthand that loops forever, with the keyframes it names. */
function loopingAnimations(): Array<{ where: string; name: string; value: string }> {
  const loops: Array<{ where: string; name: string; value: string }> = []
  for (const { file, css } of sources) {
    for (const match of css.matchAll(/animation:\s*([^;{}]*\binfinite\b[^;{}]*)/g)) {
      const value = match[1]!.trim()
      const tokens = value.split(/\s+/)
      const name = tokens.find((token) => keyframes.has(token)) ?? tokens[0]!
      loops.push({ where: `${file}: ${value}`, name, value })
    }
  }
  return loops
}

const stepped = (value: string) => /steps\(|var\(--ambient-glow-ease\)|var\(--empty-logo-wobble-ease\)/.test(value)

describe('looping indicators', () => {
  it('reads keyframes the way the rule needs', () => {
    // Guards the parser: a spinner's keyframes only rotate; a pulse's and a wobble's do not.
    expect(bodyOnlyRotates('to { transform: rotate(360deg); }')).toBe(true)
    expect(bodyOnlyRotates('from { rotate: -90deg; } to { rotate: 270deg; }')).toBe(true)
    expect(onlyRotates('an-tool-icon-pulse')).toBe(false)
    expect(onlyRotates('empty-logo-wobble')).toBe(false)
    expect(loopingAnimations().length).toBeGreaterThan(15)
  })

  it('move in steps rather than on every frame', () => {
    const smooth = loopingAnimations()
      .filter(({ name, value }) => !stepped(value) && !onlyRotates(name) && !SMOOTH_ALLOWED.includes(name))
      .map(({ where }) => where)
    expect(smooth).toEqual([])
  })

  it('never rotate forever in a stylesheet: spinners turn through Turning', () => {
    const turns = loopingAnimations().filter(({ name }) => onlyRotates(name)).map(({ where }) => where)
    expect(turns).toEqual([])
    // A spinner class on a plain element (<svg className="animate-spin">) would skip Turning: Tailwind's CSS
    // animation would turn the svg on the main thread. Spinner classes go on an icon component or Turning.
    const files = execFileSync('git', ['ls-files', 'src/renderer/*.tsx', 'src/renderer/**/*.tsx'], { encoding: 'utf8' }).trim().split('\n')
    const names = [...TURNING_CLASSES].join('|')
    const plain = new RegExp(`<([a-z][\\w-]*)\\b[^<>]*className=\\{?[^<>]*?\\b(${names})\\b`, 'g')
    const misses = files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(plain)].map((match) => `${file}: <${match[1]} … ${match[2]}`))
    expect(misses).toEqual([])
  })

  it('include the tool-row shimmer, whose timing is set inline', () => {
    const source = readFileSync('src/renderer/chat/components/agent-elements/text-shimmer.tsx', 'utf8')
    expect(source).toContain('animationTimingFunction: `steps(')
    expect(source).not.toMatch(/animationTimingFunction:\s*"linear"/)
  })
})
