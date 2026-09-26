import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { PublishService } from '../src/mms/actions/PublishService'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())

it.each(['checkpoint', 'revert', 'integration', 'publish'].flatMap((kind) => ['before', 'after'].map((phase) => ({ kind, phase }))))(
  'recovers $kind after process exit $phase its receipt write without repeating Git', async ({ kind, phase }) => {
    const config: Record<string, unknown> = { kind, phase, thread: f.thread, repo: f.repo }
    let recover: () => Promise<void>
    if (kind === 'checkpoint') {
      config.options = actionOptions(f.repo)
      recover = () => new ThreadActionService(f.thread).recoverPending(f.repo)
    } else if (kind === 'revert') {
      const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'to revert\n'))
      config.actionId = action.id
      recover = () => new CodeRevertService(f.thread).recoverPending(f.repo)
    } else {
      const source = f.child('child')
      const result = f.commit(source, 'child result\n')
      if (kind === 'integration') {
        config.request = { operationId: 'crash-integration', agentId: 'child', workerWorktree: source, workerBranch: 'child',
          spawnBaseSha: f.baseSha, expectedWorkerHead: result, expectedDestinationHead: f.baseSha, threadWorkspace: f.repo }
        recover = () => new ChildAgentIntegrationService(f.thread).recoverPending(f.repo)
      } else {
        config.source = source; config.target = git(f.repo, 'branch', '--show-current')
        config.options = { operationId: 'crash-publish', expectedSourceSha: result, expectedTargetSha: f.baseSha }
        recover = () => new PublishService(f.thread).recoverPending(source, f.repo)
      }
    }
    const configPath = join(f.root, 'crash.json')
    writeFileSync(configPath, JSON.stringify(config))
    const runner = join(f.root, 'operation-crash.mjs')
    await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000 })
    expect(child.status, child.stderr).toBe(86)
    const appliedHead = git(f.repo, 'rev-parse', 'HEAD')
    expect(appliedHead).not.toBe(f.baseSha)
    await recover!()
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
    expect(new ChangeReceiptService(f.thread).list().filter((receipt) => receipt.kind === kind)).toHaveLength(1)
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => ['prepared', 'git_applied', 'running', 'context_pending', 'recovery_required'].includes(entry.state))).toEqual([])
    if (kind === 'checkpoint') expect(new ThreadActionService(f.thread).latest('main')?.endSha).toBe(appliedHead)
    if (kind === 'integration') expect(new ThreadActionService(f.thread).latest('main')?.endSha).toBe(appliedHead)
    expect(f.read(f.repo)).toBe(kind === 'checkpoint' ? 'checkpoint result\n' : kind === 'revert' ? 'base\n' : 'child result\n')
    const journalSize = new ThreadJournal(f.thread).list().length
    await recover!()
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
    expect(new ThreadJournal(f.thread).list()).toHaveLength(journalSize)
  }, 30_000
)
