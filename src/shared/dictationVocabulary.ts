/**
 * The user's dictation vocabulary: names local dictation should write when it hears them. Each
 * term may list spellings the model tends to write instead ("sounds like"). The list is per profile
 * (Settings, Speech); Parakeet models rescore words that look or sound like a term on the same
 * audio and write the term only when it fits (`src/renderer/dictation/vocabularyRescoring.ts`).
 */
export interface DictationVocabularyTerm {
  term: string
  /** Spellings the model may write for the term, such as "moose" for "Mousse". */
  soundsLike: string[]
}

/** Most terms a list keeps. */
export const MAX_VOCABULARY_TERMS = 500
/** Most terms a transcription uses; the first ones in the list. */
export const MAX_RESCORED_TERMS = 64
export const MAX_TERM_LENGTH = 64
export const MAX_SOUNDS_LIKE = 16

/** Cuts a term or spelling to one line of at most `MAX_TERM_LENGTH` characters. */
export function cleanVocabularyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH).trim()
}

/**
 * The usable list: blank terms dropped, terms unique ignoring case (the first one wins, gaining
 * the later ones' spellings), spellings unique and never the term itself, all within the limits.
 */
export function normalizeVocabulary(value: unknown): DictationVocabularyTerm[] {
  if (!Array.isArray(value)) return []
  const terms: DictationVocabularyTerm[] = []
  const byKey = new Map<string, DictationVocabularyTerm>()
  for (const item of value) {
    const record = typeof item === 'string' ? { term: item } : item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    if (!record || typeof record.term !== 'string') continue
    const term = cleanVocabularyText(record.term)
    if (!term) continue
    const spellings = Array.isArray(record.soundsLike) ? record.soundsLike.filter((entry): entry is string => typeof entry === 'string') : []
    let entry = byKey.get(term.toLowerCase())
    if (!entry) {
      if (terms.length >= MAX_VOCABULARY_TERMS) continue
      entry = { term, soundsLike: [] }
      byKey.set(term.toLowerCase(), entry)
      terms.push(entry)
    }
    for (const raw of spellings) {
      const spelling = cleanVocabularyText(raw)
      const key = spelling.toLowerCase()
      if (!spelling || key === entry.term.toLowerCase() || entry.soundsLike.some((known) => known.toLowerCase() === key)) continue
      if (entry.soundsLike.length < MAX_SOUNDS_LIKE) entry.soundsLike.push(spelling)
    }
  }
  return terms
}

/** "a, b, c" into spellings, for the Sounds like field. */
export function parseSoundsLike(text: string): string[] {
  return text
    .split(',')
    .map(cleanVocabularyText)
    .filter(Boolean)
}
