import { phonemize } from 'phonemizer'

/**
 * Text to espeak-ng phonemes for the models that were trained on them. `phonemizer` drops
 * punctuation, which these models use for pauses and intonation, so punctuation is split off,
 * kept as it is, and only the text between it is phonemized (the approach kokoro-js takes).
 */

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]'
const PUNCTUATION_RUN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g')

export type PhonemizeText = (text: string, language: string) => Promise<string[]>

/** Phonemes for `text` in the espeak voice `language` (`en-us`), with its punctuation kept. */
export async function phonemizeKeepingPunctuation(text: string, language = 'en-us', speak: PhonemizeText = phonemize): Promise<string> {
  const parts: Array<{ punctuation: boolean; text: string }> = []
  let from = 0
  for (const match of text.matchAll(PUNCTUATION_RUN)) {
    if (from < match.index) parts.push({ punctuation: false, text: text.slice(from, match.index) })
    parts.push({ punctuation: true, text: match[0] })
    from = match.index + match[0].length
  }
  if (from < text.length) parts.push({ punctuation: false, text: text.slice(from) })
  const phonemes = await Promise.all(parts.map(async (part) => (part.punctuation ? part.text : (await speak(part.text, language)).join(' '))))
  return phonemes.join('').trim()
}
