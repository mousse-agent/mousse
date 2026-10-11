import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

/** Real mounted controls/browser crypto; a controlled UI API port, not MMS/ACL qualification. */
it('fences mounted private completions, preserves original retries, and confirms fresh remote displays', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-gui-mounted-'))
  let child: ChildProcess | undefined, exited: Promise<number | null> | undefined
  try {
    await build({ entryPoints: [resolve('tests/fixtures/net-gui/mounted-lifecycle/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/net-gui/mounted-lifecycle/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    // I remove inherited run-as-node only for the owned Electron child.
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_GUI_MOUNTED_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = '', stdout = ''
    child.stderr!.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-65536) })
    child.stdout!.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-65536) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    const code = await exited
    expect(code, stderr + stdout).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as { observations: Array<{ mode: string; before: unknown[]; after: { calls: Array<{ method: string; params: unknown }>; callbacks: unknown[]; text?: string }; online: string; offline: string; awaiting: string; incremental: string; partial: string; fresh: string; calls: Array<{ method: string }> }>; rendererErrors: string[] }
    expect(report.rendererErrors).toEqual([])
    for (const mode of ['aside', 'permission', 'work']) {
      const observation = report.observations.find(row => row.mode === mode)!
      expect(observation.after.calls).toEqual(observation.before)
      expect(observation.after.callbacks).toEqual([])
    }
    for (const mode of ['aside-retry', 'permission-retry']) {
      const observation = report.observations.find(row => row.mode === mode)!, method = mode === 'aside-retry' ? 'chats.aside.create' : 'bots.grant'
      const mutations = observation.after.calls.filter(row => row.method === method)
      expect(mutations).toHaveLength(2); expect(mutations[1].params).toEqual(mutations[0].params)
      expect(observation.after.callbacks).toHaveLength(1)
    }
    const remote = report.observations.find(row => row.mode === 'remote')!
    expect(remote.online).toContain('Working')
    expect(remote.offline).toContain('Offline · Cached display')
    expect(remote.offline).toContain('Retained remote body')
    expect(remote.offline).not.toContain('Working')
    for (const text of [remote.awaiting, remote.incremental, remote.partial]) {
      expect(text).toContain('Awaiting current display · Cached display')
      expect(text).toContain('Retained remote body')
      expect(text).not.toContain('Working')
      expect(text).not.toContain('Fresh verified body')
    }
    expect(remote.fresh).toContain('Working')
    expect(remote.fresh).toContain('Fresh verified body')
    expect(remote.fresh).not.toContain('Cached display')
    expect(remote.calls.map(row => row.method)).toEqual(['bridge.hub.threads', 'bridge.hub.attach', 'bridge.hub.detach', 'bridge.hub.attach', 'bridge.hub.detach'])
  } finally {
    // Only my spawned child handle is eligible for cleanup; no process-name/group search.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const stopped = await Promise.race([exited!.then(() => true, () => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), 3000) })])
        if (!stopped) { child.kill('SIGKILL'); await exited!.catch(() => undefined) }
      } finally { if (timer) clearTimeout(timer) }
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
