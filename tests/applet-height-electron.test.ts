import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

/**
 * An applet's frame follows its content in real layout: short pages shrink below the old 320 px start, tall ones grow
 * to the cap and scroll inside above it, and pages sized to the frame (published before the publish check) settle
 * instead of growing their frame without end.
 */
it('reports each applet page at its own content height, bounded, and never follows its own frame', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-applet-height-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/applet-height/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_APPLET_HEIGHT_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const { reports, errors } = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as { reports: Record<string, number[]>; errors: string[] }
    expect(errors).toEqual([])
    const last = (name: string) => reports[name].at(-1)

    // The content's own height, from a 320 px start.
    expect(last('short')).toBe(80)
    expect(last('margins')).toBe(88)
    expect(last('tall')).toBe(2500)
    // Bounded: an empty page keeps a visible row, a taller one stops at the cap and scrolls inside.
    expect(last('empty')).toBe(32)
    expect(last('huge')).toBe(4096)
    // It follows later changes both ways.
    expect(reports.changes).toEqual([400, 600, 120])

    // Sized to the frame: at most one report after the first, then still, well short of the cap.
    for (const name of ['legacyMinHeight', 'legacyTaller', 'legacyRatio', 'legacyFull']) {
      expect(reports[name].length, `${name}: ${reports[name].join(', ')}`).toBeGreaterThan(0)
      expect(reports[name].length, `${name}: ${reports[name].join(', ')}`).toBeLessThanOrEqual(2)
      expect(last(name)!, name).toBeLessThan(400)
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected applet height fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
