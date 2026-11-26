/**
 * On Windows no program Mousse starts in the background opens a console window, and neither does a console program
 * that one starts with ordinary defaults (as Git starts a hook). A console-less Electron-as-Node parent, like the
 * daemon, starts a console probe through each way Mousse starts programs; the probe and its own child report whether
 * they have a visible console window. There is no visible control case on purpose: it would open a real window on
 * the desktop of whoever runs the suite.
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import electron from 'electron'
import { describe, expect, it } from 'vitest'
import { crashChild, projectRoot } from './support/build'

const hidden = { visible: false }

describe.skipIf(process.platform !== 'win32')('console windows on Windows', () => {
  it('stay hidden for every way a background process starts a console program, and for that program\'s children', async () => {
    const entry = await crashChild('tests/fixtures/consoleWindowParent.ts', {
      format: 'esm', packages: 'external', banner: {
        js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;'
      }
    })
    const koffi = createRequire(import.meta.url).resolve('koffi')
    const probe = join(projectRoot, 'tests', 'fixtures', 'consoleWindowProbe.cjs')
    const out = await new Promise<string>((resolve, reject) => {
      execFile(electron as unknown as string, [entry, process.execPath, probe, koffi], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000
      }, (error, stdout, stderr) => error ? reject(new Error(stderr || String(error), { cause: error })) : resolve(stdout))
    })
    const results = JSON.parse(out) as Record<string, unknown>
    // The parent stands for the daemon only if it has no console of its own.
    expect(results.parent).toEqual({ window: false })
    const backends = ['child_process', 'spawnGit helper', 'Git launcher', 'Git launcher, detached', 'provider job']
    for (const backend of backends) {
      expect(results[backend], backend).toMatchObject({ self: hidden, grandchild: hidden })
    }
  }, 90_000)
})
