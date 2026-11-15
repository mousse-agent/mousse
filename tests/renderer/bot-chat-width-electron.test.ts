/**
 * A narrow bot chat in a real Chromium window, with the app's CSS: replies whose bubbles fill their width never give the
 * transcript a sideways scrollbar. Their tools (reactions, Read aloud, Copy, Reply) hang off the bubble's right edge;
 * hidden they take no width, and shown (a real pointer on the reply, or Tab through them to Copy and Reply) they sit inside the
 * transcript, also when it narrows while they are open.
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

/** The composer's microphone loads noise-suppression audio files this test never plays: its module is left out, as in the jsdom chat tests. */
const NO_MICROPHONE: Plugin = { name: 'no-microphone', setup(builder) {
  builder.onResolve({ filter: /^\.\/microphone$/ }, ({ importer }) => (/[\\/]dictation[\\/]/.test(importer) ? { path: 'microphone', namespace: 'no-microphone' } : undefined))
  builder.onLoad({ filter: /.*/, namespace: 'no-microphone' }, () => ({ contents: 'export function openMicrophone() { throw new Error("no microphone in this test") }', loader: 'js' }))
} }

type Measured = { width: number; scrollWidth: number; clientWidth: number; open?: boolean; over?: number }
type AppletWidth = { reply: number; applet: number; bubble: number }
type Evidence = {
  hidden: Measured; hover: Record<string, Measured>; afterHover: Measured
  keyboard: Record<string, { focused: boolean; reached: string[]; measured: Record<string, Measured> }>
  roomy: Measured; narrowed: Measured; pageErrors: string[]; rendererErrors: string[]
  appletNarrow: AppletWidth; appletRoomy: AppletWidth
}

it('keeps a narrow bot chat free of sideways scroll (tools hidden, shown by pointer or keyboard, open while it narrows), with applets across the whole reply', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-chat-width-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The tools' buttons are styled with Tailwind classes: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/bot-chat-width/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-chat-width/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, plugins: [NO_MICROPHONE], define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-chat-width/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_BOT_CHAT_WIDTH_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    const all = JSON.stringify(evidence)
    expect(evidence.pageErrors).toEqual([])

    const noSidewaysScroll = (measured: Measured, where: string) => expect(measured.scrollWidth, `${where}: ${all}`).toBeLessThanOrEqual(measured.clientWidth)
    // Nothing hovered or focused.
    noSidewaysScroll(evidence.hidden, 'tools hidden')
    // Tab walks each reply's tools to Copy, then Reply.
    for (const [id, { focused, reached }] of Object.entries(evidence.keyboard)) {
      expect(focused, `${id}: ${all}`).toBe(true)
      expect(reached.slice(-2), `${id}: ${all}`).toEqual(['Copy', 'Reply'])
    }
    const shown = [
      ...Object.entries(evidence.hover).map(([id, m]) => [`hover ${id}`, m] as const),
      ...Object.entries(evidence.keyboard).flatMap(([id, { measured }]) => Object.entries(measured).map(([label, m]) => [`Tab to ${label} in ${id}`, m] as const))
    ]
    expect(shown.length).toBe(6)
    for (const [where, measured] of shown) {
      // Shown, inside the transcript.
      expect(measured.open, `${where}: ${all}`).toBe(true)
      expect(measured.over, `${where}: ${all}`).toBeLessThanOrEqual(0)
      noSidewaysScroll(measured, where)
    }
    noSidewaysScroll(evidence.afterHover, 'after the pointer left')
    // Open while the pane narrows: the control shows the tools fit at the roomy width, then they move in.
    expect(evidence.roomy.width).toBeGreaterThan(evidence.narrowed.width)
    noSidewaysScroll(evidence.roomy, 'open, roomy')
    // Left where they were, they would stick out of the narrowed transcript.
    expect(evidence.roomy.over! + (evidence.roomy.clientWidth - evidence.narrowed.clientWidth), all).toBeGreaterThan(0)
    expect(evidence.narrowed.open, all).toBe(true)
    expect(evidence.narrowed.over, all).toBeLessThanOrEqual(0)
    noSidewaysScroll(evidence.narrowed, 'open while it narrowed')

    // An applet takes the whole reply width, narrow or roomy; a bubble that fills its width keeps the gutter on its right.
    for (const [where, widths] of [['narrow', evidence.appletNarrow], ['roomy', evidence.appletRoomy]] as const) {
      expect(widths.applet, `applet, ${where}: ${all}`).toBeGreaterThanOrEqual(widths.reply - 1)
      expect(widths.bubble, `bubble, ${where}: ${all}`).toBeLessThanOrEqual(widths.reply * 0.86 + 1)
    }
    expect(evidence.appletRoomy.applet, all).toBeGreaterThan(evidence.appletNarrow.applet)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected bot chat fixture cleanup path')
    if (!process.env.MOUSSE_BOT_CHAT_WIDTH_KEEP) rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
