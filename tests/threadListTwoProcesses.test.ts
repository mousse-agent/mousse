import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'

const ITERATIONS = 300

/** The other process: its own ProjectManager and ThreadDataStore over the same home, as another daemon session has. */
const CHILD = `
import { ProjectManager } from './src/mms/data/ProjectManager'
import { ThreadDataStore } from './src/mms/data/ThreadDataStore'
const [projectId, iterations, tag, scenario, ids] = process.argv.slice(2)
const projects = new ProjectManager()
const store = new ThreadDataStore(projects)
projects.setThreadStore(store)
if (scenario === 'modes') {
  // Sets each named thread to Ask, as another window's permission change does.
  for (const id of ids.split(',')) store.updateThreadMeta(id, { permissionMode: 'ask' })
  process.stdout.write('{}')
  process.exit(0)
}
const made: string[] = []
const renamed: Record<string, string> = {}
// The lifecycle store's own per-task gates refuse a second process for a moment ("gate is busy"); retried here, as
// this test is about the thread list.
const retry = <T>(run: () => T): T => {
  for (let attempt = 0; ; attempt += 1) {
    try { return run() } catch (error) {
      if (attempt > 400 || ((error as { code?: string })?.code !== 'busy' && !/busy/i.test(String((error as Error)?.message)))) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
for (let i = 0; i < Number(iterations); i += 1) {
  if (i % 2 === 0 || made.length === 0) made.push(retry(() => store.createThread(tag + '-' + i, projectId)).id)
  else {
    const id = made[Math.floor(Math.random() * made.length)]
    const name = tag + '-renamed-' + i
    retry(() => store.updateThreadMeta(id, { name }))
    renamed[id] = name
  }
  if (i % 7 === 0) retry(() => store.listAllThreads())
}
process.stdout.write(JSON.stringify({ made, renamed }))
`

describe('two processes changing one project at once', () => {
  let root: string
  let childScript: string
  const previousHome = process.env.MOUSSE_HOME

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-two-processes-'))
    process.env.MOUSSE_HOME = join(root, 'home')
    childScript = join(root, 'child.mjs')
    const bundle = await build({
      stdin: { contents: CHILD, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', write: false, target: 'node22',
      banner: { js: "import { createRequire as __mousseRequire } from 'node:module'; const require = __mousseRequire(import.meta.url);" }
    })
    writeFileSync(childScript, bundle.outputFiles[0].contents)
  }, 120_000)

  afterAll(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* left for the OS */ }
  })

  const runChild = (args: string[]): { exited: Promise<number | null>; out: () => string; err: () => string } => {
    const child = spawn(process.execPath, [childScript, ...args], {
      env: { ...process.env, MOUSSE_HOME: join(root, 'home'), MOUSSE_THREAD_DB_WORKER: 'inline', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    return { exited: new Promise((resolve) => child.on('exit', resolve)), out: () => out, err: () => err }
  }

  // Review repro: a rename built from this process's cached thread wrote back the mode it had before another process
  // changed it, and moved the settings revision back.
  it("keeps another process's mode change when this process renames the same threads from its cached list", async () => {
    const projects = new ProjectManager()
    const a = new ThreadDataStore(projects)
    projects.setThreadStore(a)
    const project = projects.openProject(join(root, 'modes'))
    const made = Array.from({ length: 12 }, (_unused, i) => a.createThread('Mode ' + i, project.id))
    // This process holds the list in memory, as a running daemon does.
    a.listAllThreads()
    const other = runChild([project.id, '0', 'B', 'modes', made.map((thread) => thread.id).join(',')])
    expect(await other.exited, other.err()).toBe(0)
    for (const thread of made) a.updateThreadMeta(thread.id, { name: 'Renamed ' + thread.name })
    const fromDisk = new ThreadDataStore(new ProjectManager())
    for (const thread of made) {
      const now = fromDisk.getThread(thread.id)!
      expect(now.name).toBe('Renamed ' + thread.name)
      expect(now.permissionMode).toBe('ask')
      expect(now.settingsRevision).toBe((thread.settingsRevision ?? 0) + 1)
    }
  }, 120_000)

  it(`keeps every thread, rename and order across ${ITERATIONS} concurrent creates and renames on each side`, async () => {
    const projects = new ProjectManager()
    const a = new ThreadDataStore(projects)
    projects.setThreadStore(a)
    const project = projects.openProject(join(root, 'proj'))
    a.listAllThreads()

    const child = spawn(process.execPath, [childScript, project.id, String(ITERATIONS), 'B'], {
      env: { ...process.env, MOUSSE_HOME: join(root, 'home'), MOUSSE_THREAD_DB_WORKER: 'inline', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))

    const made: string[] = []
    const renamed: Record<string, string> = {}
    const retry = <T>(run: () => T): T => {
      for (let attempt = 0; ; attempt += 1) {
        try { return run() } catch (error) {
          if (attempt > 400 || ((error as { code?: string })?.code !== 'busy' && !/busy/i.test(String((error as Error)?.message)))) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        }
      }
    }
    for (let i = 0; i < ITERATIONS; i += 1) {
      if (i % 2 === 0 || made.length === 0) made.push(retry(() => a.createThread('A-' + i, project.id)).id)
      else {
        const id = made[Math.floor(Math.random() * made.length)]
        const name = 'A-renamed-' + i
        retry(() => a.updateThreadMeta(id, { name }))
        renamed[id] = name
      }
      if (i % 5 === 0) retry(() => a.listAllThreads())
      // Let the other process's writes interleave with these.
      if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(await exited, err).toBe(0)
    const other = JSON.parse(out) as { made: string[]; renamed: Record<string, string> }

    const listed = a.listThreads(project.id)
    const fromDisk = new ThreadDataStore(new ProjectManager()).listThreads(project.id)
    const view = (threads: Array<{ id: string; name: string; order: number }>) => threads.map(({ id, name, order }) => ({ id, name, order }))
    // What this store shows is what is on disk: no thread hidden, no rename lost.
    expect(view(listed)).toEqual(view(fromDisk))
    const byId = new Map(listed.map((thread) => [thread.id, thread]))
    for (const id of [...made, ...other.made]) expect(byId.has(id), id).toBe(true)
    for (const [id, name] of Object.entries({ ...renamed, ...other.renamed })) expect(byId.get(id)?.name).toBe(name)
    // No two threads share an order.
    expect(new Set(listed.map((thread) => thread.order)).size).toBe(listed.length)
    // A create the lifecycle store refused part way (and the test retried) can leave a thread of its own on disk; every
    // row is one of the creates either side made, and none is missing.
    expect(listed.length).toBeGreaterThanOrEqual(made.length + other.made.length)
    expect(listed.every((thread) => /^(A|B)-/.test(thread.name))).toBe(true)
  }, 300_000)
})
