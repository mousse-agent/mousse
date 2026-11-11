import { describe, expect, it, vi } from 'vitest'

// Counts what the highlighter really loads: one core (with its WASM engine and themes), and each grammar once.
const loads = vi.hoisted(() => ({ cores: 0, languageLoads: 0, loaded: () => [] as string[] }))

vi.mock('shiki/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shiki/core')>()
  return {
    ...actual,
    createHighlighterCore: async (...args: Parameters<typeof actual.createHighlighterCore>) => {
      loads.cores += 1
      const highlighter = await actual.createHighlighterCore(...args)
      const loadLanguage = highlighter.loadLanguage.bind(highlighter)
      highlighter.loadLanguage = (...langs: Parameters<typeof loadLanguage>) => {
        loads.languageLoads += 1
        return loadLanguage(...langs)
      }
      loads.loaded = () => highlighter.getLoadedLanguages()
      return highlighter
    },
  }
})

const {
  WARM_LANGUAGES,
  codeHighlighter,
  scheduleHighlighterWarmup,
  warmHighlighterWhenIdle,
} = await import('../../src/renderer/chat/components/agent-elements/code-highlighter')

const themes: ['github-light', 'github-dark'] = ['github-light', 'github-dark']

/** A window whose idle callbacks run only when the test says so. */
function fakeHost() {
  const idle: (() => void)[] = []
  const shown: (() => void)[] = []
  let hidden = false
  return {
    idle,
    host: {
      requestIdleCallback: vi.fn((callback: () => void, options?: { timeout: number }) => {
        expect(options?.timeout).toBeGreaterThan(0)
        idle.push(callback)
        return idle.length
      }),
      setTimeout: vi.fn(),
      isHidden: () => hidden,
      onceVisible: (callback: () => void) => { shown.push(callback) },
    },
    setHidden(value: boolean) {
      hidden = value
      if (!value) for (const callback of shown.splice(0)) callback()
    },
  }
}

/** Runs idle callbacks one at a time, as the warm-up asks for them, until it is done. */
async function drainIdle(idle: (() => void)[], done: Promise<void>) {
  let finished = false
  void done.then(() => { finished = true })
  while (!finished) {
    // One step at a time: the next idle period is asked for only after the step before it ended.
    expect(idle.length).toBeLessThanOrEqual(1)
    const next = idle.shift()
    if (next) next()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('code highlighter warm-up', () => {
  it('is skipped in tests', () => {
    const idleSpy = vi.fn()
    vi.stubGlobal('requestIdleCallback', idleSpy)
    scheduleHighlighterWarmup()
    expect(idleSpy).not.toHaveBeenCalled()
    expect(loads.cores).toBe(0)
    vi.unstubAllGlobals()
  })

  it('waits for an idle period of a shown window, then loads the highlighter and the common grammars once', async () => {
    const { idle, host, setHidden } = fakeHost()
    setHidden(true)
    const done = warmHighlighterWhenIdle(host)
    await Promise.resolve()
    // Hidden: nothing is scheduled and nothing loads.
    expect(host.requestIdleCallback).not.toHaveBeenCalled()
    expect(loads.cores).toBe(0)

    setHidden(false)
    expect(host.requestIdleCallback).toHaveBeenCalledTimes(1)
    // Shown but not yet idle: still nothing loads.
    await Promise.resolve()
    expect(loads.cores).toBe(0)

    await drainIdle(idle, done)
    expect(loads.cores).toBe(1)
    expect(loads.languageLoads).toBe(WARM_LANGUAGES.length)
    for (const language of WARM_LANGUAGES) expect(loads.loaded()).toContain(language)
    // One idle period for the core and one per grammar, each scheduled only after the step before it ended.
    expect(host.requestIdleCallback).toHaveBeenCalledTimes(1 + WARM_LANGUAGES.length)

    // Asking again reuses the same warm-up.
    expect(warmHighlighterWhenIdle(host)).toBe(done)
  })

  it('leaves the first TypeScript block nothing to load', async () => {
    const before = { cores: loads.cores, languageLoads: loads.languageLoads }
    const result = await new Promise<NonNullable<ReturnType<typeof codeHighlighter.highlight>>>((resolve) => {
      const sync = codeHighlighter.highlight({ code: 'const answer: number = 42', language: 'ts' as never, themes }, resolve)
      if (sync) resolve(sync)
    })
    // Coloured: tokens carry more than one style (plain text has one, empty style).
    expect(new Set(result.tokens.flat().map((token) => JSON.stringify(token.htmlStyle))).size).toBeGreaterThan(1)
    expect(loads.cores).toBe(before.cores)
    expect(loads.languageLoads).toBe(before.languageLoads)
  })
})
