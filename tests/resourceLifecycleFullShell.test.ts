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
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { git } from './fixtures/gitFoundation'

it('renders real named integration, unavailable expired Undo, trash restore and permanent deletion in the full built app', async () => {
  const fixture = await seedFullShellFixture()
  let child: ReturnType<typeof spawn> | undefined
  const source = await MousseMainService.create({ homeDir: fixture.home, headless: true, ownerKind: 'test' })
  try {
    await source.start()
    const responses = [providerResponse([{ type: 'toolCall', id: 'write-result', name: 'write', arguments: { path: 'named-ui.txt', content: 'reviewed named result\n' } }], 'toolUse'), providerResponse([{ type: 'text', text: 'Named GUI result is ready.' }], 'stop')]
    const auth = vi.spyOn(source.providerAuth, 'has').mockReturnValue(true)
    const getAuth = vi.spyOn(source.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const stream = vi.spyOn(source.providerAuth.models, 'streamSimple').mockImplementation(() => streamOf(responses.shift()!) as never)
    const admitted = await source.orchestrator.createNamedAgent(fixture.threadId, { name: 'UI Reviewer', task: 'Write named-ui.txt for integration review.', operationId: 'ui-named-result', policy: { workspace: 'isolated', access: 'write' } })
    const directory = source.threads.getThreadDir(fixture.threadId)
    await vi.waitFor(() => {
      const state = new AgentEpisodeStore(directory).read()
      expect(state.episodes[0]?.state).toBe('completed'); expect(existsSync(state.episodes[0].binding.worktreePath)).toBe(false)
    }, { timeout: 15_000 })
    let now = Date.now()
    const retention = new UndoRetentionService(directory, () => now)
    await retention.configure(fixture.workspace, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 100000 }, true)
    now += 10000; await retention.sweep(fixture.workspace)
    auth.mockRestore(); getAuth.mockRestore(); stream.mockRestore()
    await source.stop()
    const evidenceDir = process.env.MOUSSE_UI_EVIDENCE_DIR ?? join(fixture.root, 'ui-evidence'); mkdirSync(evidenceDir, { recursive: true })
    const evidence = join(evidenceDir, 'lifecycle-full-shell.json'), config = join(fixture.root, 'lifecycle-shell-config.json')
    writeFileSync(config, JSON.stringify({ ...fixture, agentId: admitted.agent!.id, evidence, evidenceDir, mainEntry: resolve('out/main/index.js') }))
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
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({ expiredUndoUnavailable: true, namedRecallVisible: true, integrationDiffVisible: true, integrationApplied: true, restoreIdle: true, purged: true, primaryPreserved: true })
    expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.baseSha)
    expect(git(fixture.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/')).toBe('')
  } finally {
    await source.stop(); vi.restoreAllMocks(); await terminateChild(child)
    await promisify(execFile)(process.execPath, [resolve('out/cli/index.js'), 'service', 'stop', '--home', fixture.home], { windowsHide: true, timeout: 15000 }).catch((error: { stderr?: string }) => { if (!error.stderr?.includes('MMS is not running')) throw error })
    fixture.dispose()
  }
}, 120_000)
