import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('keeps registry chords off the native menu in the window and the browser surface, and forwards eligible ones', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-menu-shortcuts-')))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({
      entryPoints: [resolve('tests/fixtures/menu-shortcuts/main.ts')],
      outfile: join(directory, 'main.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['electron'],
      logLevel: 'silent'
    })
    const env = { ...process.env, MOUSSE_MENU_SHORTCUTS_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-6000) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-6000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.ok, JSON.stringify(report)).toBe(true)

    // A registry chord typed in the window reaches the page, and the menu item does not fire as well.
    expect(report.hostChord.keys).toHaveLength(1)
    expect(report.hostChord.keys[0].key.toLowerCase()).toBe('n')
    expect(report.hostChord.menuClicks).toEqual([])

    // Role chords are untouched: Select all still selects.
    expect(report.selection).toEqual([0, 3])

    // A chord the renderer can run is taken from the browser page and sent to the renderer.
    expect(report.guestForwarded.sent).toEqual([{ id: 'palette.open', source: 'guest' }])
    expect(report.guestForwarded.keys).toEqual([])
    expect(report.guestForwarded.menuClicks).toEqual([])

    // New thread rebound to Find: the page keeps the key; nothing is sent and the menu stays quiet.
    expect(report.guestReserved.sent).toEqual([])
    expect(report.guestReserved.keys).toHaveLength(1)
    expect(report.guestReserved.menuClicks).toEqual([])

    // `sendInputEvent` does not always reach native menu accelerators: `probe.clicks` is 1 where it
    // does, and the `menuClicks` checks above then prove the menu stayed quiet. Where it is 0 they
    // only hold trivially; the gate itself is asserted in menuShortcutGate.test.ts.
    expect([0, 1]).toContain(report.probe.clicks)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-menu-shortcuts-')) throw new Error('Refusing cleanup outside owned menu fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 40000)
