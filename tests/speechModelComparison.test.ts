import { expect, it } from 'vitest'
import type { LocalModelManifest } from '../src/shared/localModels'
import { isBestValue, pickBest, pickId, pickModels, stopWaitMetric, stopWaitSeconds, wordsPerError } from '../src/renderer/speechModels/modelComparison'

const model = (id: string, englishWer?: number, languages?: number): LocalModelManifest => ({
  id,
  label: id,
  description: '',
  parameters: '',
  license: '',
  homepage: '',
  repo: '',
  revision: '',
  files: [{ path: 'model.onnx', size: id.length, sha256: '' }],
  compare: { englishWer, languages: languages === undefined ? undefined : { count: languages } }
})

const wer = { value: (item: LocalModelManifest) => item.compare?.englishWer, best: 'low' as const }
const languages = { value: (item: LocalModelManifest) => item.compare?.languages?.count, best: 'high' as const }

it('picks each column from the models no earlier rule took', () => {
  const models = [model('a', 8, 1), model('b', 6, 1), model('c', undefined, 99), model('d', 12, 1)]
  const picks = pickModels(models, [
    { tag: 'Recommended', choose: pickId('b') },
    { tag: 'Fewest wrong words', choose: pickBest(wer) },
    { tag: 'Most languages', choose: pickBest(languages) },
    { tag: 'Extra', choose: pickId('d') }
  ])
  // b has the fewest wrong words but is already recommended, so a is next; three columns at most.
  expect(picks.map((pick) => [pick.tag, pick.model.id])).toEqual([
    ['Recommended', 'b'],
    ['Fewest wrong words', 'a'],
    ['Most languages', 'c']
  ])
})

it('skips a rule with no candidate and lets the next one fill the column', () => {
  const picks = pickModels([model('a'), model('bb')], [
    { tag: 'Recommended', choose: pickId('missing') },
    { tag: 'Fewest wrong words', choose: pickBest(wer) },
    { tag: 'Smallest download', choose: pickBest({ value: (item: LocalModelManifest) => item.files[0].size, best: 'low' }) }
  ])
  expect(picks.map((pick) => pick.model.id)).toEqual(['a'])
})

it('marks the best value only when two or more figures differ', () => {
  expect(isBestValue(6, [6, 8, undefined], 'low')).toBe(true)
  expect(isBestValue(8, [6, 8], 'low')).toBe(false)
  expect(isBestValue(99, [1, 99], 'high')).toBe(true)
  expect(isBestValue(6, [6, undefined, undefined], 'low')).toBe(false)
  expect(isBestValue(1, [1, 1, 1], 'high')).toBe(false)
})

it('reads a word error rate as "1 in N" words', () => {
  expect(wordsPerError(6.32)).toBe(16)
  expect(wordsPerError(12.65)).toBe(8)
})

it('rounds a measured wait to what the comparison shows', () => {
  expect([45, 149, 150, 999, 1000, 2980].map(stopWaitSeconds)).toEqual([0, 0, 0.5, 0.5, 1, 3])
  expect([0, 0.5, 3].map((seconds) => stopWaitMetric.cell(seconds, model('a')))).toEqual(['No wait', 'Under 1 s', '3 s'])
  expect(stopWaitMetric.stat(3, model('a'))).toBe('3 s wait')
  expect(stopWaitMetric.value(model('a'))).toBeUndefined()
})
