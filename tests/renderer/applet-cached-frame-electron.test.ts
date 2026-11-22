import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

// An applet's live view is see-through: the host page under it shows wherever the applet paints nothing. The frame
// cached for scrolling lies in that host page, so it must not be drawn there while the live view is, or its old pixels
// show through the new ones (a timer reading "0:37" with a faded "3" under the "7").
it("keeps an applet's cached frame out from under its live view, and shows it while the transcript scrolls", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-applet-cached-frame-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    const loader = { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } as const
    await build({ entryPoints: [resolve('tests/fixtures/applet-cached-frame/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('src/preload/index.ts')], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['electron'] })
    await build({ entryPoints: [resolve('tests/fixtures/applet-cached-frame/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    writeFileSync(join(directory, 'index.html'), '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><style>body{margin:0;background:#000}</style><div id="root"></div><script src="entry.js"></script></html>')
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_APPLET_CACHED_FRAME_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as { live: boolean; scrolling: boolean }
    // Under the live view the host page shows nothing of the cached frame; while scrolling it shows the frame.
    expect(evidence).toEqual({ live: false, scrolling: true })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected applet fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
