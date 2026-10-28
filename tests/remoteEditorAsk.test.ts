import { describe, expect, it } from 'vitest'
import { askForEditorAccess } from '../src/main/remoteEditorAsk'
import { newId } from '../src/shared/net'
import { qualifyId } from '../src/shared/threadRef'

const node = newId('node')
const threadId = qualifyId(node, 't1')
const router = (code: string, details?: unknown) => Object.assign(new Error(`router: ${code}`), { code, details })

describe('asking the computer that runs a thread to allow editor connections', () => {
  it('sends one routed call that names the computer and nothing else', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const result = await askForEditorAccess(async (method, params) => {
      calls.push({ method, params })
      return { state: 'asked', expiresAt: 5 }
    }, threadId)
    expect(result).toEqual({ ok: true, reply: { state: 'asked', expiresAt: 5 } })
    expect(calls).toEqual([{ method: 'editor.ask', params: { node } }])
  })

  it.each([
    [{ state: 'pending', expiresAt: 9 }],
    [{ state: 'already_on' }],
    [{ state: 'declined_recently', retryAt: 9 }],
    [{ state: 'rate_limited', retryAt: 9 }]
  ])('passes the answer %j on as it is', async (reply) => {
    expect(await askForEditorAccess(async () => reply, threadId)).toEqual({ ok: true, reply })
  })

  it('tells a blocked computer it is blocked, and never offers a second try', async () => {
    const result = await askForEditorAccess(async () => {
      throw router('computer_forbidden', { reason: 'blocked' })
    }, threadId)
    expect(result).toMatchObject({ ok: false, failure: 'blocked' })
  })

  it.each([
    [router('computer_offline'), 'offline'],
    [router('computer_forbidden', { reason: 'setting_off' }), 'setting_off'],
    [router('computer_forbidden', { reason: 'capability' }), 'capability'],
    [router('computer_outdated'), 'unsupported'],
    [router('rate_limited'), 'rate_limited'],
    [router('deadline_exceeded'), 'timeout']
  ])('says why it could not ask: %s', async (error, failure) => {
    expect(
      await askForEditorAccess(async () => {
        throw error
      }, threadId)
    ).toMatchObject({ ok: false, failure })
  })

  it('throws what it cannot explain, and a thread of this computer, and an answer it does not know', async () => {
    await expect(
      askForEditorAccess(async () => {
        throw new Error('disk full')
      }, threadId)
    ).rejects.toThrow('disk full')
    await expect(askForEditorAccess(async () => ({ state: 'asked', expiresAt: 1 }), 'a-local-thread')).rejects.toThrow(/this computer/)
    await expect(askForEditorAccess(async () => ({ state: 'maybe' }), threadId)).rejects.toThrow(/does not know/)
  })
})
