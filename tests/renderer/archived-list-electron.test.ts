/**
 * The real sidebar in a real Chromium window, with the app's CSS and 600 archived threads: Archived opens with only
 * the cards in view drawn, scrolls to its last row with no blank band, holds the row at the top still while heights
 * are measured, keeps keyboard focus on a row scrolled far away, the last row's menu opens, and an archived thread that opens
 * shows its row whole.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build, type Plugin } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type View = { drawn: number; blank: number[]; first: { id: string; top: number } | null; last: string | null; scrollTop: number; room: number; headingShown: boolean }
type Reveal = { id: string; open: boolean; row: { top: number; bottom: number } | null; view: { top: number; bottom: number } }
type Evidence = {
  open: View & { count: string }
  end: View
  middle: { before: View; after: View }
  focusAway: View & { id: string; focused: boolean }
  lastRowMenu: { found: boolean; items: string[] }
  revealFar: Reveal
  revealAfterOpening: Reveal
  pageErrors: string[]
  rendererErrors: string[]
}

/** Neighbours of the sidebar that read the daemon (the Chats tab and the profile footer): drawn as nothing. */
const quietNeighbours: Plugin = {
  name: 'quiet-neighbours',
  setup(context) {
    context.onResolve({ filter: /\/(profiles\/ProfileSwitcher|chats\/ChatsSidebar)$/ }, (args) => ({ path: args.path, namespace: 'quiet' }))
    context.onLoad({ filter: /.*/, namespace: 'quiet' }, (args) => ({
      contents: `export const ${args.path.endsWith('ProfileSwitcher') ? 'ProfileSwitcher' : 'ChatsSidebar'} = () => null`,
      loader: 'js',
    }))
  },
}

/** Cards drawn at most: about a footer's height of them plus the overscan on each side. */
const DRAWN_AT_MOST = 40

it('opens 600 archived threads with only the cards in view drawn, scrolls to the last with none blank, and keeps focus and the menu', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-archived-list-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/archived-list/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/archived-list/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', plugins: [quietNeighbours], loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/archived-list/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_ARCHIVED_LIST_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    const all = JSON.stringify(evidence)

    // The count is the whole list; the cards drawn are a footer's worth, and the footer scrolls over all of them.
    expect(evidence.open.count, all).toBe('600')
    expect(evidence.open.drawn, all).toBeGreaterThan(0)
    expect(evidence.open.drawn, all).toBeLessThanOrEqual(DRAWN_AT_MOST)
    expect(evidence.open.first?.id, all).toBe('old-0')
    expect(evidence.open.blank, all).toEqual([])
    expect(evidence.open.room, all).toBeGreaterThan(600 * 30)

    // At the end: the last row is on screen, drawn cards stay few, and nothing in view is blank.
    expect(evidence.end.last, all).toBe('old-599')
    expect(evidence.end.scrollTop, all).toBeGreaterThanOrEqual(evidence.end.room - 1)
    expect(evidence.end.drawn, all).toBeLessThanOrEqual(DRAWN_AT_MOST)
    expect(evidence.end.blank, all).toEqual([])
    // Only the list scrolls: the Archived heading stays in view at the end of a long list.
    expect(evidence.open.headingShown, all).toBe(true)
    expect(evidence.end.headingShown, all).toBe(true)

    // Halfway: no blank band, and the row at the top does not move while the cards drawn there are measured.
    expect(evidence.middle.before.blank, all).toEqual([])
    expect(evidence.middle.after.first, all).toEqual(evidence.middle.before.first)

    // A focused row scrolled far away stays focused (it stays drawn), and the window still moved to the top.
    expect(evidence.focusAway.focused, all).toBe(true)
    expect(evidence.focusAway.first?.id, all).toBe('old-0')
    expect(evidence.focusAway.drawn, all).toBeLessThanOrEqual(DRAWN_AT_MOST + 1)

    // The last row's own menu opens and acts on it.
    expect(evidence.lastRowMenu.found, all).toBe(true)
    expect(evidence.lastRowMenu.items.some((item) => item?.includes('Unarchive')), all).toBe(true)

    // Opening an archived thread opens Archived and shows its row whole, far down the long list and after a short
    // list's opening motion.
    for (const reveal of [evidence.revealFar, evidence.revealAfterOpening]) {
      expect(reveal.open, all).toBe(true)
      expect(reveal.row, all).not.toBeNull()
      expect(reveal.row!.top, all).toBeGreaterThanOrEqual(reveal.view.top - 1)
      expect(reveal.row!.bottom, all).toBeLessThanOrEqual(reveal.view.bottom + 1)
    }

    expect(evidence.pageErrors, all).toEqual([])
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected archived list fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
