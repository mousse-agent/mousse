import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'
import { expect, it } from 'vitest'
import { seedChatUndoFullShell } from './fixtures/chat-undo-full-shell-seed'
import { fullShellElectronArgs } from './fixtures/fullShellElectron'
import { terminateChild } from './fixtures/agent-platform/process-lifecycle/terminateChild'

it('actual message-toolbar Undo rewinds ordinary projectless chat and retains exact redo across restart', async () => {
  const fixture = await seedChatUndoFullShell()
  let child: ReturnType<typeof spawn> | undefined
  let failure: unknown
  const stopDaemon = async () => {
    await promisify(execFile)(process.execPath, [resolve('out/cli/index.js'), 'service', 'stop', '--home', fixture.home], { windowsHide: true, timeout: 15_000 })
      .catch((error: { stderr?: string }) => { if (!error.stderr?.includes('MMS is not running')) throw error })
  }
  try {
    for (const phase of ['cycles', 'restart']) {
      const evidence = join(fixture.root, `${phase}-evidence.json`)
      const config = join(fixture.root, `${phase}-config.json`)
      writeFileSync(config, JSON.stringify({ ...fixture, evidence, phase, mainEntry: resolve('out/main/index.js') }))
      const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_CHAT_UNDO_CONFIG: config, MOUSSE_HOME: fixture.home,
        MOUSSE_ELECTRON_USER_DATA: join(fixture.root, 'electron-user-data'), MOUSSE_REPO_ROOT: fixture.root }
      delete env.ELECTRON_RUN_AS_NODE
      const log = join(fixture.root, `${phase}-electron.log`)
      const code = await new Promise<number | null>((done, reject) => {
        const fd = openSync(log, 'a')
        try { child = spawn(electron as unknown as string, fullShellElectronArgs(resolve('tests/fixtures/chat-undo-full-shell-driver.mjs')), { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] }) }
        finally { closeSync(fd) }
        child.once('error', reject); child.once('exit', done)
      })
      expect(code, readFileSync(log, 'utf8').slice(-12_000)).toBe(0)
      expect(existsSync(evidence), 'The full-shell driver exited without producing evidence.\n' + readFileSync(log, 'utf8').slice(-12_000)).toBe(true)
      expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({ phase, actualMessageToolbar: true, nativeContextExact: true, unchangedFiles: true })
      await stopDaemon()
    }
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('No chat turn may change this file.\n')
  } catch (error) { failure = error; throw error }
  finally {
    const errors: unknown[] = []
    await terminateChild(child).catch(error => errors.push(error))
    await stopDaemon().catch(error => errors.push(error))
    if (!errors.length) fixture.dispose()
    else throw new AggregateError(failure ? [failure, ...errors] : errors, `Chat Undo fixture cleanup failed; retained ${fixture.root}`)
  }
}, 150_000)
