/**
 * Workflows run under a permission mode (#338). A workflow started on a thread is held to that thread's mode; a
 * workflow job to the strictest of its mode, its ceiling and its thread's, so a thread or default loosened after the
 * job was made never widens a run. The tests read the mode each run was held to from the run itself, and check that a
 * step that writes asks under Ask before changes and runs under Auto-accept edits.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { Harness } from '../src/mms/harness/gateway'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle } from '../src/shared/workflows'
import { workflowApprovalEffects } from '../src/shared/workflows/permissionMode'
import type { PermissionMode } from '../src/shared/permissionMode'
import type { ScheduledJob } from '../src/shared/types'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-mode-') || path.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})

/** A workflow whose one step writes an artifact: a `write` effect. */
function writing(slug: string): WorkflowBundle {
  return {
    assets: [],
    manifest: {
      schemaVersion: 1, id: randomUUID(), name: 'Writes a file', slug, entryNodeId: 'start',
      inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: { capabilities: ['artifact.write'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'artifact', type: 'write-artifact', version: 1, config: { name: 'out.json', content: { literal: { done: true } } } },
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'input', pointer: '' } } }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'artifact' },
        { from: 'artifact', port: 'success', to: 'end' }
      ]
    }
  }
}

async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  // No model is ever asked: a workflow command never reaches one.
  vi.spyOn(Harness.prototype, 'startTurn').mockImplementation(() => { throw new Error('Workflow commands must not ask a model') })
  vi.spyOn(Harness.prototype, 'oneShot').mockRejectedValue(new Error('No model request in these tests'))
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-mode-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const alice = main.getInstallationHost()!.manager.create({ displayName: 'Alice', slug: 'alice' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
  const endpoint = await server.start()
  const rpc = new LocalMmsClient({
    homeDir, endpoint, ownerToken: 'fixture-owner', clientType: 'cli',
    requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY]
  })
  await rpc.connect()
  await rpc.request('profiles.bind', { profile: alice.id })
  const workflows = createWorkflowDefinitionsClient(rpc)
  const services = await main.getProfileServices(alice.id)
  const publish = async (slug: string) => {
    const draft = await workflows.create({ profileId: alice.id, bundle: writing(slug) })
    return workflows.publish({ profileId: alice.id, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
  }
  const setDefault = (mode: PermissionMode) => services.settings.set({ permissions: { ...services.settings.get().permissions, defaultMode: mode } })
  const thread = async (name: string, mode: PermissionMode) => {
    const { thread: created } = await rpc.request<{ thread: { id: string } }>('threads.create', { name })
    services.orchestrator.setThreadPermissionMode(created.id, mode)
    return created.id
  }
  /** Made as the page makes it: the ceiling is the mode the person holds now (the thread's, else the default). */
  const createJob = async (input: Record<string, unknown>) =>
    (await rpc.request<{ job: ScheduledJob }>('scheduled.create', { input: { name: 'Workflow job', schedule: { kind: 'interval', minutes: 60 }, ...input } })).job
  /** The workflow run a job's occurrence started, once the occurrence was recorded. */
  const runOf = async (jobId: string) => {
    services.scheduled.triggerJob(jobId)
    services.scheduled.start()
    await vi.waitFor(() => { expect(services.scheduled.getJob(jobId)?.runHistory?.length).toBeGreaterThan(0) }, { timeout: 10_000 })
    services.scheduled.stop()
    const runs = await services.platform.workflowRuns.runtime.list({ profileId: alice.id })
    const scheduled = await Promise.all(runs.map((run) => services.platform.workflowRuns.runtime.get(run.runId, { profileId: alice.id })))
    return scheduled.find((run) => run.manifest.source === 'schedule' && run.manifest.threadId === services.scheduled.getJob(jobId)!.runHistory!.at(-1)!.threadId)
      ?? scheduled.filter((run) => run.manifest.source === 'schedule').at(-1)!
  }
  return {
    alice, rpc, services, publish, setDefault, thread, createJob, runOf,
    close: async () => {
      for (const run of await services.platform.workflowRuns.runtime.list({ profileId: alice.id })) {
        if (!['succeeded', 'failed', 'cancelled'].includes(run.state)) await services.platform.workflowRuns.runtime.cancel(run.runId, { profileId: alice.id }, 'Fixture cleanup').catch(() => undefined)
      }
      await rpc.close()
      await server.stop()
      await main.stop()
    }
  }
}

describe('what a workflow step asks for under each mode', () => {
  it('asks before writes under Ask before changes, lets edits run under Auto-accept edits, and always asks for what it cannot classify', () => {
    expect(workflowApprovalEffects('ask')).toEqual(['write', 'external', 'unknown'])
    expect(workflowApprovalEffects('accept_edits')).toEqual(['external', 'unknown'])
    expect(workflowApprovalEffects('auto')).toEqual(['unknown'])
    expect(workflowApprovalEffects('full')).toEqual(['unknown'])
    // A run admitted before workflows had a mode asks as Ask before changes does.
    expect(workflowApprovalEffects(undefined)).toEqual(workflowApprovalEffects('ask'))
  })
})

describe('workflows run under a permission mode (#338)', () => {
  it('holds a bound workflow job to its ceiling after its thread is loosened', async () => {
    const f = await fixture()
    try {
      await f.setDefault('full')
      const published = await f.publish('bound-loosened')
      const threadId = await f.thread('Strict thread', 'ask')
      const job = await f.createJob({ prompt: `/${published.slug}`, threadId })
      expect(job.permissionCeiling).toBe('ask')
      // Loosened after the job was made.
      f.services.orchestrator.setThreadPermissionMode(threadId, 'full')

      const run = await f.runOf(job.id)
      expect(run.manifest.permissionMode).toBe('ask')
      // Held to Ask before changes, the step that writes waits for a person.
      await vi.waitFor(async () => {
        expect((await f.services.platform.workflowRuns.runtime.get(run.manifest.runId, { profileId: f.alice.id })).manifest.state).toBe('waiting-approval')
      }, { timeout: 10_000 })
    } finally { await f.close() }
  }, 40_000)

  it('holds a per-run workflow job to its ceiling after the default is loosened', async () => {
    const f = await fixture()
    try {
      await f.setDefault('ask')
      const published = await f.publish('per-run-loosened')
      const job = await f.createJob({ prompt: `/${published.slug}`, createThread: true })
      expect(job.permissionCeiling).toBe('ask')
      await f.setDefault('full')

      const run = await f.runOf(job.id)
      expect(run.manifest.permissionMode).toBe('ask')
    } finally { await f.close() }
  }, 40_000)

  it('runs a workflow job at its own mode when that is the strictest, and lets the write run under Auto-accept edits', async () => {
    const f = await fixture()
    try {
      await f.setDefault('full')
      const published = await f.publish('job-mode')
      const threadId = await f.thread('Wide thread', 'full')
      const job = await f.createJob({ prompt: `/${published.slug}`, threadId, permissionMode: 'accept_edits' })

      const run = await f.runOf(job.id)
      expect(run.manifest.permissionMode).toBe('accept_edits')
      await vi.waitFor(async () => {
        expect((await f.services.platform.workflowRuns.runtime.get(run.manifest.runId, { profileId: f.alice.id })).manifest.state).toBe('succeeded')
      }, { timeout: 10_000 })
    } finally { await f.close() }
  }, 40_000)

  it('holds a workflow started on a thread to that thread\'s mode', async () => {
    const f = await fixture()
    try {
      await f.setDefault('full')
      const published = await f.publish('thread-mode')
      const threadId = await f.thread('Edits thread', 'accept_edits')
      // Typed on the thread, as a window or the CLI sends it.
      await f.rpc.request('orchestrator.send', { threadId, content: `/${published.slug}`, requestId: randomUUID() })
      await vi.waitFor(async () => { expect(await f.services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1) }, { timeout: 10_000 })
      const runs = await f.services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      const run = await f.services.platform.workflowRuns.runtime.get(runs[0]!.runId, { profileId: f.alice.id })
      expect(run.manifest.permissionMode).toBe('accept_edits')
    } finally { await f.close() }
  }, 40_000)
})
