import { localModelBytes, type LocalModelManifest } from '../../shared/localModels'

/**
 * What the speech model dialog compares: the figure rows of each feature and the rules that pick
 * its three columns. Rows and picks only read `compare` figures, so a model without a figure shows
 * a dash, and a row none of the columns has drops out.
 */

/** One figure row: a label on the left of the comparison, a phrase in a list row's stats line. */
export interface ModelMetric<M extends LocalModelManifest> {
  label: string
  /** Where the figure comes from, shown as the label's tooltip. */
  hint?: string
  value: (model: M) => number | undefined
  best: 'low' | 'high'
  /** Text in the comparison cell. */
  cell: (value: number, model: M) => string
  /** Text in a list row's stats line; empty leaves it out. */
  stat: (value: number, model: M) => string
}

/** Picks one column among the models no earlier rule took; undefined skips the rule. */
export interface ModelPickRule<M extends LocalModelManifest> {
  tag: string
  choose: <T extends M>(candidates: readonly T[]) => T | undefined
}

export interface ModelComparison<M extends LocalModelManifest> {
  metrics: ReadonlyArray<ModelMetric<M>>
  /** Applied in order until three columns are picked. The first is shown as recommended. */
  picks: ReadonlyArray<ModelPickRule<M>>
}

export interface ModelPick<M extends LocalModelManifest> {
  model: M
  tag: string
}

export const COMPARED_MODELS = 3

export function pickModels<M extends LocalModelManifest>(models: readonly M[], picks: ModelComparison<M>['picks']): ModelPick<M>[] {
  const out: ModelPick<M>[] = []
  for (const rule of picks) {
    if (out.length >= COMPARED_MODELS) break
    const model = rule.choose(models.filter((candidate) => !out.some((pick) => pick.model.id === candidate.id)))
    if (model) out.push({ model, tag: rule.tag })
  }
  return out
}

export const pickId =
  (id: string) =>
  <T extends LocalModelManifest>(candidates: readonly T[]): T | undefined =>
    candidates.find((model) => model.id === id)

/** The model with the best value of `metric`; the first in catalogue order on a tie. */
export const pickBest =
  <M extends LocalModelManifest>(metric: Pick<ModelMetric<M>, 'value' | 'best'>) =>
  <T extends M>(candidates: readonly T[]): T | undefined => {
    let best: { model: T; value: number } | undefined
    for (const model of candidates) {
      const value = metric.value(model)
      if (value === undefined) continue
      if (!best || (metric.best === 'low' ? value < best.value : value > best.value)) best = { model, value }
    }
    return best?.model
  }

/**
 * Whether `value` is the best of `values` and worth marking: at least two models have the figure
 * and they differ.
 */
export function isBestValue(value: number | undefined, values: ReadonlyArray<number | undefined>, best: 'low' | 'high'): boolean {
  const known = values.filter((item): item is number => item !== undefined)
  if (value === undefined || known.length < 2 || known.every((item) => item === known[0])) return false
  return value === (best === 'low' ? Math.min(...known) : Math.max(...known))
}

// ---------------------------------------------------------------------------------------------
// Figures shared by dictation and read aloud
// ---------------------------------------------------------------------------------------------

export const languagesMetric: ModelMetric<LocalModelManifest> = {
  label: 'Languages',
  value: (model) => model.compare?.languages?.count,
  best: 'high',
  cell: (count, model) => (count === 1 && model.compare?.languages?.name) || String(count),
  stat: (count, model) => (count === 1 && model.compare?.languages?.name) || `${count} languages`
}

export const smallestDownload = pickBest({ value: localModelBytes, best: 'low' })

// ---------------------------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------------------------

/**
 * Shown wait in seconds for a measured `stopWaitMs`: 0 is "No wait", 0.5 "Under 1 s", otherwise
 * whole seconds. Rounded to what is shown, so two models that read the same compare as equal.
 * The figures come from a fast desktop CPU, so "No wait" stops at 150 ms: a computer a third as
 * fast still writes the text well within half a second.
 */
export function stopWaitSeconds(ms: number): number {
  if (ms < 150) return 0
  if (ms < 1000) return 0.5
  return Math.round(ms / 1000)
}

const stopWaitText = (seconds: number): string => (seconds === 0 ? 'No wait' : seconds < 1 ? 'Under 1 s' : `${seconds} s`)

/**
 * Local dictation models transcribe while you speak (`liveTranscription.ts`), so stopping waits for
 * the words after the last pause; how long that takes is measured per model (`compare.stopWaitMs`).
 */
export const stopWaitMetric: ModelMetric<LocalModelManifest> = {
  label: 'Wait when you stop',
  hint: 'Text is written while you speak; this is the time left for the words after your last pause',
  value: (model) => (model.compare?.stopWaitMs === undefined ? undefined : stopWaitSeconds(model.compare.stopWaitMs)),
  best: 'low',
  cell: stopWaitText,
  stat: (seconds) => (seconds === 0 ? 'No wait' : `${stopWaitText(seconds)} wait`)
}

/** "1 in N" words wrong, N = 100 / word error rate. */
export const wordsPerError = (wer: number): number => Math.round(100 / wer)

export const wrongWordsMetric: ModelMetric<LocalModelManifest> = {
  label: 'Wrong words',
  hint: 'English, averaged over the Open ASR Leaderboard test sets',
  value: (model) => model.compare?.englishWer,
  best: 'low',
  cell: (wer) => `1 in ${wordsPerError(wer)}`,
  stat: (wer) => `1 in ${wordsPerError(wer)} words wrong`
}

export function dictationComparison(recommendedId: string): ModelComparison<LocalModelManifest> {
  return {
    metrics: [stopWaitMetric, wrongWordsMetric, languagesMetric],
    picks: [
      { tag: 'Recommended', choose: pickId(recommendedId) },
      { tag: 'Fewest wrong words', choose: pickBest(wrongWordsMetric) },
      { tag: 'Most languages', choose: pickBest(languagesMetric) },
      { tag: 'Smallest download', choose: smallestDownload }
    ]
  }
}

// ---------------------------------------------------------------------------------------------
// Read aloud
// ---------------------------------------------------------------------------------------------

/** A text-to-speech model, which lists its voices. */
export type VoicedModel = LocalModelManifest & { voices: readonly unknown[] }

export const voicesMetric: ModelMetric<VoicedModel> = {
  label: 'Voices',
  value: (model) => model.voices.length,
  best: 'high',
  cell: (count) => String(count),
  stat: (count) => (count === 1 ? '1 voice' : `${count} voices`)
}

export function readAloudComparison(recommendedId: string): ModelComparison<VoicedModel> {
  return {
    metrics: [languagesMetric, voicesMetric],
    picks: [
      { tag: 'Recommended', choose: pickId(recommendedId) },
      { tag: 'Most languages', choose: pickBest(languagesMetric) },
      { tag: 'Smallest download', choose: smallestDownload }
    ]
  }
}
