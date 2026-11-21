/**
 * A drive that stops answering never holds `git.heads` past its bound: each folder on it answers that it is not
 * answering within `HEAD_ANSWER_MS` (under the 3 s the side card's Retry promises), at most two reads wait on the
 * drive at once whatever the number of cards, and the drive's other folders answer at once after that.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { folderHead, HEAD_ANSWER_MS } from '../src/mms/workspace/threadHeads'
import type { GitHeadsResult } from '../src/shared/types'

const waits = vi.hoisted(() => ({ started: 0, hang: (_path: string) => true }))
vi.mock('../src/mms/files/folderAccess', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/mms/files/folderAccess')>(),
  waitForFolderAccess: ([path]: string[]) => {
    waits.started++
    return waits.hang(path) ? new Promise(() => undefined) : Promise.resolve()
  }
}))

const onVolume = (name: string, drive: string) =>
  process.platform === 'win32' ? `${drive}:/${name}` : `${process.platform === 'darwin' ? '/Volumes' : '/mnt'}/${name}`

beforeEach(() => {
  vi.useFakeTimers()
  waits.started = 0
  waits.hang = () => true
})
afterEach(() => vi.useRealTimers())

const batch = (mms: unknown, params: unknown) =>
  dispatchMethod({ mms: mms as HandlerContext['mms'], globalSequence: () => 0 }, 'git.heads', params) as Promise<GitHeadsResult>
const owned = vi.fn(async (_method: string, work: () => Promise<unknown>) => work())

it('validates a malformed batch before admission and bounds a valid batch’s lifecycle lookup', async () => {
  const synchronous = vi.fn(() => { throw new Error('synchronous filesystem lookup') })
  const locate = vi.fn(() => new Promise(() => undefined))
  owned.mockClear()
  const mms = {
    runOwnedRequest: owned,
    getProfileHomeDir: () => onVolume('profile', 'R'),
    threads: { lifecycleStore: { get: synchronous }, peekThreadLocation: locate }
  }
  await expect(batch(mms, { threadIds: ['uncached'], surprise: true })).rejects.toMatchObject({ code: 'invalid_params' })
  expect(owned).not.toHaveBeenCalled()
  expect(locate).not.toHaveBeenCalled()

  const answer = batch(mms, { threadIds: ['uncached'] })
  await vi.advanceTimersByTimeAsync(HEAD_ANSWER_MS)
  expect((await answer).threads.uncached).toMatchObject({ error: expect.stringMatching(/not answering/) })
  expect(locate).toHaveBeenCalledWith('uncached')
  expect(synchronous).not.toHaveBeenCalled()
  expect(waits.started).toBe(0)
})

it('answers every folder on a stalled drive within the bound, with two reads on the drive at most', async () => {
  const folders = Array.from({ length: 50 }, (_, index) => `${onVolume('stalled', 'Q')}/repo-${index}`)
  const answers = Promise.all(folders.map((folder) => folderHead(folder)))
  await vi.advanceTimersByTimeAsync(0)
  expect(waits.started).toBe(2)
  await vi.advanceTimersByTimeAsync(HEAD_ANSWER_MS)
  const answered = await answers
  expect(HEAD_ANSWER_MS).toBeLessThan(3_000)
  expect(answered.every((answer) => 'error' in answer && /not answering/.test(answer.error))).toBe(true)
  expect(waits.started).toBe(2)

  // Asked again while the drive is still stalled: answered at once, and nothing more waits on it.
  const again = folderHead(folders[0]!)
  await vi.advanceTimersByTimeAsync(0)
  expect(await again).toMatchObject({ error: expect.stringMatching(/not answering/) })
  expect(waits.started).toBe(2)
})

it('answers the healthy volume while two admitted reads on another volume are held', async () => {
  const stalled = onVolume('independently-stalled', 'S')
  const healthy = process.cwd()
  const getProject = (id: string) => ({ path: id === 'healthy' ? healthy : `${stalled}/${id}` })
  waits.hang = (path) => path !== healthy
  const mms = { runOwnedRequest: owned, projects: { getProject } }
  const blocked = batch(mms, { projectIds: ['one', 'two'] })
  await vi.advanceTimersByTimeAsync(0)
  expect(waits.started).toBe(2)

  const independent = batch(mms, { projectIds: ['healthy'] })
  await vi.advanceTimersByTimeAsync(0)
  expect(waits.started).toBe(3)
  expect((await independent).projects.healthy).toMatchObject({ repo: true })
  await vi.advanceTimersByTimeAsync(HEAD_ANSWER_MS)
  expect((await blocked).projects.one).toMatchObject({ error: expect.stringMatching(/not answering/) })
})
