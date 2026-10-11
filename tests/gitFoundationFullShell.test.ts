import { spawn, execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'
import { expect, it } from 'vitest'
import { seedFullShellFixture } from './fixtures/git-foundation-full-shell-seed'
import { fullShellElectronArgs } from './fixtures/fullShellElectron'
import { terminateChild } from './fixtures/agent-platform/process-lifecycle/terminateChild'
import { git } from './fixtures/gitFoundation'

it('full built Electron app refreshes visible conversation and real task bytes after Undo and Redo', async () => {
  const fixture = await seedFullShellFixture()
  let child: ReturnType<typeof spawn> | undefined
  let testError: unknown
  try {
    const evidence = join(fixture.root, 'full-shell-evidence.json')
    const config = join(fixture.root, 'full-shell-config.json')
    writeFileSync(config, JSON.stringify({ ...fixture, evidence, mainEntry: resolve('out/main/index.js') }))
    const env = { ...process.env, MOUSSE_FULL_SHELL_CONFIG: config, MOUSSE_HOME: fixture.home,
      MOUSSE_ELECTRON_USER_DATA: join(fixture.root, 'electron-user-data'), MOUSSE_REPO_ROOT: fixture.repo }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      // The GUI intentionally leaves its owned daemon alive on quit. A pipe
      // inherited by that descendant must not gate the GUI's exit observation.
      const log = join(fixture.root, 'electron.log')
      const logFd = openSync(log, 'a')
      try {
        child = spawn(electron as unknown as string, fullShellElectronArgs(resolve('tests/fixtures/git-foundation-full-shell-driver.mjs')), {
          cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', logFd, logFd]
        })
      } finally { closeSync(logFd) }
      child.once('error', reject)
      child.once('exit', (code) => done({ code, stderr: readFileSync(log, 'utf8').slice(-12_000) }))
    })
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(evidence), 'The full-shell driver exited without producing evidence.\n' + result.stderr).toBe(true)
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({
      cycles: 2, transcriptUndo: true, transcriptRedo: true, taskBytesUndo: true, taskBytesRedo: true, primaryPreserved: true
    })
    expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.baseSha)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    await terminateChild(child).catch((error) => cleanupErrors.push(error))
    await promisify(execFile)(process.execPath, [resolve('out/cli/index.js'), 'service', 'stop', '--home', fixture.home], { windowsHide: true, timeout: 15_000 })
      .catch((error: { stderr?: string }) => { if (!error.stderr?.includes('MMS is not running')) cleanupErrors.push(error) })
    // Keep owned evidence if a live process could still hold this home.
    if (!cleanupErrors.length) fixture.dispose()
    else throw new AggregateError(testError ? [testError, ...cleanupErrors] : cleanupErrors, `Full app cleanup failed; retained ${fixture.root}`)
  }
}, 75_000)
