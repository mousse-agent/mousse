import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/cli/parseArgs'
import { executeWorkflowCommand, prepareWorkflowCommand, workflowWaitExitCode } from '../src/cli/commands/workflow'
import { publishOwnRuntimeRecord, removeOwnRuntimeRecord } from '../src/cli/mmsRuntime'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunView } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle, WorkflowNode } from '../src/shared/workflows'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-cli-') || path.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
function newRoot() { const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-cli-')); roots.push(root); return root }
function bundle(node?: WorkflowNode): WorkflowBundle {
  return { assets: node?.type === 'script' ? [{ relativePath: 'scripts/echo.mjs', bytes: new TextEncoder().encode("let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({script:true,input:JSON.parse(s)}))") }] : [], manifest: {
    schemaVersion: 1, id: randomUUID(), name: 'CLI fixture', slug: 'cli-fixture', entryNodeId: 'start',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: node?.type === 'script' ? ['script.trusted-local'] : [] },
    nodes: [{ id: 'start', type: 'start', version: 1, config: {} }, ...(node ? [node] : []), { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: node?.type === 'script' ? { ref: 'node', nodeId: node.id, pointer: '' } : { ref: 'input', pointer: '' } } }],
    edges: node ? [{ from: 'start', port: 'next', to: node.id }, { from: node.id, port: 'success', to: 'end' }] : [{ from: 'start', port: 'next', to: 'end' }]
  } }
}
async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = newRoot(), homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: true, headless: true, ownerKind: 'daemon' })
  const owner = main.getOwnerLease()!
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' }), bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: owner.owner.token })
  const endpoint = await server.start()
  expect(owner.setEndpoint(endpoint)).toBe(true)
  publishOwnRuntimeRecord(homeDir, { ownerToken: owner.owner.token, ownerKind: 'daemon' })
  const rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: owner.owner.token, clientType: 'cli', requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY] })
  await rpc.connect(); await rpc.request('profiles.bind', { profile: alice.id })
  const workflows = createWorkflowDefinitionsClient(rpc)
  const publish = async (content = bundle()) => {
    const draft = await workflows.create({ profileId: alice.id, bundle: content })
    return workflows.publish({ profileId: alice.id, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
  }
  return { root, homeDir, main, alice, bob, rpc, workflows, publish,
    cli: (args: string[], profile = alice.id) => cli(['--home', homeDir, '--profile', profile, '--json', 'workflow', ...args]),
    close: async () => {
      await rpc.close(); await server.stop()
      removeOwnRuntimeRecord(homeDir, owner.owner.token)
      await main.stop()
    } }
}
type CliEvent = { kind: string; requestId?: string; runId?: string; revisionId?: string; run?: WorkflowRunView; runs?: WorkflowRunView[]; events?: unknown[]; hasMore?: boolean; workflows?: unknown[]; error?: string }
function cli(args: string[]): Promise<{ code: number | null; events: CliEvent[]; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('out/cli/index.js'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    let stdout = '', stderr = '', failure: Error | undefined
    const timer = setTimeout(() => { failure = new Error('CLI fixture timed out'); child.kill() }, 20_000)
    const receive = (chunk: Buffer, error: boolean) => {
      if (error) stderr += chunk.toString(); else stdout += chunk.toString()
      if (stdout.length + stderr.length > 4 * 1024 * 1024) { failure = new Error('CLI fixture exceeded output bound'); child.kill() }
    }
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, false)); child.stderr.on('data', (chunk: Buffer) => receive(chunk, true))
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) { reject(failure); return }
      try { resolvePromise({ code, events: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), stderr }) }
      catch { reject(new Error('CLI emitted non-JSON stdout: ' + stdout.slice(0, 500) + '; stderr: ' + stderr.slice(0, 500))) }
    })
  })
}

describe('structured workflow CLI', () => {
  it('parses switches before names and validates inputs before connecting', async () => {
    const parsed = parseArgs(['--json', 'workflow', 'run', '--wait', 'review', '--input', '{"n":2,"ok":false,"items":[1]}'])
    expect(parsed.globals.mode).toBe('json')
    expect(await prepareWorkflowCommand(parsed)).toMatchObject({ command: 'run', target: 'review', wait: true, input: { n: 2, ok: false, items: [1] } })
    for (const args of [
      ['run', 'review', '--wait', '--no-wait'], ['run', 'review', '--draft'], ['run', 'review', '--input', '{'],
      ['run', 'review', '--provider', 'fixture'], ['run', 'review', '--wait=false'], ['run', 'review', '--unexpected'],
      ['approve', randomUUID(), '--yes'], ['history', '--limit', '101'], ['answer', randomUUID(), '--input', 'null'],
      ['reconcile', randomUUID(), '--node', 'node', '--instance', 'instance', '--attempt', '1', '--decision', 'retry']
    ]) await expect(prepareWorkflowCommand(parseArgs(['workflow', ...args]))).rejects.toThrow()
    const root = newRoot(), input = join(root, 'input.json')
    writeFileSync(input, '\uFEFF{"literal":"$(must-not-run)","n":3}')
    expect((await prepareWorkflowCommand(parseArgs(['workflows', 'run', '--no-wait', 'review', '--input-file', input]))).input).toEqual({ literal: '$(must-not-run)', n: 3 })
    writeFileSync(input, ' '.repeat(1024 * 1024 + 1))
    await expect(prepareWorkflowCommand(parseArgs(['workflow', 'run', 'review', '--input-file', input]))).rejects.toThrow('1 MiB')
    expect(['succeeded', 'failed', 'waiting-input', 'waiting-approval', 'cancelled', 'unknown-effect', 'recovery-required', 'interrupted', 'running'].map((state) => workflowWaitExitCode(state as WorkflowRunView['state']))).toEqual([0, 1, 3, 3, 4, 5, 5, 5, undefined])
  })

  it('runs the built CLI through the real owned daemon and retains one pinned admission across head changes', async () => {
    const f = await fixture()
    try {
      const content = bundle(), published = await f.publish(content)
      const input = join(f.root, 'input.json'); writeFileSync(input, '{"count":7,"literal":"$(no-shell)"}')
      const requestId = randomUUID()
      const args = ['run', published.id, '--input-file', input, '--request-id', requestId, '--wait']
      const first = await f.cli(args)
      expect(first.stderr).toBe(''); expect(first.code).toBe(0)
      const accepted = first.events.find((event) => event.kind === 'accepted')!
      expect(first.events[0]).toMatchObject({ kind: 'admitting', requestId })
      expect(first.events.at(-1)?.run).toMatchObject({ state: 'succeeded', profileId: f.alice.id, result: { count: 7, literal: '$(no-shell)' } })
      content.manifest.description = 'Changed after admission'
      const next = await f.workflows.saveDraft({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content })
      expect(next.semanticHash).not.toBe(published.semanticHash)
      await f.workflows.publish({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: next.semanticHash, expectedHeadRevisionId: published.head!.revisionId })
      const retry = await f.cli(args)
      expect(retry.code).toBe(0)
      expect(retry.events.find((event) => event.kind === 'accepted')).toMatchObject({ runId: accepted.runId, revisionId: accepted.revisionId })
      const services = await f.main.getProfileServices(f.alice.id)
      expect(services.threads.listAllThreads()).toHaveLength(1)
      expect((await services.platform.workflowRuns.runtime.get(accepted.runId!, { profileId: f.alice.id })).manifest.source).toBe('cli')
      const history = await f.cli(['history']); expect(history.events[0].runs).toHaveLength(1)
      const foreign = await f.cli(['show', accepted.runId!], f.bob.id); expect(foreign.code).toBe(2)
      expect((await f.cli(['history'], f.bob.id)).events[0].runs).toEqual([])
      const trace = await f.cli(['trace', accepted.runId!, '--limit', '1'])
      expect(trace.events[0].events).toHaveLength(1); expect(trace.events[0].hasMore).toBe(true)
      expect((await f.cli(['list'])).events[0].workflows).toHaveLength(1)
    } finally { await f.close() }
  }, 60_000)

  it('leaves real code awaiting explicit approval, rejects stale approval IDs, then executes and monitors successfully', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(bundle({ id: 'script', type: 'script', version: 1, inputs: { count: { ref: 'input', pointer: '/count' } }, config: { runtime: 'node', file: 'scripts/echo.mjs', executionMode: 'trusted-local' } }))
      const waiting = await f.cli(['run', published.slug, '--input={"count":9}'])
      expect(waiting.code).toBe(3)
      const run = waiting.events.at(-1)!.run!
      expect(run.state).toBe('waiting-approval')
      const stale = await f.cli(['approve', run.runId, '--approval-id', randomUUID(), '--yes'])
      expect(stale.code).toBe(2)
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: run.runId })).state).toBe('waiting-approval')
      expect((await f.cli(['approve', run.runId, '--approval-id', run.pendingApproval!.approvalId, '--yes'])).code).toBe(0)
      const completed = await f.cli(['watch', run.runId])
      expect(completed.code).toBe(0)
      expect(completed.events.at(-1)!.run?.result).toEqual({ script: true, input: { count: 9 } })
      const interrupt = new AbortController()
      const another = await prepareWorkflowCommand(parseArgs(['workflow', 'run', published.id, '--input={"count":10}']))
      let interruptedId = ''
      expect(await executeWorkflowCommand(another, f.rpc, f.alice.id, { signal: interrupt.signal, pollMs: 10, emit: (event) => {
        const item = event as CliEvent
        if (item.kind === 'accepted') interruptedId = item.runId!
        if (item.run?.state === 'waiting-approval') interrupt.abort()
      } })).toBe(4)
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: interruptedId })).state).toBe('cancelled'))
    } finally { await f.close() }
  }, 60_000)

  it('separates foreground cancellation from monitor interruption against actual durable runs', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(bundle({ id: 'delay', type: 'delay', version: 1, config: { durationMs: 30_000 } }))
      const background = await f.cli(['run', published.id, '--no-wait'])
      expect(background.code).toBe(0)
      const runId = background.events.find((event) => event.kind === 'accepted')!.runId!
      const stopWatching = new AbortController(); stopWatching.abort()
      const monitor = await prepareWorkflowCommand(parseArgs(['workflow', 'watch', runId]))
      expect(await executeWorkflowCommand(monitor, f.rpc, f.alice.id, { emit: () => undefined, signal: stopWatching.signal, pollMs: 10 })).toBe(130)
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId })).state).not.toBe('cancelled')
      const interrupt = new AbortController()
      const foreground = await prepareWorkflowCommand(parseArgs(['workflow', 'run', published.id]))
      let foregroundId = ''
      expect(await executeWorkflowCommand(foreground, f.rpc, f.alice.id, { signal: interrupt.signal, pollMs: 10, emit: (event) => {
        const item = event as CliEvent
        if (item.kind === 'accepted') { foregroundId = item.runId!; interrupt.abort() }
      } })).toBe(4)
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: foregroundId })).state).toBe('cancelled'))
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId })).state).not.toBe('cancelled')
      expect((await f.cli(['cancel', runId])).code).toBe(0)
    } finally { await f.close() }
  }, 60_000)
})
