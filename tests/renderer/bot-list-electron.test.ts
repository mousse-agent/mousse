/**
 * The Chats sidebar's Bots list in a real Chromium window with the app's CSS, where the faces cannot draw in 3D (test
 * apps run without a GPU) and so show their flat drawing. What each bot does reads in words, coloured by state:
 * working purple, waiting on the owner amber, idle and paused grey. No row has a status dot. An idle bot sleeps at full
 * colour with its z in view; a paused one sleeps faded. The live face's CSS keeps a resting face at full colour and
 * fades a paused one. Each section folds from its title, its chevron turned down while open.
 *
 * Not here: the 3D drawing itself (a tipped head's ears in frame), which needs a GPU; botFace.test.ts checks the view
 * that follows the tipped head and that the draw moves the picture by it, and the PR shows it in screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
type Row = {
  name: string; text: string; colour: number[]; dots: number
  face: { tag: string; opacity: number; state: string | null }
  z: { text: string; rect: Box; opacity: number } | null
  row: Box
}
type Live = { canvasOpacity: number; zOpacity: number; zAnimation: string; zDisplay: string; z: Box; face: Box; zSettledOpacity: number | null }
type Measured = {
  sidebar: Box; rows: Row[]; colours: { secondary: number[]; warning: number[] }
  live: { paused: Live; resting: Live; restingStill: Live }
  sections: Array<{ title: string; expanded: string; chevron: string }>
  newBot: boolean
}
type Evidence = { open: Measured; botsFolded: Measured; groupsFolded: Measured; pageErrors: string[]; rendererErrors: string[] }

/** Rotated a quarter turn (the chevron pointing down), or not turned. */
const turned = (transform: string) => {
  const values = (transform.match(/-?[\d.e-]+/g) ?? []).map(Number)
  return transform !== 'none' && Math.abs(values[1]! - 1) < 0.01 && Math.abs(values[0]!) < 0.01
}

it('shows each bot’s state in coloured words with no status dots, idle bots asleep at full colour and paused ones faded, and sections that fold', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-list-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/bot-list/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-list/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-list/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_BOT_LIST_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    const all = JSON.stringify(evidence)
    expect(evidence.pageErrors, all).toEqual([])
    const { open } = evidence
    const row = (name: string) => open.rows.find((entry) => entry.name === name)!
    expect(open.rows.map((entry) => [entry.name, entry.text]), all).toEqual([
      ['Busy', 'Merging PR #1354'], ['Asking', 'Wants to use files on this computer'], ['Resting', 'Idle'], ['Off', 'Paused']
    ])

    // Working reads purple (blue strongest, then red), waiting on the owner reads amber (the app's warning colour),
    // and idle and paused read in the quiet grey of secondary text.
    const [r, g, b] = row('Busy').colour
    expect(b! > r! && r! > g!, all).toBe(true)
    expect(open.colours.secondary[3], all).toBeLessThan(1)
    expect(row('Asking').colour, all).toEqual(open.colours.warning)
    const [ar, ag, ab] = row('Asking').colour
    expect(ar! > ag! && ag! > ab!, all).toBe(true)
    expect(row('Resting').colour, all).toEqual(open.colours.secondary)
    expect(row('Off').colour, all).toEqual(open.colours.secondary)

    // No status dot anywhere in the list (the unread count is a number, not a dot).
    expect(open.rows.map((entry) => entry.dots), all).toEqual([0, 0, 0, 0])

    // The flat faces: the idle bot sleeps at full colour, the paused one faded; both show a z in view, inside the
    // row and the sidebar. The busy ones are awake and have no z.
    expect(open.rows.map((entry) => entry.face.tag), all).toEqual(['svg', 'svg', 'svg', 'svg'])
    expect([row('Resting').face, row('Off').face].map((face) => [face.state, face.opacity]), all).toEqual([['paused', 1], ['paused', 0.6]])
    expect([row('Busy').face.opacity, row('Asking').face.opacity], all).toEqual([1, 1])
    for (const name of ['Resting', 'Off']) {
      const { z, row: box } = row(name)
      expect(z?.text, all).toBe('z')
      expect(z!.rect.width, all).toBeGreaterThan(0)
      expect(z!.rect.left >= box.left && z!.rect.right <= box.right && z!.rect.right <= open.sidebar.right, all).toBe(true)
    }
    expect([row('Busy').z, row('Asking').z], all).toEqual([null, null])

    // The live face's CSS: a resting face keeps its colour, a paused one fades. Its z drifts up a few times and then
    // rests in view (no loop runs for as long as the bot is paused), and with motion off it rests in view.
    expect([open.live.resting.canvasOpacity, open.live.paused.canvasOpacity], all).toEqual([1, 0.6])
    expect(open.live.resting.zAnimation, all).toBe('bot-face-z, bot-face-z-settle')
    expect(open.live.resting.zSettledOpacity, all).toBeGreaterThan(0.5)
    expect([open.live.restingStill.zAnimation, open.live.restingStill.zDisplay], all).toEqual(['none', 'block'])
    expect(open.live.restingStill.zOpacity, all).toBeGreaterThan(0.5)
    expect(open.live.restingStill.z.right <= open.live.restingStill.face.right + 1 && open.live.restingStill.z.width > 0, all).toBe(true)

    // Every section starts open, its chevron turned down; folding one hides its rows, keeps +, and turns its chevron
    // back, leaving the others open.
    expect(open.sections.map((section) => [section.title, section.expanded, turned(section.chevron)]), all).toEqual([['Bots', 'true', true], ['Groups', 'true', true]])
    expect(evidence.botsFolded.rows, all).toEqual([])
    expect(evidence.botsFolded.newBot, all).toBe(true)
    expect(evidence.botsFolded.sections.map((section) => [section.title, section.expanded, turned(section.chevron)]), all).toEqual([['Bots', 'false', false], ['Groups', 'true', true]])
    expect(evidence.groupsFolded.rows.length, all).toBe(4)
    expect(evidence.groupsFolded.sections.map((section) => [section.title, section.expanded]), all).toEqual([['Bots', 'true'], ['Groups', 'false']])
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      await exited?.catch(() => undefined)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
