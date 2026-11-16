/**
 * The app's frame in a real Chromium window, with the app's CSS: nothing scrolls the page, body, #root, .app,
 * .app-content, .main-area or .keep-mounted-pane, whether told to outright or by scrollIntoView or focus on a row deep
 * in a pane ("Pick a model" once moved the whole app up and left), and "Pick a model" now scrolls the About panel alone.
 * Chromium does scroll a plain overflow: hidden box, which the control case shows.
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

type Shell = Record<string, { top: number; left: number }>
type Evidence = {
  scrollIntoView: { shell: Shell; panel: number }; focus: { shell: Shell; panel: number }
  centerWithin: { shell: Shell; panel: number; panelMax: number }; assign: { shell: Shell }; hiddenFrame: { shell: Shell }
  control: number; rendererErrors: string[]
}

it('keeps the app frame and the page at their origin whatever scrolls into view, and scrolls only the About panel to Runs on', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-shell-scroll-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/shell-scroll/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/shell-scroll/entry.ts')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent' })
    await build({ entryPoints: [resolve('tests/fixtures/shell-scroll/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_SHELL_SCROLL_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    const all = JSON.stringify(evidence)
    const unmoved = (shell: Shell, where: string) => {
      for (const [box, { top, left }] of Object.entries(shell)) expect({ box, top, left }, `${where}: ${all}`).toEqual({ box, top: 0, left: 0 })
    }
    // Chromium scrolls an overflow: hidden box for scrollIntoView: the danger is real.
    expect(evidence.control, all).toBeGreaterThan(0)
    // The page and every frame box, told to scroll outright, stay put.
    unmoved(evidence.assign.shell, 'assigned')
    unmoved(evidence.scrollIntoView.shell, 'scrollIntoView')
    expect(evidence.scrollIntoView.panel, all).toBeGreaterThan(0)
    unmoved(evidence.focus.shell, 'focus')
    // "Pick a model": the panel at its end (Runs on is last), nothing else.
    unmoved(evidence.centerWithin.shell, 'centerWithin')
    expect(evidence.centerWithin.panel, all).toBe(evidence.centerWithin.panelMax)
    unmoved(evidence.hiddenFrame.shell, 'frame set back to overflow: hidden')
    expect(evidence.rendererErrors).toEqual([])
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected shell scroll fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
