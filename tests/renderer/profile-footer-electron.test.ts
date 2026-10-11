import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('renders the bound profile footer and ignores stale replies after switching through its real menu', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-profile-footer-')))
  let child: ChildProcess | undefined, exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/profile-footer/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl', '.woff2': 'file' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/profile-footer/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>:root{--text-primary:#eee;--text-secondary:#aaa;--accent:#a99;--border:#333;--bg-secondary:#222;--titlebar-height:40px}body{margin:0;background:#111}#root{width:260px}.app{height:600px}</style><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_PROFILE_FOOTER_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.loading).toMatchObject({ loading: true, profile: 'prf_alpha', errors: [] })
    expect(report.first).toMatchObject({ name: 'Adithya', profile: 'prf_alpha', errors: [] })
    expect(report.afterLate).toMatchObject({ name: 'Studio', profile: 'prf_beta', errors: [] })
    expect(report.switched).toMatchObject({ name: 'Studio', profile: 'prf_beta', errors: [] })
    expect(report.switched.avatar).toMatch(/^data:image\/svg\+xml/)
    expect(report.binds).toEqual(['prf_beta'])
    expect(report.updates).toEqual([{ id: 'prf_alpha', displayName: 'Adithya local' }])
    expect(report.headings.map((heading: any) => heading.text)).toEqual(['Roster', 'Groups', 'Recent'])
    for (const heading of report.headings) expect(heading).toMatchObject({ transform: 'none', spacing: 'normal' })
    expect(report.fonts.ui).toMatch(/^Geist,/)
    expect(report.fonts.code).toMatch(/^"Geist Mono",/)
    expect(report.fonts.terminal).toMatch(/^"Geist Mono",/)
    expect(report.fonts.faces).toHaveLength(4)
    for (const face of report.fonts.faces) expect(face).toMatchObject({ status: 'loaded', weight: '100 900' })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-profile-footer-')) throw new Error('Refusing cleanup outside the owned profile footer fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 25000)
