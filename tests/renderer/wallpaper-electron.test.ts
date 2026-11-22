/**
 * A theme's wallpaper in a real Chromium window (`src/renderer/lib/wallpaper.ts`), against an in-memory daemon: the
 * window makes a display-sized copy from the original once, turned upright by the image's EXIF rotation, and the
 * daemon's own check takes it (edges compared long to long); an appearance change and a second window never read the
 * original again; a profile switch takes the wallpaper off and releases its URL; a kept copy that does not decode is
 * made again once and replaces the broken one. The contrast floor is measured against the page's own colours. Under
 * acrylic the layer is drawn see-through, with no solid colour, and its floor is measured for what shows through.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('makes the copy once from an EXIF-rotated original, reuses it, drops it on a profile switch and rebuilds a broken one', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-wallpaper-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/wallpaper/entry.ts')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
    await build({ entryPoints: [resolve('tests/fixtures/wallpaper/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_WALLPAPER_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))

    expect(evidence.shown).toBe(true)
    // Stored landscape 64x32 with orientation 6: the copy is upright, 32x64, and the daemon's check takes it.
    expect(evidence.copy).toEqual({ type: 'image/webp', width: 32, height: 64 })
    expect(evidence.copyAccepted).toEqual({ bucket: 1920, replace: false, accepted: true })
    // Half white under a dark theme: the floor raises the 10% dim; the scrim is the larger of the two.
    expect(evidence.first).toMatchObject({ dim: 0.1, base: 'rgb(16 20 24)', fit: 'cover', url: true })
    expect(evidence.first.floor).toBeGreaterThan(0.5)
    expect(evidence.first.scrim).toBe(evidence.first.floor)
    // The original is decoded once: not again for an appearance change, nor for a second window.
    expect(evidence.readsAfterFirstWindow).toBe(1)
    expect(evidence.readsAfterSecondWindow).toBe(1)
    expect(evidence.afterSwitch).toEqual({ layer: null, attribute: false, variable: '' })
    expect(evidence.oldUrlReleased).toBe(true)
    // A broken kept copy: the original is read once more, and the new copy replaces the old one.
    expect(evidence.rebuilt).toMatchObject({ originalReads: 2, shown: true })
    expect(evidence.rebuilt.saves[1]).toEqual({ bucket: 1920, replace: true, accepted: true })
    // Drawn on a solid window: the theme's colour fills the layer and all of it shows.
    expect(evidence.drawn.solid).toEqual({ opacity: '1', backgroundColor: 'rgb(16, 20, 24)', image: true })
    // Under acrylic: no solid colour and part of the layer shows, so the window's glass shows through it; the floor is
    // measured for that (the half-white image still needs a scrim) rather than for a solid base.
    expect(evidence.drawn.acrylic).toEqual({ opacity: '0.55', backgroundColor: 'rgba(0, 0, 0, 0)', image: true })
    expect(evidence.drawn.acrylicLayer.opacity).toBe(0.55)
    expect(evidence.drawn.acrylicLayer.floor).toBeGreaterThan(0)
    expect(evidence.drawn.acrylicLayer.floor).not.toBeCloseTo(evidence.drawn.solidFloor, 3)
    // Acrylic off again: drawn as before.
    expect(evidence.drawn.offAgain).toEqual(evidence.drawn.solid)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected wallpaper fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
