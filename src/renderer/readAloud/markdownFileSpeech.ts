import { create } from 'zustand'
import { useReadAloudStore } from './readAloudStore'

/** Only loaded Markdown previews are published here. Source buffers never offer speech. */
export const useMarkdownFileSpeech = create<{ previews: Record<string, string> }>(() => ({ previews: {} }))
export const markdownFileSpeechKey = (scope: string, path: string) => `markdown-file:${scope}\0${path}`

export function publishMarkdownPreviews(scope: string, previews: Record<string, string>): void {
  const prefix = markdownFileSpeechKey(scope, '')
  const current = useMarkdownFileSpeech.getState().previews
  const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))
  for (const [path, text] of Object.entries(previews)) next[markdownFileSpeechKey(scope, path)] = text
  useMarkdownFileSpeech.setState({ previews: next })
  const speech = useReadAloudStore.getState()
  // Closing a file or entering Source cancels both playback and an unanswered voice picker.
  if (speech.activeKey?.startsWith(prefix) && !(speech.activeKey in next)) speech.stop()
  if (speech.pending?.key.startsWith(prefix) && !(speech.pending.key in next)) speech.closePicker()
}
