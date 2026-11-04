import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { NetIdentityService } from '../../../../src/mms/net/identity/NetIdentityService'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import { DispatchService } from '../../../../src/mms/bridge/dispatch/service'
import { registerOwnedGitRoot } from '../../../../src/mms/git/gitPolicy'
import type { ResolvedAgentDefinition } from '../../../../src/shared/agents/types'
import { newId, type Roster, type NodeDelegation } from '../../../../src/shared/net'

async function main() {
  const input = JSON.parse(process.argv[2]),
    db = new NetDatabase({ profileDir: input.profile }),
    keys = new FileKeyStore(input.profile)
  // The profile and installation homes are Mousse's, as in the test process.
  registerOwnedGitRoot(input.profile)
  registerOwnedGitRoot(input.home)
  const identity = new NetIdentityService({
    database: db.database,
    keys,
    clock: db.clock,
    coordinator: db
  })
  const roster = identity.verifySigned<Roster>(identity.roster()!, keys.rootKey()!),
    delegation = identity.verifySigned<NodeDelegation>(roster.nodes[0], keys.rootKey()!)
  // `cleanup-keeping` and `cleanup-deleting`: the dispatch completes, and the process stops for good right after its
  // cleanup recorded that step, so the test can end it there.
  const cleanupStep = typeof input.phase === 'string' && input.phase.startsWith('cleanup-') ? input.phase.slice('cleanup-'.length) : undefined
  if (cleanupStep) {
    const prototype = DispatchService.prototype as unknown as { save(record: { worktreeCleanup?: { phase: string } }, insert?: boolean): void }
    const save = prototype.save
    prototype.save = function (record, insert) {
      save.call(this, record, insert)
      if (record.worktreeCleanup?.phase === cleanupStep) {
        writeFileSync(input.marker, 'paused')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
    }
  }
  const threads = new ThreadDataStore(new ProjectManager(input.profile), input.profile, {
    profileId: 'test',
    allowLegacyProjectData: false
  })
  const service = new DispatchService({
    db,
    identity,
    installationHome: input.home,
    profileHome: input.profile,
    profileId: 'test',
    threads,
    runtime: {
      resolveAgent: async () => {
        if (input.phase === 'preparing') {
          process.send?.({ ready: true })
          await new Promise(() => undefined)
        }
        return {
          definitionId: 'agent_dispatch',
          profileId: 'test',
          revision: 'revision-1',
          runtimeKind: 'mousse'
        } as ResolvedAgentDefinition
      },
      run: async (request) => {
        if (cleanupStep) {
          for (const [path, bytes] of Object.entries(input.outputs as Record<string, string>)) {
            await mkdir(dirname(join(request.worktreePath, path)), { recursive: true })
            await writeFile(join(request.worktreePath, path), Buffer.from(bytes, 'base64'))
          }
          return {
            runId: request.executionId,
            profileId: 'test',
            threadId: request.threadId,
            definitionId: 'agent_dispatch',
            definitionRevision: 'revision-1',
            runtimeKind: 'mousse',
            status: 'completed',
            text: 'done',
            history: [],
            usage: { elapsedMs: 1 }
          }
        }
        await writeFile(
          join(request.worktreePath, 'crash-effect.txt'),
          'committed model effect before SIGKILL'
        )
        process.send?.({ ready: true })
        return new Promise(() => undefined)
      }
    },
    artifacts: {
      readInput: async () => {
        throw new Error('not reached')
      },
      prepareResult: async (bytes) => {
        if (!cleanupStep) throw new Error('not reached')
        return {
          ref: { stream: newId('stream'), event: newId('event'), blob: `blb_${createHash('sha256').update(bytes).digest('hex')}` },
          commit: () => undefined
        }
      }
    }
  })
  const terminal: Array<() => void> = []
  await service.run(
    input.request,
    {
      id: input.rpc,
      caller: { ...identity.self()!, delegation },
      deadlineAt: db.clock.now() + 60_000,
      signal: new AbortController().signal,
      progress: () => undefined,
      onTerminalCommit: (work) => terminal.push(work)
    },
    input.execution
  )
  // The terminal transaction, as the RPC layer commits it; the cleanup starts after it.
  db.transaction(() => terminal.forEach((work) => work()))
  await service.drainCleanup()
}
void main().catch(() => {
  process.send?.({ failed: true })
  process.exitCode = 1
})
