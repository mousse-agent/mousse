import { extractAppletParts, type AppletPresentationPart } from '../../shared/applets'
import type { AppletStore } from './AppletStore'

/** Only call for a completed root assistant message. Invalid applets remain inert, reviewable text. */
export function publishAppletPresentation(
  store: AppletStore,
  input: { threadId: string; messageId: string; turnId: string; content: string }
): AppletPresentationPart[] | undefined {
  const extracted = extractAppletParts(input.content, true)
  if (extracted.every((part) => part.type === 'text')) return undefined
  let index = 0
  return extracted.map((part): AppletPresentationPart => {
    if (part.type === 'text') return part
    if (part.type === 'error')
      return { type: 'text', text: `${part.source}\n\nApplet unavailable: ${part.message}\n` }
    const submissionIndex = index++
    try {
      const bundle = store.publish({
        ...input,
        submission: part.submission,
        index: submissionIndex
      })
      return {
        type: 'applet',
        reference: {
          appletId: bundle.appletId,
          revisionId: bundle.revisionId,
          sourceHash: bundle.sourceHash,
          title: bundle.title,
          description: bundle.description
        }
      }
    } catch {
      // Storage diagnostics must not expose host filesystem details in the transcript.
      return {
        type: 'text',
        text:
          '```mousse-applet\n' +
          JSON.stringify(part.submission, null, 2) +
          '\n```\n\nApplet unavailable: publication failed. The source is preserved above; ask me to retry or refresh its revision.\n'
      }
    }
  })
}

/** On restart, recover only a prior durable publication. Unpublished legacy source stays inert. */
export function recoverAppletPresentation(
  store: AppletStore,
  input: { threadId: string; messageId: string; turnId: string; content: string }
): AppletPresentationPart[] | undefined {
  let index = 0
  let recovered = false
  const parts = extractAppletParts(input.content, true).map((part): AppletPresentationPart => {
    if (part.type === 'text') return part
    if (part.type === 'error') return { type: 'text', text: part.source }
    const submissionIndex = index++
    try {
      const bundle = store.recoverPublication({
        ...input,
        submission: part.submission,
        index: submissionIndex
      })
      if (bundle) {
        recovered = true
        return {
          type: 'applet',
          reference: {
            appletId: bundle.appletId,
            revisionId: bundle.revisionId,
            sourceHash: bundle.sourceHash,
            title: bundle.title,
            description: bundle.description
          }
        }
      }
    } catch {
      /* A missing or corrupt durable publication never authorizes new execution. */
    }
    return {
      type: 'text',
      text: '```mousse-applet\n' + JSON.stringify(part.submission, null, 2) + '\n```\n'
    }
  })
  return recovered ? parts : undefined
}
