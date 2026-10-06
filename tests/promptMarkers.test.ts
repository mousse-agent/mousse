import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('tracks every visible mounted prompt, recycles safely, and expands only around pointer or keyboard focus', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-prompt-markers-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/prompt-markers/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/prompt-markers/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_PROMPT_MARKERS_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    type Tick = { id: string; visible: boolean; width: number; height: number; opacity: number; transform: string }
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as {
      initial: Tick[]; hovered: Tick[]; settled: Tick[]; scrolled: Tick[]; virtualized: Tick[]; recycled: Tick[]; focused: Tick[];
      focusedAfterLeave: boolean; click: { count: number; scrollTop: number; transition: string };
      cachedClick: { count: number; scrollTop: number };
      bounded: { rail: number; viewport: number; scrollHeight: number }; rendererErrors: string[];
    }
    expect(result.rendererErrors).toEqual([])
    expect(result.initial.filter(tick => tick.visible).map(tick => tick.id)).toEqual(['one', 'two'])
    expect(result.initial.every(tick => tick.width === 12 && tick.height === 9 && tick.transform === 'none')).toBe(true)
    expect(result.initial.filter(tick => tick.visible).every(tick => tick.opacity === 0.9)).toBe(true)
    expect(result.initial.filter(tick => !tick.visible).every(tick => tick.opacity === 0.22)).toBe(true)
    expect(result.hovered.map(tick => tick.width)).toEqual([20, 28, 36, 28, 20, 12, 12, 12])
    expect(result.settled.every(tick => tick.width === 12 && tick.transform === 'none')).toBe(true)
    expect(result.scrolled.filter(tick => tick.visible).map(tick => tick.id)).toEqual(['two', 'three', 'four'])
    expect(result.virtualized.filter(tick => tick.visible).map(tick => tick.id)).toEqual(['two', 'four'])
    expect(result.virtualized).toHaveLength(8)
    expect(result.recycled.filter(tick => tick.visible).map(tick => tick.id)).toEqual(['recycled', 'two'])
    expect(result.focused.find(tick => tick.id === 'three')?.width).toBe(36)
    expect(result.focusedAfterLeave).toBe(true)
    expect(result.click).toEqual({ count: 1, scrollTop: 224, transition: '0s' })
    expect(result.cachedClick).toEqual({ count: 2, scrollTop: 224 })
    expect(result.bounded.rail).toBeLessThan(result.bounded.viewport)
    expect(result.bounded.scrollHeight).toBeGreaterThan(result.bounded.rail)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected prompt fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 30000)
