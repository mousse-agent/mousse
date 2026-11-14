/**
 * Theme CSS in a real Chromium window (#1142): hostile rules, each a way to load a URL (escaped, nested, through var(),
 * @property, @keyframes, @font-face, @import, image-set(), attribute selectors), go through the app's own
 * `applyThemeCss` and make no request at all, while the safe rules in the same CSS still apply. The control puts the
 * same CSS on the page unchecked and sees it reach the leak server, so a leak would show. While a decision (an
 * approval's buttons) is on the page, the whole theme, colors included, is off.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

type Evidence = {
  theme: { requested: string[]; leakHits: string[]; dropped: number; measured: Record<string, string> }
  decision: Record<'before' | 'during' | 'after', { sidebar: string; token: string; buttonAfter: string; paused: boolean }>
  control: { requested: string[]; leakHits: string[] }
  pageErrors: string[]
}

it('applies the safe rules of a hostile theme and makes no request, pauses it while a decision is on screen, while the same CSS unchecked does load', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-theme-css-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/theme-css/entry.ts')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent' })
    await build({ entryPoints: [resolve('tests/fixtures/theme-css/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_THEME_CSS_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    expect(evidence.pageErrors).toEqual([])

    // Through the theme: not one request, to the leak server or anywhere else.
    expect(evidence.theme.requested).toEqual([])
    expect(evidence.theme.leakHits).toEqual([])
    expect(evidence.theme.dropped).toBeGreaterThan(0)
    // The safe rules in the same CSS apply, including the safe half of a rule that also tried to load.
    expect(evidence.theme.measured).toMatchObject({
      sidebar: 'rgb(1, 2, 3)',
      mixedColor: 'rgb(7, 8, 9)',
      mixedImage: 'none',
      brokenWidth: '10px',
      afterBad: 'rgb(13, 14, 15)',
      inMedia: 'rgb(16, 17, 18)',
      keyframes: 'fine',
      nested: 'rgb(19, 20, 21)'
    })
    expect(evidence.theme.measured.keepData).toContain('data:image/svg+xml')

    // While a person is asked to decide, no theme rule or color applies: a theme cannot relabel Approve as Deny.
    expect(evidence.decision.before).toMatchObject({ sidebar: 'rgb(1, 2, 3)', token: '#010203', paused: false })
    expect(evidence.decision.during).toMatchObject({ token: '', buttonAfter: 'none', paused: true })
    expect(evidence.decision.during.sidebar).not.toBe('rgb(1, 2, 3)')
    expect(evidence.decision.after).toMatchObject({ sidebar: 'rgb(1, 2, 3)', token: '#010203', paused: false })

    // The control: unchecked, the same CSS fetches from the leak server, by each of these routes.
    const reached = new Set(evidence.control.leakHits.map((hit) => hit.replace(/^\/leak/, '')))
    for (const route of ['/import.css', '/plain', '/escaped', '/var', '/image-set', '/font.woff2', '/property', '/keyframes', '/nested', '/media', '/shorthand', '/attr-a', '/mixed'])
      expect(reached.has(route), `${route} in ${[...reached].join(' ')}`).toBe(true)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected theme CSS fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
