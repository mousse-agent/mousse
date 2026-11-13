import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Every update of a looping animation redraws the whole window, so indicators that can run for as long as an agent
// works move in steps (about 15 a second) instead of on every frame (agent-ui.css). These loops run only while the
// person acts, or briefly while a page loads, and keep their smooth motion.
const SMOOTH_ALLOWED = [
  'ambient-glow-a', 'ambient-glow-b', 'ambient-glow-rim-a', 'ambient-glow-rim-b', // var(--ambient-glow-ease): a stepped linear()
  'empty-logo-wobble',
  // Kept smooth on purpose (428f6e0be): a stepped turn read as laggy. It shows only while a model thinks.
  'thinking-icon-turn',
  'composer-recording-pulse', 'composer-transcribing-spin', 'orb-liquid-drift',
  'threads-sidebar-skeleton-shimmer', 'usage-skeleton-pulse', 'usage-bar-stripes', 'ui-loader-breathe',
  'bot-browser-loading' // the bot browser's address bar while a page loads
]

const cssFiles = execFileSync('git', ['ls-files', 'src/renderer/*.css', 'src/renderer/**/*.css'], { encoding: 'utf8' }).trim().split('\n')

describe('looping indicators', () => {
  it('move in steps rather than on every frame', () => {
    const smooth: string[] = []
    for (const file of cssFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/animation:\s*([^;{}]*\binfinite\b[^;{}]*)/g)) {
        const value = match[1]!
        if (/steps\(|var\(--ambient-glow-ease\)|var\(--empty-logo-wobble-ease\)/.test(value)) continue
        const name = value.trim().split(/\s+/)[0]!
        if (!SMOOTH_ALLOWED.includes(name)) smooth.push(`${file}: ${value.trim()}`)
      }
    }
    expect(smooth).toEqual([])
  })

  it('include the tool-row shimmer, whose timing is set inline', () => {
    const source = readFileSync('src/renderer/chat/components/agent-elements/text-shimmer.tsx', 'utf8')
    expect(source).toContain('animationTimingFunction: `steps(')
    expect(source).not.toMatch(/animationTimingFunction:\s*"linear"/)
  })
})
