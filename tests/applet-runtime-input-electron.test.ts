import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** `reported`: the deltas the applet reported for the conversation; `hostTop`: how far the page around it scrolled. */
interface Turn { reported: number[]; hostTop: number; scrolled: { box: number; contain: number; root: number }; zoom: number }
interface Evidence {
  layout: {
    row: { left: number; width: number; padding: string; justify: string; background: string; radius: string; border: string }
    icon: { left: number }
    bare: { left: number; width: number; display: string; justify: string; padding: string; background: string }
    bareLabel: { left: number; width: number }
    btn: { display: string; justify: string; background: string }
  }
  wheel: Record<'body' | 'innerWithRoom' | 'innerAtEnd' | 'innerAtTopGoingUp' | 'containAtEnd' | 'control', Turn>
  watchdog: { timersPaused: boolean; pausedErrors: string[]; pausedAlive: boolean; loopStoppedAfterMs: number | null; loopError: string | null }
}

/** Real applet pages in real webviews (tests/fixtures/applet-runtime-input), one run shared by the cases below. */
let evidence: Evidence
let directory: string
beforeAll(async () => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-applet-input-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/applet-runtime-input/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_APPLET_INPUT_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
  }
}, 60000)
afterAll(() => {
  const resolvedTemp = realpathSync(tmpdir())
  if (directory && (resolve(directory).startsWith(resolvedTemp + '/') || resolve(directory).startsWith(resolvedTemp + '\\')))
    rmSync(directory, { recursive: true, force: true })
})

describe('buttons in an applet', () => {
  it("lay out an author's flex row as written: its content starts at the left, not in the middle", () => {
    const { row, icon } = evidence.layout
    expect(row.justify).toBe('normal')
    expect(icon.left - row.left).toBeLessThan(12)
    // Still themed: the host's surface and corners, no native border.
    expect(row.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(row.radius).toBe('6px')
    expect(row.border).toBe('0px')
  })

  it('give a bare button the themed control look, its label centred', () => {
    const { bare, bareLabel } = evidence.layout
    expect(bare.display).toBe('inline-flex')
    expect(bare.padding).toBe('14px')
    const labelCentre = bareLabel.left + bareLabel.width / 2, buttonCentre = bare.left + bare.width / 2
    expect(Math.abs(labelCentre - buttonCentre)).toBeLessThan(2)
  })

  it('keep the host .btn control as it was', () => {
    expect(evidence.layout.btn).toMatchObject({ display: 'inline-flex', justify: 'center' })
  })
})

describe('a wheel turn over an applet', () => {
  it('that nothing in the applet can scroll goes on to the page around it, which scrolls, and is reported', () => {
    const { body } = evidence.wheel
    expect(body.hostTop).toBeGreaterThan(0)
    expect(body.scrolled.root).toBe(0)
    expect(body.reported.length).toBe(1)
    expect(body.reported[0]).toBeGreaterThan(0)
  })

  it('scrolls an inner scroller that still has room, and is neither handed on nor reported', () => {
    const { innerWithRoom } = evidence.wheel
    expect(innerWithRoom.scrolled.box).toBeGreaterThan(0)
    expect(innerWithRoom.hostTop).toBe(0)
    expect(innerWithRoom.reported).toEqual([])
  })

  it('goes on to the conversation once the inner scroller is at its end, either way', () => {
    expect(evidence.wheel.innerAtEnd.hostTop).toBeGreaterThan(0)
    expect(evidence.wheel.innerAtEnd.reported.length).toBe(1)
    expect(evidence.wheel.innerAtEnd.reported[0]).toBeGreaterThan(0)
    expect(evidence.wheel.innerAtTopGoingUp.reported.length).toBe(1)
    expect(evidence.wheel.innerAtTopGoingUp.reported[0]).toBeLessThan(0)
  })

  it('stays in a scroller whose author stopped scroll chaining, and leaves ctrl+wheel (zoom) alone', () => {
    expect(evidence.wheel.containAtEnd.hostTop).toBe(0)
    expect(evidence.wheel.containAtEnd.reported).toEqual([])
    expect(evidence.wheel.control.reported).toEqual([])
    expect(evidence.wheel.control.zoom).toBe(1)
  })
})

describe('the applet watchdog', () => {
  it('keeps a shown applet whose timers do not run (a covered or long-hidden window throttles them)', () => {
    const { timersPaused, pausedErrors, pausedAlive } = evidence.watchdog
    // The control: the page's own timers really stopped for the whole wait.
    const seen = JSON.stringify(evidence.watchdog)
    expect(timersPaused, seen).toBe(true)
    expect(pausedErrors, seen).toEqual([])
    expect(pausedAlive, seen).toBe(true)
  })

  it('still stops a shown applet stuck in a loop, within about five seconds', () => {
    const { loopStoppedAfterMs, loopError } = evidence.watchdog
    expect(loopError).toMatch(/stopped responding/)
    expect(loopStoppedAfterMs).not.toBeNull()
    expect(loopStoppedAfterMs!).toBeLessThan(7000)
  })
})
