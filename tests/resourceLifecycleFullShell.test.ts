import { spawn, execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'
import { expect, it, vi } from 'vitest'
import { seedFullShellFixture } from './fixtures/git-foundation-full-shell-seed'
import { fullShellElectronArgs } from './fixtures/fullShellElectron'
import { terminateChild } from './fixtures/agent-platform/process-lifecycle/terminateChild'
import { MousseMainService } from '../src/mms/MousseMainService'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { git } from './fixtures/gitFoundation'

it('renders unavailable expired Undo, trash restore and permanent deletion for a task holding legacy named-agent data in the full built app', async () => {
  const fixture = await seedFullShellFixture()
  let child: ReturnType<typeof spawn> | undefined
  const source = await MousseMainService.create({ homeDir: fixture.home, headless: true, ownerKind: 'test' })
  try {
    await source.start()
    // Named agents can no longer be created; an older build left this episode in the task's data.
    const directory = source.threads.getThreadDir(fixture.threadId)
    seedLegacyNamedEpisode(directory, { name: 'UI Reviewer', episodeId: 'ui-named-result', worktreePath: fixture.workspace, resultSha: fixture.baseSha })
    expect(new AgentEpisodeStore(directory).read().episodes).toHaveLength(1)
    let now = Date.now()
    const retention = new UndoRetentionService(directory, () => now)
    await retention.configure(fixture.workspace, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 100000 }, true)
    now += 10000; await retention.sweep(fixture.workspace)
    await source.stop()
    const evidenceDir = process.env.MOUSSE_UI_EVIDENCE_DIR ?? join(fixture.root, 'ui-evidence'); mkdirSync(evidenceDir, { recursive: true })
    const evidence = join(evidenceDir, 'lifecycle-full-shell.json'), config = join(fixture.root, 'lifecycle-shell-config.json')
    writeFileSync(config, JSON.stringify({ ...fixture, evidence, evidenceDir, mainEntry: resolve('out/main/index.js') }))
    const env = { ...process.env, MOUSSE_FULL_SHELL_CONFIG: config, MOUSSE_HOME: fixture.home, MOUSSE_ELECTRON_USER_DATA: join(fixture.root, 'electron-user-data'), MOUSSE_REPO_ROOT: fixture.repo }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const log = join(fixture.root, 'electron.log'), fd = openSync(log, 'a')
      try { child = spawn(electron as unknown as string, fullShellElectronArgs(resolve('tests/fixtures/resource-lifecycle-full-shell-driver.mjs')), { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] }) }
      finally { closeSync(fd) }
      child.once('error', reject); child.once('exit', (code) => done({ code, output: readFileSync(log, 'utf8').slice(-16000) }))
    })
    expect(result.code, result.output).toBe(0)
    expect(existsSync(evidence), 'The full-shell driver exited without producing evidence.\n' + result.output).toBe(true)
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({ expiredUndoUnavailable: true, restoreIdle: true, purged: true, primaryPreserved: true })
    expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.baseSha)
    expect(git(fixture.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/')).toBe('')
  } finally {
    await source.stop(); vi.restoreAllMocks(); await terminateChild(child)
    await promisify(execFile)(process.execPath, [resolve('out/cli/index.js'), 'service', 'stop', '--home', fixture.home], { windowsHide: true, timeout: 15000 }).catch((error: { stderr?: string }) => { if (!error.stderr?.includes('MMS is not running')) throw error })
    fixture.dispose()
  }
}, 120_000)
