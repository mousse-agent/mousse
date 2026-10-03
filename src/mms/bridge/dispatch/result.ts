import { NetError, isId, type NodeId, type UserId, type RpcId, type Signed } from '../../../shared/net'
import { decodeBase64 } from '../../net/identity/crypto'
import { parseProtocolJson } from '../../net/sync/codec'
import type { NetIdentityService } from '../../net/identity/NetIdentityService'
import { artifact } from './validate'
import { COMMIT, REPO_ID } from './repository'
import { resultRef } from './bundle'
import type { DispatchResultBody } from './types'

/** Verify the target signature and exact task binding before showing/applying any result. */
export function verifyDispatchResult(identity: NetIdentityService, signed: Signed, expected: { node: NodeId; user: UserId; rpc: RpcId; execution: string; repoId: string; baseCommit: string; requestHash: string }): DispatchResultBody {
  if (!signed || Object.keys(signed).some(key => !['payload', 'sig'].includes(key))) throw new NetError('bad_request')
  const bytes = decodeBase64(signed.payload)
  if (bytes.length > 64 * 1024) throw new NetError('too_large')
  const row = parseProtocolJson(bytes) as DispatchResultBody
  const fields = ['v', 'kind', 'dispatch', 'execution', 'rpc', 'requestHash', 'author', 'issuedAt', 'repoId', 'baseCommit', 'headCommit', 'branch', 'ref', 'bundleHash', 'artifact', 'agent', 'threadId', 'errors']
  if (!row || typeof row !== 'object' || Object.keys(row).some(key => !fields.includes(key)) || row.v !== 1 || row.kind !== 'bridge.dispatch.result.v1' || !row.author || !row.author.user || row.author.bot || !isId('node', row.author.node) || !Number.isSafeInteger(row.issuedAt) || row.issuedAt < 0) throw new NetError('bad_request')
  identity.verifyAuthor(row.author, bytes, decodeBase64(signed.sig, 64), row.issuedAt, 'history')
  if (row.author.node !== expected.node || row.author.user !== expected.user || row.rpc !== expected.rpc || row.execution !== expected.execution || row.repoId !== expected.repoId || row.baseCommit !== expected.baseCommit || row.requestHash !== expected.requestHash) throw new NetError('forbidden')
  if (!REPO_ID.test(row.repoId) || !COMMIT.test(row.headCommit) || !COMMIT.test(row.baseCommit) || !isId('dispatch', row.dispatch) || !isId('execution', row.execution) || row.ref !== resultRef(row.dispatch) || row.branch !== `mousse/agent/${row.dispatch}` || !/^[a-f0-9]{64}$/.test(row.bundleHash) || !/^[a-f0-9]{64}$/.test(row.requestHash) || !row.agent || Object.keys(row.agent).some(key => !['definitionId', 'revision', 'profileId'].includes(key)) || [row.agent.revision, row.agent.definitionId, row.agent.profileId, row.threadId].some(value => typeof value !== 'string' || !value.length || value.length > 256) || !Array.isArray(row.errors) || row.errors.length) throw new NetError('bad_request')
  artifact(row.artifact)
  if (row.artifact.blob !== `blb_${row.bundleHash}`) throw new NetError('conflict')
  return row
}
