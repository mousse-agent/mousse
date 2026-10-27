import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SshBootstrap } from '../../../src/mms/net/ssh/bootstrap'
import { newId } from '../../../src/shared/net'

/**
 * Opt-in: runs the host key retrieval and the forwarding probe against the developer's own sshd with
 * the real `ssh`. It never reaches another machine. Run with `MOUSSE_SSH_E2E=1` (and an sshd on
 * localhost that accepts your key); it is not part of the branch test selection.
 */
const enabled = process.env.MOUSSE_SSH_E2E === '1'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

it.skipIf(!enabled)(
  'reads the host key and passes the forwarding probe against localhost',
  async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'mousse-ssh-e2e-'))
    cleanup.push(() => rm(profileDir, { recursive: true, force: true }))
    const ssh = new SshBootstrap(
      {
        profileDir,
        inviteNode: async () => ({ invite: 'mj1_x', inviteId: newId('invite') }),
        inviteOutcome: () => ({ state: 'missing' }),
        revokeInvite: () => {},
        revokeNode: async () => {},
        openEnrollmentListener: async () => ({ port: 1, close: async () => {} }),
        adoptRoutes: () => {},
        peerOpen: () => false,
        knownNode: () => false
      },
      { binary: () => undefined }
    )
    cleanup.push(() => ssh.close())
    const first = await ssh.check('localhost')
    expect(first.phase).toBe('untrusted')
    expect(first.hostKey?.fingerprint).toMatch(/^SHA256:/)
    const trusted = await ssh.trust({ host: 'localhost', fingerprint: first.hostKey!.fingerprint })
    expect(trusted.ok).toBe(true)
    const probed = await ssh.check('localhost')
    expect(probed.phase).toBe('probed')
    // `connect failed` (forwarding allowed, port 1 closed) is the pass signal.
    expect(probed.prerequisites.find((item) => /TCP forwarding/.test(item.name))?.ok).toBe(true)
  },
  60_000
)
