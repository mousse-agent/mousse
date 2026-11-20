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
type Evidence = {
  steers: { id: string; item: Box; message: Box; bubble: Box; actions: Box }[]
  bar: { windowWidth: number; selectionRight: number; bar: Box | null; buttons: string[] }
  pageErrors: string[]; rendererErrors: string[]
}

it('puts a steer\'s actions beside its bubble, adding no height to the stack, and keeps the selected text bar inside the window', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-steer-selection-actions-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // Placement is app CSS and Tailwind utilities: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/steer-and-selection-actions/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/steer-and-selection-actions/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/steer-and-selection-actions/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_STEER_SELECTION_ACTIONS_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    expect(result.pageErrors).toEqual([])

    expect(result.steers.map((steer) => steer.id)).toEqual(['s1', 's2', 's3'])
    for (const steer of result.steers) {
      const where = JSON.stringify(steer)
      // No toolbar row under the bubble: the row is as tall as its message.
      expect(steer.item.height - steer.message.height, where).toBeLessThan(1)
      // Left of the bubble, at its foot, never over it.
      expect(steer.actions.right, where).toBeLessThanOrEqual(steer.bubble.left + 0.5)
      expect(Math.abs(steer.actions.bottom - steer.item.bottom), where).toBeLessThan(1)
      // A long steer keeps a prompt's 80% cap.
      expect(steer.bubble.width, where).toBeLessThanOrEqual(steer.item.width * 0.8 + 1)
    }

    const { bar, windowWidth, selectionRight, buttons } = result.bar
    expect(buttons).toEqual(['Read aloud', 'Reply to the selected text'])
    // The selection ends too near the right edge for the bar to start there: it moves left by its own width.
    expect(selectionRight + bar!.width, JSON.stringify(result.bar)).toBeGreaterThan(windowWidth)
    expect(bar!.right, JSON.stringify(result.bar)).toBeLessThanOrEqual(windowWidth - 8 + 0.5)
    expect(bar!.left).toBeGreaterThanOrEqual(8)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
