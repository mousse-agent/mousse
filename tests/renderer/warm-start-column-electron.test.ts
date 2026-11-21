/**
 * The warm start's transcript in a real Chromium window, with the app's CSS: the live chat takes its place without
 * moving a pixel of it. The column, the composer, each turn and a wide table sit where the warm view put them, in every
 * frame from the first warm one until the live chat has been on screen for a while, in a window wide enough that the
 * thread details card docks beside the conversation.
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

/** The app's global.css is compiled by Tailwind into styles.css; the bundle's copy keeps only the app's own rules. */
const APP_CSS_ONLY: Plugin = { name: 'app-css-only', setup(builder) {
  builder.onLoad({ filter: /[/\\]styles[/\\]global\.css$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace('@import "tailwindcss";', '').replace(/^@source .*;\r?\n/gm, '').replace(/^@custom-variant [\s\S]*?^\}\r?\n/gm, ''), loader: 'css' }))
  // Vite's `?url` imports (dictation's noise-suppressor assets) only need a URL string here.
  builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }))
  builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, args => ({ contents: `export default ${JSON.stringify(args.path)}`, loader: 'js' }))
} }

type Frame = { fonts: string; warm: boolean; column: number[]; composer: number[] | null; turns: number[]; table: number[] | null; text: number }

it('lays the live transcript out exactly where the warm one was: column, composer, turns and a wide table', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-warm-start-column-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/warm-start-column/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/warm-start-column/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, plugins: [APP_CSS_ONLY], define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/warm-start-column/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_WARM_START_COLUMN_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as { frames: Frame[]; pageErrors: string[] }
    expect(evidence.pageErrors).toEqual([])

    const { frames } = evidence
    const warm = frames.filter(frame => frame.warm)
    const live = frames.filter(frame => !frame.warm)
    expect(warm.length).toBeGreaterThan(0)
    expect(live.length).toBeGreaterThan(0)
    // The live chat shows the same messages.
    expect(live.at(-1)!.text).toBe(warm[0]!.text)
    expect(warm[0]!.table).not.toBeNull()
    // From the first warm frame on, the column and the composer keep their place and width (the card's room is kept
    // before the card shows).
    const across = ({ column, composer }: Frame) => JSON.stringify({ left: column[0], width: column[2], composer: composer && [composer[0], composer[2]] })
    expect(frames.filter(frame => across(frame) !== across(warm[0]!)).map(across), across(warm[0]!)).toEqual([])
    // Once the fonts are in (the fixture's load a moment after the first frame), every frame, warm or live, lays the
    // transcript out as the warm view did: the same column, composer, turns and table, to the tenth of a pixel.
    const layout = ({ column, composer, turns, table }: Frame) => JSON.stringify({ column, composer, turns, table })
    const settled = frames.filter(frame => frame.fonts === 'loaded')
    const reference = settled.find(frame => frame.warm)
    expect(reference).toBeDefined()
    expect(settled.filter(frame => layout(frame) !== layout(reference!)).map(frame => `${frame.warm ? 'warm' : 'live'} ${layout(frame)}`), layout(reference!)).toEqual([])
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected warm start fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
