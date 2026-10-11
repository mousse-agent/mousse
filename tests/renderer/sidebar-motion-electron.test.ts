import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('animates real sidebar layout, clips behind the rail, reverses safely, and respects reduced motion', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-sidebar-motion-')))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await Promise.all([
      build({ entryPoints: [resolve('tests/fixtures/sidebar-motion/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }),
      build({ entryPoints: [resolve('tests/fixtures/sidebar-motion/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
    ])
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}</style><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_SIDEBAR_MOTION_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-6000) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-6000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.ok, JSON.stringify(report)).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.initial).toMatchObject({ width: 281, children: 1, inert: false, railHit: true, navigationIconWidth: 18, rowIconWidth: 16, svgRefReady: true })
    expect(report.selected.dot).toBe('none')
    expect(report.selected.status).not.toBe('none')
    expect(report.selected.project).not.toBe('rgba(0, 0, 0, 0)')
    expect(report.selected.thread).not.toBe('rgba(0, 0, 0, 0)')
    expect(report.selected.rail).toContain('0px 0px 0px 1px')
    for (const sample of [...report.close, ...report.open, ...report.reverse.close, ...report.reverse.open, ...report.resizedClose]) {
      expect(Math.abs(sample.centerLeft - sample.railRight - sample.width)).toBeLessThan(1)
      expect(sample.railHit).toBe(true)
      expect(sample.clip).toBe('hidden')
    }
    expect(report.close.some((row: any) => row.width > 15 && row.width < 265)).toBe(true)
    expect(report.close.some((row: any) => row.contentLeft < row.railRight)).toBe(true)
    expect(report.close.at(-1)).toMatchObject({ width: 0, children: 0, inert: true, focus: 'titlebar-sidebar-toggle' })
    expect(report.open.some((row: any) => row.width > 15 && row.width < 265), JSON.stringify(report.open)).toBe(true)
    expect(report.open.at(-1)).toMatchObject({ width: 281, children: 1 })
    expect(report.reverse.before.width).toBeGreaterThan(0)
    expect(report.reverse.before.width).toBeLessThan(281)
    expect(Math.abs(report.reverse.open[0].width - report.reverse.before.width)).toBeLessThan(80)
    expect(report.reverse.open.at(-1)).toMatchObject({ width: 281, children: 1, mounts: report.reverse.before.mounts })
    expect(report.resize).toMatchObject({ width: 331, savedWidth: 330 })
    expect(report.resizedClose.at(-1)).toMatchObject({ width: 0, children: 0, savedWidth: 330 })
    for (const sample of [...report.peekOpen, ...report.peekClose]) {
      expect(sample.centerLeft).toBe(sample.railRight)
      expect(sample.railHit).toBe(true)
    }
    expect(report.peekOpen.some((row: any) => row.overlayContentLeft < row.railRight)).toBe(true)
    expect(report.peekClose.at(-1)).toMatchObject({ overlayVisible: 'hidden', overlayInert: true, overlayHit: false })
    // React may commit after the first sample, but reduced motion must never
    // produce an intermediate layout width in either direction.
    for (const sample of [...report.reducedOpen, ...report.reducedClose]) {
      expect([0, 331]).toContain(sample.width)
      expect(sample.reduced).toBe(true)
    }
    expect(report.reducedOpen.at(-1)).toMatchObject({ width: 331, children: 1 })
    expect(report.reducedClose.at(-1)).toMatchObject({ width: 0, children: 0, inert: true })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-sidebar-motion-')) throw new Error('Refusing cleanup outside owned sidebar fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 25000)
