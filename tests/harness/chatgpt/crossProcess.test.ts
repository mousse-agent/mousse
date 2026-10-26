import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSession, ChatGptStore, chatgptStorePath, emptyStore } from '../../../src/mms/harness/chatgpt/store'
import { crashChild } from '../../support/build'
import { FakeIssuer, guardNetwork, plainCodec, tempHomes, type Reply } from './fakeIssuer'
import { approve, chatgptAuth, signIn, startSignIn } from './signInFlow'

// Two real processes on one instance's store. Correctness rests on the store's conditional commit,
// not on the advisory lock: here the lock is even taken away from a holder that looks suspended.

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
let childExecutable: string
beforeAll(async () => {
  childExecutable = await crashChild('tests/harness/chatgpt/crossProcess-child.ts', { target: 'node24' })
}, 120_000)
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  await issuer.stop()
})

function otherProcess(profileHome: string, operation: 'signOut' | 'delete'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childExecutable, profileHome, operation], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`other process exited ${code}: ${stderr}`))))
  })
}

/** Holds the token endpoint's answers until `release()`. */
function holdTokens() {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  issuer.onToken = async (form): Promise<Reply> => {
    await released
    issuer.onToken = undefined
    return issuer.defaultToken(form)
  }
  return release
}

describe('ChatGPT store across processes', () => {
  it('a refresh held past the lock hold loses to a sign-out from another process', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    await signIn(issuer, auth, { subject: 'alice' })
    // Make the token due for renewal.
    const store = new ChatGptStore(chatgptStorePath(home.profileHome, 'codex:managed'), plainCodec)
    const data = store.read()
    data.sessions[0].expiresAt = Date.now()
    store.write(data)
    const release = holdTokens()
    const refresh = auth.access()
    await vi.waitFor(() => expect(issuer.tokenRequests.some((request) => request.grant_type === 'refresh_token')).toBe(true))
    // The refreshing process looks suspended: its lock is older than the 5-minute hold, so the
    // other process takes it over and signs out.
    const lock = JSON.parse(readFileSync(auth.lifecycle.lockPath, 'utf8'))
    writeFileSync(auth.lifecycle.lockPath, JSON.stringify({ ...lock, acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString() }))
    await otherProcess(home.profileHome, 'signOut')
    // Reads in the refreshing process meanwhile do not change what its write expects.
    expect(auth.status().state).toBe('signed_out')
    release()
    await expect(refresh).rejects.toMatchObject({ code: 'operation_busy' })
    const after = store.read()
    expect(after.active).toBeNull()
    expect(after.sessions).toEqual([])
    expect(activeSession(after)).toBeUndefined()
    // The sign-out retired the session's token; the renewal that lost the race retired the new
    // token it was given, so both are revoked later and nothing valid is left unrecorded.
    expect(after.pendingRevocations).toHaveLength(2)
    expect(new Set(after.pendingRevocations.map((token) => token.refreshToken)).size).toBe(2)
  })

  it('a sign-in that finishes after another process deleted the instance saves nothing', async () => {
    const home = homes()
    const auth = chatgptAuth(issuer, home)
    const flow = startSignIn(auth)
    const link = await flow.link()
    const release = holdTokens()
    await approve(issuer, link, { subject: 'alice' })
    await vi.waitFor(() => expect(issuer.tokenRequests.some((request) => request.grant_type === 'authorization_code')).toBe(true))
    await otherProcess(home.profileHome, 'delete')
    release()
    expect(await flow.result).toMatchObject({ success: false, failure: 'cancelled' })
    expect(new ChatGptStore(chatgptStorePath(home.profileHome, 'codex:managed'), plainCodec).read()).toMatchObject({
      ...emptyStore(),
      revision: expect.any(Number),
      incarnation: expect.any(String),
      credentialEpoch: expect.any(Number),
      signInFence: expect.any(Number)
    })
    // The grant that was not kept is revoked.
    expect(issuer.revokeRequests).toHaveLength(1)
  })
})
