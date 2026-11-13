import { createHash } from 'node:crypto'
import { extractAppletParts, validateAppletSubmission, type AppletReference } from '../../../shared/applets'
import type { BotChatApplet } from '../../../shared/bots/personal/chat'
import type { ChatMessage } from '../../../shared/types'

/**
 * A bot's applets in its chat. A bot's turn publishes applets as a thread's does (`publish_applet`, or a
 * `mousse-applet` fence): its thread's reply keeps them as presentation parts, and the text the bot's turn hands back
 * carries them as fences. The bot's chat row keeps references instead (`BotChatApplet`), matched to what its thread
 * published by source, so the app runs exactly that publication, in the same sandbox and through the same checks as a
 * thread's (`applets.get` serves only an applet a reply of that thread shows).
 */

/** The applets a thread's replies show, newest first: what `applets.get` serves for it. */
export function publishedApplets(messages: readonly ChatMessage[]): AppletReference[] {
  const references: AppletReference[] = []
  for (const message of [...messages].reverse()) {
    if (message.hidden || message.role !== 'assistant' || message.incomplete || message.streaming) continue
    for (const part of message.presentationParts ?? []) if (part.type === 'applet') references.push(part.reference)
  }
  return references
}

/** How Mousse's applet store names a submission's source (`AppletStore.publish`). */
function sourceHashOf(submission: unknown): string {
  return createHash('sha256').update(JSON.stringify(validateAppletSubmission(submission))).digest('hex')
}

/** What a reply shows once its applets are taken out: its words, its applets, and the words its journal keeps. */
export interface ReplyApplets {
  text: string
  applets: BotChatApplet[]
  /** The words with each applet named on a line of its own, for the bot's journal and memory (never its source). */
  journal: string
}

/**
 * A bot reply's applet fences as references to what `threadId` published (`published`, newest first), each used once.
 * A fence its thread did not publish (it failed, or was never offered) is named as unavailable, never shown as source;
 * an invalid one keeps its text with the reason, as a thread's reply does. Undefined when the text has no applet.
 */
export function replyApplets(text: string, threadId: string, published: () => readonly AppletReference[]): ReplyApplets | undefined {
  if (!text.includes('mousse-applet')) return undefined
  const parts = extractAppletParts(text, true)
  if (parts.every((part) => part.type === 'text')) return undefined
  let references: readonly AppletReference[] | undefined
  const used = new Set<AppletReference>()
  const words: string[] = []
  const journal: string[] = []
  const applets: BotChatApplet[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      words.push(part.text)
      journal.push(part.text)
      continue
    }
    if (part.type === 'error') {
      const line = `${part.source}\n\nApplet unavailable: ${part.message}\n`
      words.push(line)
      journal.push(`\n[Applet unavailable: ${part.message}]\n`)
      continue
    }
    let hash: string | undefined
    try {
      hash = sourceHashOf(part.submission)
    } catch {
      hash = undefined
    }
    // A thread that can't be read shows none: the message itself is never lost over it.
    if (!references) {
      try {
        references = published()
      } catch {
        references = []
      }
    }
    const reference = hash ? references.find((candidate) => candidate.sourceHash === hash && !used.has(candidate)) : undefined
    if (reference) {
      used.add(reference)
      applets.push({ threadId, reference })
      journal.push(`\n[Applet: ${reference.title}]\n`)
    } else {
      const line = `\n*Applet unavailable: ${part.submission.title}*\n`
      words.push(line)
      journal.push(line)
    }
  }
  const tidy = (value: string) => value.replace(/\n{3,}/g, '\n\n').trim()
  return { text: tidy(words.join('')), applets, journal: tidy(journal.join('')) }
}
