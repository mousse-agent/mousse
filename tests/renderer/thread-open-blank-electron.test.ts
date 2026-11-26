import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type View = { rowsInView: number; reserve: number; live: number | null; clientHeight: number; windowed: boolean }
type Evidence = { opens: Record<string, View[]>; pageErrors: string[]; rendererErrors: string[] }

it('shows the end of a running thread when it opens, never a blank view', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-thread-open-blank-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The list's layout is app CSS and Tailwind utilities: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/thread-open-blank/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/thread-open-blank/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/thread-open-blank/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_THREAD_OPEN_BLANK_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    expect(result.pageErrors).toEqual([])
    expect(result.rendererErrors).toEqual([])
    for (const [name, samples] of Object.entries(result.opens)) {
      const where = `${name}: ${JSON.stringify(samples)}`
      expect(samples[0]!.windowed, where).toBe(true)
      // Every frame after the first paint: the reply in progress is on screen, near the bottom, and no empty space
      // stands in for the content.
      for (const sample of samples.slice(1)) {
        expect(sample.rowsInView, where).toBeGreaterThan(0)
        expect(sample.live, where).not.toBeNull()
        expect(sample.live!, where).toBeGreaterThan(0)
        expect(sample.live!, where).toBeLessThanOrEqual(sample.clientHeight)
        expect(sample.reserve, where).toBe(0)
      }
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected thread open fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
