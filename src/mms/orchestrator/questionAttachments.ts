/**
 * Images sent with an answer to an agent's question. Every provider's question tool takes text only (Claude Code's
 * AskUserQuestion, Codex's request_user_input), so each image is saved as a file and its path is added to the answer
 * of the question it answers: the agent opens it with its own image viewer. Mousse's `question_ask` also returns the
 * images themselves (`UserQuestionService.requestAnswers`' `onAttachments`).
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChatImageAttachment, UserQuestion, UserQuestionAnswers, UserQuestionAttachments } from '../../shared/types'

/** The folder of a thread's answer images, inside the thread's own folder (deleted with the thread). */
export const ANSWER_IMAGES_FOLDER = 'answer-images'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/avif': 'avif'
}

/**
 * The value `map` holds under `key` itself, never one it inherits: a question may be named `constructor` or
 * `__proto__`. Maps keyed by question id are made with `idMap()` so writing such a key stays an own property.
 */
export function ownList<T>(map: Record<string, T[]> | undefined, key: string): T[] | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined
  const value = map[key]
  return Array.isArray(value) ? value : undefined
}

/** An empty map keyed by question id, with no prototype to collide with an id. */
export function idMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** Only the questions the request asks: an image under another id answers nothing and is dropped. */
export function attachmentsForQuestions(questions: UserQuestion[], attachments: UserQuestionAttachments | undefined): UserQuestionAttachments {
  const out = idMap<ChatImageAttachment[]>()
  for (const question of questions) {
    const images = ownList(attachments, question.id)
    if (images?.length) out[question.id] = images
  }
  return out
}

/**
 * Writes each image to `<threadDir>/answer-images/<requestId>/<question>-<n>.<ext>` and returns the paths by
 * question id. Names come from positions, never from the sender. Throws when a file cannot be written; nothing
 * written by this call is left behind then.
 */
export function saveAnswerImages(threadDir: string, requestId: string, questions: UserQuestion[], attachments: UserQuestionAttachments): Record<string, string[]> {
  const folder = join(threadDir, ANSWER_IMAGES_FOLDER, requestId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'request')
  const paths = idMap<string[]>()
  let made = false
  try {
    questions.forEach((question, questionIndex) => {
      const images = ownList(attachments, question.id)
      if (!images?.length) return
      if (!made) {
        mkdirSync(folder, { recursive: true })
        made = true
      }
      paths[question.id] = images.map((image, imageIndex) => {
        const extension = EXTENSIONS[image.mimeType.toLowerCase()] ?? 'png'
        const path = join(folder, `${questionIndex + 1}-${imageIndex + 1}.${extension}`)
        writeFileSync(path, Buffer.from(image.data, 'base64'))
        return path
      })
    })
  } catch (error) {
    if (made) removeAnswerImages(folder)
    throw error
  }
  return paths
}

/** Removes the folder `saveAnswerImages` wrote, when the answer it was for did not go through. */
export function removeAnswerImages(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch {
    // A leftover image in the thread's folder goes with the thread.
  }
}

/** The line an answer gets for each saved image: what the agent opens to see it. */
export function attachedImageLine(path: string): string {
  return `[Image attached: ${path}]`
}

/**
 * The answers as the agent receives them: each question's saved images named after its answer, as text a question
 * tool can carry. A single answer gets the lines after its text; several get them as extra entries.
 */
export function answersWithImagePaths(questions: UserQuestion[], answers: UserQuestionAnswers, paths: Record<string, string[]>): UserQuestionAnswers {
  const out: UserQuestionAnswers = Object.assign(idMap<string | string[]>(), answers)
  for (const question of questions) {
    const saved = ownList(paths, question.id)
    if (!saved?.length) continue
    const lines = saved.map(attachedImageLine)
    const value = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined
    if (Array.isArray(value)) out[question.id] = [...value, ...lines]
    else out[question.id] = [typeof value === 'string' ? value.trim() : '', ...lines].filter(Boolean).join('\n')
  }
  return out
}

/** The images of an answer message in question order, and which of them each question got (`AnsweredQuestion.images`). */
export function answerMessageImages(questions: UserQuestion[], attachments: UserQuestionAttachments): { images: ChatImageAttachment[]; indexes: Record<string, number[]> } {
  const images: ChatImageAttachment[] = []
  const indexes = idMap<number[]>()
  for (const question of questions) {
    const own = ownList(attachments, question.id)
    if (!own?.length) continue
    indexes[question.id] = own.map((image) => images.push(image) - 1)
  }
  return { images, indexes }
}
