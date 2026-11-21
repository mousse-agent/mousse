/**
 * A drive that stops answering never holds `git.heads` past its bound: each folder on it answers that it is not
 * answering within `HEAD_ANSWER_MS` (under the 3 s the side card's Retry promises), at most two reads wait on the
 * drive at once whatever the number of cards, and the drive's other folders answer at once after that.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const waits = vi.hoisted(() => ({ started: 0, hang: true }))
vi.mock('../src/mms/files/folderAccess', () => ({
  waitForFolderAccess: () => {
    waits.started++
    return waits.hang ? new Promise(() => undefined) : Promise.resolve()
  }
}))

const { folderHead, HEAD_ANSWER_MS } = await import('../src/mms/workspace/threadHeads')

beforeEach(() => {
  vi.useFakeTimers()
  waits.started = 0
  waits.hang = true
})
afterEach(() => vi.useRealTimers())

it('answers every folder on a stalled drive within the bound, with two reads on the drive at most', async () => {
  const folders = Array.from({ length: 50 }, (_, index) => `Q:\stalled\repo-${index}`)
  const answers = Promise.all(folders.map((folder) => folderHead(folder)))
  await vi.advanceTimersByTimeAsync(0)
  expect(waits.started).toBe(2)
  await vi.advanceTimersByTimeAsync(HEAD_ANSWER_MS)
  const answered = await answers
  expect(HEAD_ANSWER_MS).toBeLessThan(3_000)
  expect(answered.every((answer) => 'error' in answer && /not answering/.test(answer.error))).toBe(true)
  expect(waits.started).toBe(2)

  // Asked again while the drive is still stalled: answered at once, and nothing more waits on it.
  const again = folderHead('Q:\stalled\repo-0')
  await vi.advanceTimersByTimeAsync(0)
  expect(await again).toMatchObject({ error: expect.stringMatching(/not answering/) })
  expect(waits.started).toBe(2)
})
