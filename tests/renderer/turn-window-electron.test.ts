import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Opened = {
  mounted: number; range: { first: number; last: number }; windowed: boolean; spacers: number
  first: boolean; last: boolean; far: boolean; endGap: number; scrollHeight: number; clientHeight: number
}
type Position = {
  fraction: number; mounted: number; range: { first: number; last: number }; visible: number; visibleMounted: boolean; middle: boolean
  first: boolean; last: boolean; farBelow: boolean; farAbove: boolean
}
type Sweep = { drift: number[]; scrollHeightDelta: number }
type Evidence = {
  t200: number; t1000: number; mounted200: number; opened: Opened; positions: Position[]
  hold: { text: string; row: number; top: number }
  held: { start: number; scrollTop: number; afterAbove: number; afterSameRow: number; afterBelow: number; belowScrollTopDelta: number }
  up: Sweep; down: Sweep; afterSweeps: { mounted: number; first: boolean; last: boolean }
  followGaps: number[]; leftEnd: { scrollTop: number; jumpVisible: boolean; gap: number }
  readingAfterStream: { scrollTop: number; top: number; startTop: number; startScrollTop: number }
  jumpFrames: number; jumped: { gap: number; jumpVisible: boolean; mounted: number; last: boolean }
  turnFrames: number; afterTurn: { gap: number; mounted: number; range: { first: number; last: number } }
  markerFrames: number; marker: { top: number; mounted: boolean; count: number }
  interrupted: { at: number; later: number; top: number | null }
  small: { windowed: boolean; mounted: number; spacers: number }; grown: { windowed: boolean; mounted: number; gap: number }
  pageErrors: string[]; rendererErrors: string[]
}

it('mounts only the turns near the viewport of a long thread and holds the reading line while it scrolls and grows', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-turn-window-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The list's layout is Tailwind utilities (`flex`, `gap-6`, `overflow-y-auto`): compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/turn-window/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/turn-window/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/turn-window/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_TURN_WINDOW_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    console.info(`turn window: mount 200 turns ${result.t200.toFixed(0)} ms, 1000 turns ${result.t1000.toFixed(0)} ms`)

    expect(result.rendererErrors).toEqual([])
    expect(result.pageErrors).toEqual([])

    // A thread of 1,000 turns opens at the bottom with at most 60 rows mounted, the first and last among them.
    expect(result.opened.windowed).toBe(true)
    expect(result.opened.mounted).toBeLessThanOrEqual(60)
    expect(result.opened.first && result.opened.last).toBe(true)
    expect(result.opened.far).toBe(false)
    expect(result.opened.spacers).toBeGreaterThan(0)
    expect(result.opened.endGap).toBeLessThan(2)
    expect(result.opened.scrollHeight).toBeGreaterThan(result.opened.clientHeight * 50)
    expect(result.mounted200).toBeLessThanOrEqual(60)

    // Scrolling moves the window: the turn in view is mounted, turns 300 away are not.
    expect(result.positions).toHaveLength(5)
    for (const position of result.positions) {
      expect(position.mounted, `fraction ${position.fraction}`).toBeLessThanOrEqual(60)
      expect(position.first && position.last, `fraction ${position.fraction}`).toBe(true)
      expect(position.visibleMounted, `fraction ${position.fraction}`).toBe(true)
      if (position.visible > 300 && position.visible < 700) {
        expect(position.farBelow && position.farAbove, `fraction ${position.fraction}`).toBe(false)
      }
    }
    expect(new Set(result.positions.map(position => position.visible)).size).toBe(5)
    // Turn 500 is not mounted with the top of the thread in view and is once the middle is.
    expect(result.positions[2]!.middle).toBe(true)
    expect(result.positions[0]!.middle).toBe(false)
    expect(result.positions[2]!.visible).toBeGreaterThan(200)
    expect(result.positions[2]!.visible).toBeLessThan(800)

    // The paragraph at the reading line stays within 2 px while rows above it grow, in or out of its own row.
    expect(result.hold.row).toBeGreaterThan(0)
    expect(result.held.start).toBeLessThan(0)
    expect(Math.abs(result.held.afterAbove - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.afterSameRow - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.afterBelow - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.belowScrollTopDelta)).toBeLessThanOrEqual(1)

    // The user's own motion is the only thing that moves it, through rows measured far from their estimates.
    for (const sweep of [result.up, result.down]) {
      expect(sweep.drift.length).toBeGreaterThanOrEqual(40)
      expect(Math.max(...sweep.drift.map(Math.abs))).toBeLessThanOrEqual(2)
    }
    expect(result.up.scrollHeightDelta + result.down.scrollHeightDelta).toBeGreaterThan(300)
    expect(result.afterSweeps.mounted).toBeLessThanOrEqual(60)
    expect(result.afterSweeps.first && result.afterSweeps.last).toBe(true)

    // Following the end holds it while the answer streams; a wheel up leaves it and the reading position stays.
    expect(Math.max(...result.followGaps)).toBeLessThan(2)
    expect(result.leftEnd.jumpVisible).toBe(true)
    expect(result.leftEnd.gap).toBeGreaterThan(100)
    expect(Math.abs(result.readingAfterStream.scrollTop - result.readingAfterStream.startScrollTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.readingAfterStream.top - result.readingAfterStream.startTop)).toBeLessThanOrEqual(2)

    // Jump to latest lands on the end, instantly, and the button goes away.
    expect(result.jumpFrames).toBeGreaterThanOrEqual(0)
    expect(result.jumped.gap).toBeLessThan(2)
    expect(result.jumped.jumpVisible).toBe(false)
    expect(result.jumped.last).toBe(true)
    expect(result.jumped.mounted).toBeLessThanOrEqual(60)

    // A new turn while following brings its row and the end into view.
    expect(result.turnFrames).toBeGreaterThanOrEqual(0)
    expect(result.afterTurn.gap).toBeLessThan(2)
    expect(result.afterTurn.mounted).toBeLessThanOrEqual(60)
    expect(result.afterTurn.range.last).toBe(1000)

    // A marker jump to a prompt that was not mounted lands on it; a wheel during a jump is not undone.
    expect(result.markerFrames).toBeGreaterThanOrEqual(0)
    expect(result.marker.mounted).toBe(true)
    expect(Math.abs(result.marker.top - 16)).toBeLessThanOrEqual(2)
    expect(result.marker.count).toBeLessThanOrEqual(60)
    expect(Math.abs(result.interrupted.later - result.interrupted.at)).toBeLessThanOrEqual(2)
    expect(result.interrupted.top === null || Math.abs(result.interrupted.top - 16) > 100).toBe(true)

    // Threads up to 40 turns render every row; one that grows past that is windowed from then on.
    expect(result.small).toEqual({ windowed: false, mounted: 40, spacers: 0 })
    expect(result.grown.windowed).toBe(true)
    expect(result.grown.mounted).toBeLessThanOrEqual(41)
    expect(result.grown.gap).toBeLessThan(2)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected turn window fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 180000)
