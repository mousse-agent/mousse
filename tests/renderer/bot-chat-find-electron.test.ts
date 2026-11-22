/**
 * Find in a bot's chat while its reply streams, in a real Chromium window: Previous to a match in a message that is not
 * loaded or drawn yet takes the reader there and keeps them there. The chat stops following the reply's end, and a
 * scroll that still finds the end before the match is drawn does not make it follow again and pull the reader back.
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

type View = { count: string | null; message: string | null; inView: boolean; fromEnd: number }
type Evidence = { following: View; before: View; after: View[]; liveBefore: number; liveAfter: number; pageErrors: string[]; rendererErrors: string[] }

it('keeps a bot chat on the older match Find\'s Previous took it to while the reply streams, also when that message had to be loaded and drawn first', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-bot-chat-find-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/bot-chat-find/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-chat-find/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, plugins: [NO_MICROPHONE], define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/bot-chat-find/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_BOT_CHAT_FIND_DIRECTORY: directory }
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

    // Before Find, the chat followed the streaming reply's end; Find started at the newest match, on screen.
    expect(evidence.following.fromEnd, all).toBeLessThan(40)
    expect(evidence.before, all).toMatchObject({ count: '2 of 2', message: 'm160', inView: true })
    // The reply kept streaming the whole time.
    expect(evidence.liveAfter, all).toBeGreaterThan(evidence.liveBefore)

    // Previous lands on the oldest message's match, once it is loaded and drawn ...
    const landed = evidence.after.findIndex((view) => view.message === 'm1' && view.inView)
    expect(landed, all).toBeGreaterThanOrEqual(0)
    // ... and from then on it stays in view and the chat stays far from its end, frame after frame.
    for (const view of evidence.after.slice(landed)) {
      expect(view, all).toMatchObject({ count: '1 of 2', message: 'm1', inView: true })
      expect(view.fromEnd, all).toBeGreaterThan(1000)
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected bot chat fixture cleanup path')
    if (!process.env.MOUSSE_BOT_CHAT_FIND_KEEP) rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
