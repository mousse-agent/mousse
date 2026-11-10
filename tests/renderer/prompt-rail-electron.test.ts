import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Rail = { ticks: number; textLeft: number; railRight: number | null; paneLeft: number; railLeft: number | null; scrolls: boolean }

/** The rail shows one dash per prompt, close to the pane's left edge, and stays clear of the transcript's text. */
const beside = (rail: Rail, prompts: number) => {
  expect(rail.ticks).toBe(prompts)
  expect(rail.railLeft).not.toBeNull()
  expect(rail.railLeft! - rail.paneLeft).toBeGreaterThanOrEqual(0)
  expect(rail.railLeft! - rail.paneLeft).toBeLessThanOrEqual(16)
  expect(rail.textLeft - rail.railRight!).toBeGreaterThanOrEqual(8)
}

it('shows the prompt rail in every thread with two or more prompts and keeps it beside the moving column', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-prompt-rail-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The list's layout is Tailwind utilities: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/prompt-rail/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/prompt-rail/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/prompt-rail/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_PROMPT_RAIL_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Record<'shortThread' | 'fits' | 'single' | 'longThread' | 'narrow' | 'wide' | 'switched' | 'arrived' | 'unhidden' | 'docked' | 'undocked' | 'dockedWide' | 'windowed', Rail> & { rendererErrors: string[] }
    // Screenshots for a PR, when asked for.
    if (process.env.MOUSSE_PROMPT_RAIL_SHOTS) {
      mkdirSync(process.env.MOUSSE_PROMPT_RAIL_SHOTS, { recursive: true })
      for (const file of readdirSync(directory).filter(name => name.endsWith('.png'))) copyFileSync(join(directory, file), join(process.env.MOUSSE_PROMPT_RAIL_SHOTS, file))
    }
    expect(result.rendererErrors).toEqual([])
    // Short threads have the rail too: six short replies (under three screens) and two that fit on the screen.
    beside(result.shortThread, 6)
    expect(result.fits.scrolls).toBe(false)
    beside(result.fits, 2)
    // A single prompt has nothing to move between.
    expect(result.single.ticks).toBe(0)
    beside(result.longThread, 12)
    // A pane too narrow to keep the rail clear of the text hides it; widening it brings it back.
    expect(result.narrow.ticks).toBe(0)
    beside(result.wide, 12)
    beside(result.switched, 6)
    beside(result.arrived, 12)
    beside(result.unhidden, 12)
    // The docked side card leaves too little room; once it goes, the rail comes back without anything resizing.
    expect(result.docked.ticks).toBe(0)
    beside(result.undocked, 12)
    // The card moves the column left and the rail follows it instead of lying over the text.
    beside(result.dockedWide, 12)
    beside(result.windowed, 80)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\')&& !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected prompt rail fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
