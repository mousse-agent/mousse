import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { WorkflowRunView } from '../src/shared/workflowRunPlatform'

async function until<T>(probe: () => T | Promise<T>, ready: (value: T) => boolean, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value: T
  do {
    value = await probe()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 40))
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for daemon crash fixture state: ' + JSON.stringify(value))
}

async function killAndJoin(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill('SIGKILL')
  await exited
}

it('E2E10 kills the actual MMS daemon after script dispatch and recovers without repeating the effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-daemon-crash-'))
  const home = join(root, 'home'), marker = join(root, 'dispatch.txt'), scriptPidPath = join(root, 'script.pid')
  const children: ChildProcess[] = []
  let rpc: LocalMmsClient | undefined
  const launch = async () => {
    let output = ''
    const child = spawn(process.execPath, [resolve('out/cli/index.js'), '--home', home, 'service', 'run'], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOUSSE_HOME: home, MOUSSE_REPO_ROOT: root, NO_COLOR: '1' }
    })
    children.push(child)
    child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-8000) })
    child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-8000) })
    const owner = await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Daemon exited before ready: ' + output)
      try {
        const runtime = JSON.parse(readFileSync(join(home, 'mms.runtime.json'), 'utf8'))
        const record = JSON.parse(readFileSync(join(home, 'mms.owner.json'), 'utf8'))
        return runtime.pid === child.pid && record.pid === child.pid ? record : undefined
      } catch { return undefined }
    }, Boolean, 40000).catch((error) => { throw new Error(String(error) + '\n' + output) })
    rpc = new LocalMmsClient({ homeDir: home, endpoint: owner.endpoint, ownerToken: owner.token, clientType: 'gui', requestedCapabilities: ['profiles-v1', 'workflows.definitions.v1', 'workflowRuns.v1'] })
    await rpc.connect()
    const profiles = await rpc.request<{ defaultProfileId: string }>('profiles.list', {})
    await rpc.request('profiles.bind', { profile: profiles.defaultProfileId })
    return { child, profileId: profiles.defaultProfileId }
  }
  try {
    const first = await launch()
    const script = `import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'dispatch\\n');writeFileSync(${JSON.stringify(scriptPidPath)},String(process.pid));setInterval(()=>{},1000);`
    const draft = await rpc!.request<{ id: string; semanticHash: string }>('workflows.create', {
      profileId: first.profileId,
      bundle: {
        assets: [{ relativePath: 'scripts/effect.mjs', encoding: 'utf8', data: script }],
        manifest: {
          schemaVersion: 1, id: randomUUID(), name: 'Daemon effect crash', slug: 'daemon-effect-crash',
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: ['script.trusted-local'] }, entryNodeId: 'start',
          nodes: [
            { id: 'start', type: 'start', version: 1, config: {} },
            { id: 'effect', type: 'script', version: 1, effect: 'external', config: { runtime: 'node', file: 'scripts/effect.mjs', executionMode: 'trusted-local', timeoutMs: 30000 } },
            { id: 'end', type: 'end', version: 1, config: {} }
          ],
          edges: [{ from: 'start', port: 'next', to: 'effect' }, { from: 'effect', port: 'success', to: 'end' }]
        }
      }
    })
    await rpc!.request('workflows.publish', { profileId: first.profileId, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
    const admitted = await rpc!.request<WorkflowRunView>('workflowRuns.start', { profileId: first.profileId, definitionId: draft.id, requestId: randomUUID(), input: {} })
    const get = () => rpc!.request<WorkflowRunView>('workflowRuns.get', { profileId: first.profileId, runId: admitted.runId })
    const waiting = await until(get, (view) => view.state === 'waiting-approval' || view.state === 'failed')
    expect(waiting.state, waiting.error).toBe('waiting-approval')
    const { approvalId, nodeId, instanceKey, attempt } = waiting.pendingApproval!
    await rpc!.request('workflowRuns.approve', { profileId: first.profileId, runId: admitted.runId, approvalId, nodeId, instanceKey, attempt, approved: true })
    await until(() => existsSync(marker), Boolean)
    expect((await get()).state).toBe('running')
    await rpc!.close(); rpc = undefined
    await killAndJoin(first.child)
    const second = await launch()
    expect(second.profileId).toBe(first.profileId)
    const recovered = await until(get, (view) => ['unknown-effect', 'failed', 'succeeded'].includes(view.state))
    expect(recovered.state, recovered.error).toBe('unknown-effect')
    expect(recovered.revisionId).toBe(admitted.revisionId)
    expect(readFileSync(marker, 'utf8')).toBe('dispatch\n')
    const runs = await rpc!.request<{ runs: WorkflowRunView[] }>('workflowRuns.list', { profileId: first.profileId })
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0].runId).toBe(admitted.runId)
    await new Promise((done) => setTimeout(done, 250))
    expect(readFileSync(marker, 'utf8')).toBe('dispatch\n')
  } finally {
    await rpc?.close()
    await Promise.all(children.map(killAndJoin))
    if (existsSync(scriptPidPath)) {
      const pid = Number(readFileSync(scriptPidPath, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL') } catch { /* already joined by the daemon supervisor */ } }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 120000)
