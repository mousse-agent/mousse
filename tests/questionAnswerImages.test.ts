/**
 * Images sent with an answer to an agent's question, over the protocol a window uses: the agent's question tool gets
 * each question's answer with the saved image files named in it, `question_ask` also gets the images themselves, and the
 * transcript keeps every image under the answer it came with.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { ANSWER_IMAGES_FOLDER } from '../src/mms/orchestrator/questionAttachments'
import { askUserTools } from '../src/mms/run/mcp/appTools/askUser'
import type { AppToolHost } from '../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../src/mms/run/mcp/appTools/types'
import type { UserQuestion, UserQuestionAnswers, UserQuestionAttachments } from '../src/shared/types'

/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
/** A different 1×1 picture, so the test can tell which question each went to. */
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const which: UserQuestion = { id: 'screen', prompt: 'Which screen do you mean?', options: [{ id: 'home', label: 'Home' }, { id: 'settings', label: 'Settings' }] }
const what: UserQuestion = { id: 'wrong', prompt: 'What looks wrong?', options: [{ id: 'colors', label: 'Colors' }, { id: 'layout', label: 'Layout' }] }
const areas: UserQuestion = { id: 'areas', prompt: 'Which areas?', allowMultiple: true, options: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API' }] }

describe('answering an agent question with images', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string
  const clients: LocalMmsClient[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-answer-images-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close()
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  async function client(): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    await c.connect()
    clients.push(c)
    return c
  }

  /** Asks `questions` in a new thread the way a provider's question tool does, and waits until the card would show. */
  async function ask(questions: UserQuestion[], onAttachments?: (attachments: UserQuestionAttachments) => void) {
    const thread = mms.threads.createThread('Answer images')
    const answered = mms.questions.requestAnswers(questions, thread.id, onAttachments ? { onAttachments } : {})
    await vi.waitFor(() => expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1))
    return { thread, answered, requestId: mms.questions.listPendingForThread(thread.id)[0]!.requestId }
  }

  /** The image paths an answer names. */
  const namedPaths = (value: string | string[] | undefined): string[] =>
    [...(Array.isArray(value) ? value.join('\n') : value ?? '').matchAll(/\[Image attached: ([^\]]+)\]/g)].map((match) => match[1]!)

  it('each question gets its own images as saved files named in its answer, and the transcript keeps them under it', async () => {
    const { thread, answered, requestId } = await ask([which, what])
    const c = await client()

    await expect(c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { screen: '', wrong: 'The header' },
      attachments: {
        screen: [{ name: 'home.png', mimeType: 'image/png', data: PNG }],
        wrong: [{ name: 'header.gif', mimeType: 'image/gif', data: GIF }]
      }
    })).resolves.toEqual({ ok: true })

    const answers = await answered
    // The question tool receives text: each answer names the files that hold its own images, and nothing else.
    const screenPaths = namedPaths(answers.screen)
    const wrongPaths = namedPaths(answers.wrong)
    expect(screenPaths).toHaveLength(1)
    expect(wrongPaths).toHaveLength(1)
    expect(answers.wrong).toMatch(/^The header\n/)
    expect(readFileSync(screenPaths[0]!).equals(Buffer.from(PNG, 'base64'))).toBe(true)
    expect(readFileSync(wrongPaths[0]!).equals(Buffer.from(GIF, 'base64'))).toBe(true)
    expect(screenPaths[0]).toContain(join(mms.threads.getThreadDir(thread.id), ANSWER_IMAGES_FOLDER))

    // The transcript's answer step shows each image under the question it answered.
    const message = mms.orchestrator.getMessages(thread.id).find((each) => each.questionAnswers?.length)!
    expect(message.images?.map((image) => image.data)).toEqual([PNG, GIF])
    expect(message.questionAnswers).toEqual([
      expect.objectContaining({ prompt: which.prompt, chosen: [], images: [0] }),
      expect.objectContaining({ prompt: what.prompt, reply: 'The header', images: [1] })
    ])
  })

  it('an image is an answer on its own; a question answered without one gets none, and several choices keep their picks', async () => {
    const { thread, answered, requestId } = await ask([areas, which])
    const c = await client()

    await c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { areas: ['ui'], screen: 'home' },
      attachments: { areas: [{ name: 'a.png', mimeType: 'image/png', data: PNG }] }
    })

    const answers: UserQuestionAnswers = await answered
    expect(answers.screen).toBe('home')
    expect(answers.areas).toEqual(['ui', expect.stringMatching(/^\[Image attached: .+\.png\]$/)])
    const message = mms.orchestrator.getMessages(thread.id).find((each) => each.questionAnswers?.length)!
    expect(message.questionAnswers![0]).toMatchObject({ chosen: ['UI'], images: [0] })
    expect(message.questionAnswers![1]).toEqual({ prompt: which.prompt, chosen: ['Home'] })
  })

  it('a caller that can carry images (question_ask) is given them by question, besides the saved paths', async () => {
    const told: UserQuestionAttachments[] = []
    const { answered, requestId } = await ask([which], (attachments) => told.push(attachments))
    const c = await client()

    await c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { screen: 'This one' },
      attachments: { screen: [{ name: 'home.png', mimeType: 'image/png', data: PNG }] }
    })

    await answered
    expect(told).toEqual([{ screen: [{ name: 'home.png', mimeType: 'image/png', data: PNG }] }])
  })

  it('questions named like built-in object keys keep their own answers and images', async () => {
    const named = (id: string): UserQuestion => ({ id, prompt: `Question ${id}?`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    const { thread, answered, requestId } = await ask([named('hasOwnProperty'), named('toString')])
    const c = await client()

    // A text-only answer to `hasOwnProperty` beside an image for `toString`: neither picks up anything inherited.
    await expect(c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { hasOwnProperty: 'a', toString: 'b' },
      attachments: { toString: [{ name: 'x.png', mimeType: 'image/png', data: PNG }] }
    })).resolves.toEqual({ ok: true })
    const answers = await answered
    expect(answers.hasOwnProperty).toBe('a')
    expect(namedPaths(answers.toString)).toHaveLength(1)
    const message = mms.orchestrator.getMessages(thread.id).find((each) => each.questionAnswers?.length)!
    expect(message.questionAnswers?.map((answer) => answer.images)).toEqual([undefined, [0]])
  })

  it('images under a question the request does not ask are dropped, and malformed ones are refused', async () => {
    const { thread, answered, requestId } = await ask([which])
    const c = await client()

    await expect(c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { screen: 'home' },
      attachments: { screen: [{ name: 'x.png', mimeType: 'image/png' }] }
    })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(mms.questions.getPending(requestId)).not.toBeNull()

    await c.request('orchestrator.answerQuestions', {
      requestId,
      answers: { screen: 'home' },
      attachments: { elsewhere: [{ name: 'x.png', mimeType: 'image/png', data: PNG }] }
    })
    await expect(answered).resolves.toEqual({ screen: 'home' })
    expect(existsSync(join(mms.threads.getThreadDir(thread.id), ANSWER_IMAGES_FOLDER))).toBe(false)
  })

  it('an answer that loses the race leaves no saved images behind', async () => {
    const { thread, answered, requestId } = await ask([which])
    const first = await client()
    const second = await client()

    await first.request('orchestrator.answerQuestions', { requestId, answers: { screen: 'home' } })
    await answered
    await expect(second.request('orchestrator.answerQuestions', {
      requestId,
      answers: { screen: 'settings' },
      attachments: { screen: [{ name: 'late.png', mimeType: 'image/png', data: PNG }] }
    })).resolves.toEqual({ ok: false })
    const folder = join(mms.threads.getThreadDir(thread.id), ANSWER_IMAGES_FOLDER)
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
  })
})

describe('question_ask', () => {
  it('returns the images sent with the answers as images, beside the answers that name their files', async () => {
    const host = {
      askUser: async (_threadId: string, _questions: UserQuestion[], options: { onAttachments?: (attachments: UserQuestionAttachments) => void }) => {
        options.onAttachments?.({ screen: [{ name: 'home.png', mimeType: 'image/png', data: PNG }] })
        return { screen: 'home\n[Image attached: /tmp/home.png]' }
      }
    } as unknown as AppToolHost
    const [tool] = askUserTools(host)
    const outcome = await tool!.handler(
      { questions: [{ id: 'screen', prompt: 'Which screen?', options: [{ id: 'home', label: 'Home' }, { id: 'settings', label: 'Settings' }] }] },
      { transport: 'mcp', caller: { threadId: 'thread-1' }, signal: new AbortController().signal } as unknown as ToolCallContext
    )
    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.text)).toEqual({ screen: 'home\n[Image attached: /tmp/home.png]' })
    expect(outcome.images).toEqual([{ mimeType: 'image/png', data: PNG }])
  })
})
