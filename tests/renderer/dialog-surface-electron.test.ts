/**
 * New bot over a busy bot chat, in a real Chromium window with the app's CSS: nothing of the chat shows through the
 * dialog or its Name and "What should it do?" fields, in the default theme, dark and light, with acrylic off and on.
 * Each surface is captured with the chat behind it shown and hidden; any pixel that changes is the chat showing
 * through. The dialog also sits centred in the window. Set MOUSSE_DIALOG_SURFACE_SHOTS to a folder to keep a picture
 * of each case.
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

type Box = { left: number; top: number; right: number; bottom: number }
type Through = { pixels: number; differ: number; sameSize: boolean }
type Case = { theme: string; acrylic: boolean; window: { width: number; height: number }; dialog: Box; panel: Through; nameField: Through; textField: Through }

it('shows nothing of the chat through New bot or its fields, centred, in every theme with acrylic off and on', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-dialog-surface-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/dialog-surface/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/dialog-surface/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/dialog-surface/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_DIALOG_SURFACE_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as { cases: Case[]; pageErrors: string[] }
    expect(result.pageErrors).toEqual([])
    const name = ({ theme, acrylic }: Case) => `${theme}${acrylic ? '+acrylic' : ''}`
    expect(result.cases.map(name)).toEqual(['blacksphere-plus', 'blacksphere-plus+acrylic', 'dark', 'dark+acrylic', 'light', 'light+acrylic'])
    const surfaces = ['panel', 'nameField', 'textField'] as const
    for (const entry of result.cases) {
      for (const surface of surfaces) expect(entry[surface].sameSize && entry[surface].pixels > 500, `${name(entry)}: ${surface} was captured`).toBe(true)
    }
    // Pixels of the chat showing through each surface, every case at once.
    const through = Object.fromEntries(result.cases.map((entry) => [name(entry), Object.fromEntries(surfaces.map((surface) => [surface, entry[surface].differ]))]))
    expect(through).toEqual(Object.fromEntries(result.cases.map((entry) => [name(entry), { panel: 0, nameField: 0, textField: 0 }])))
    for (const entry of result.cases) {
      const where = name(entry)
      // Centred, with room on both sides.
      const left = entry.dialog.left, right = entry.window.width - entry.dialog.right
      expect(left, `${where}: ${JSON.stringify(entry.dialog)}`).toBeGreaterThan(0)
      expect(Math.abs(left - right), `${where}: ${JSON.stringify(entry.dialog)}`).toBeLessThan(1.5)
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected dialog surface fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
