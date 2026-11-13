import { validateBrowserHumanInput } from '../../browser/validation'
import type { BotBrowserInput } from './browser'

/** The one-time token this computer's file dialog was answered with (`bots.browser.files`). */
export const BOT_BROWSER_FILES_TOKEN = /^files_[A-Za-z0-9-]{8,64}$/

/**
 * A person's input on a hold's channel, checked as the daemon checks it: every kind a managed tab
 * takes, except that files go as a token, never as paths. Throws what the daemon would refuse; the
 * view checks each input with this before it numbers it, so an input the daemon never takes never
 * holds up the ones after it.
 */
export function validateBotBrowserInput(value: unknown): BotBrowserInput {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (record?.kind === 'files') {
    if (Object.keys(record).some((key) => key !== 'kind' && key !== 'token')) throw new Error('invalid_action: files go as the token of this computer\'s file dialog')
    if (record.token === undefined) return { kind: 'files' }
    if (typeof record.token !== 'string' || !BOT_BROWSER_FILES_TOKEN.test(record.token)) throw new Error('invalid_action: invalid files token')
    return { kind: 'files', token: record.token }
  }
  return validateBrowserHumanInput(value) as BotBrowserInput
}

/** Why the daemon would refuse an input, in a short line for the person; undefined when it takes it. */
export function botBrowserInputProblem(input: BotBrowserInput): string | undefined {
  try {
    validateBotBrowserInput(input)
    return undefined
  } catch {
    if (input.kind === 'dialog' && (input.text?.length ?? 0) > 4096) return 'Too long: the page takes at most 4,096 characters here'
    if (input.kind === 'type' || input.kind === 'compose') return 'Too long to type at once'
    return 'That can\'t be sent to the page'
  }
}
