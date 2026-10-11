import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { NetIdentityService } from '../../../../src/mms/net/identity/NetIdentityService'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import { DispatchService } from '../../../../src/mms/bridge/dispatch/service'
import type { ResolvedAgentDefinition } from '../../../../src/shared/agents/types'
import type { Roster, NodeDelegation } from '../../../../src/shared/net'

async function main() {
  const input = JSON.parse(process.argv[2]),
    db = new NetDatabase({ profileDir: input.profile }),
    keys = new FileKeyStore(input.profile)
  const identity = new NetIdentityService({
    database: db.database,
    keys,
    clock: db.clock,
    coordinator: db
  })
  const roster = identity.verifySigned<Roster>(identity.roster()!, keys.rootKey()!),
    delegation = identity.verifySigned<NodeDelegation>(roster.nodes[0], keys.rootKey()!)
  const threads = new ThreadDataStore(new ProjectManager(input.profile), input.profile, {
    profileId: 'test',
    allowLegacyProjectData: false
  })
  const service = new DispatchService({
    db,
    identity,
    installationHome: input.home,
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
      prepareResult: async () => {
        throw new Error('not reached')
      }
    }
  })
  await service.run(
    input.request,
    {
      id: input.rpc,
      caller: { ...identity.self()!, delegation },
      deadlineAt: db.clock.now() + 60_000,
      signal: new AbortController().signal,
      progress: () => undefined,
      onTerminalCommit: () => undefined
    },
    input.execution
  )
}
void main().catch(() => {
  process.send?.({ failed: true })
  process.exitCode = 1
})
