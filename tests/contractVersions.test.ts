import { describe, expect, it } from 'vitest'
import { CONTRACT_VERSIONS } from '../src/mms/contractVersions'

describe('contract versions', () => {
  // Changing a value here means older or newer builds can no longer read or speak that contract.
  // Update this list in the same PR and call the bump out in its description (docs/releases.md).
  it('lists every contract at its current version', () => {
    expect(CONTRACT_VERSIONS).toEqual({
      daemonProtocol: 2,
      daemonOwnerLease: 1,
      netProtocol: '1.0',
      netEnvelope: 1,
      runDatabase: 15,
      mousseConf: 1,
      installation: 2,
      profile: '1.0.0',
      workflowFormat: 1,
      agentDefinition: 1,
      resourceLifecycle: 1,
      execution: 1,
      browserWorker: 1
    })
  })
})
