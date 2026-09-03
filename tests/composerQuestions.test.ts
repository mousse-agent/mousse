import { describe, expect, it } from 'vitest'
import {
  isQuestionAnswered,
  resolveQuestionAnswers
} from '../src/renderer/components/ComposerQuestionModal'
import type { UserQuestion } from '../src/shared/types'

const single: UserQuestion = {
  id: 'scope',
  prompt: 'Which area?',
  options: [
    { id: 'ui', label: 'UI' },
    { id: 'api', label: 'API' }
  ]
}

const multi: UserQuestion = {
  id: 'areas',
  prompt: 'Which areas?',
  allowMultiple: true,
  options: [
    { id: 'ui', label: 'UI' },
    { id: 'api', label: 'API' }
  ]
}

describe('ComposerQuestionModal helpers', () => {
  it('detects answered single-select via option or custom', () => {
    expect(isQuestionAnswered(single, 'ui', '')).toBe(true)
    expect(isQuestionAnswered(single, '', 'Something custom')).toBe(true)
    expect(isQuestionAnswered(single, '', '')).toBe(false)
    expect(isQuestionAnswered(single, undefined, undefined)).toBe(false)
  })

  it('detects answered multi-select via options or custom', () => {
    expect(isQuestionAnswered(multi, ['ui'], '')).toBe(true)
    expect(isQuestionAnswered(multi, [], 'Custom thing')).toBe(true)
    expect(isQuestionAnswered(multi, [], '')).toBe(false)
  })

  it('single-select prefers the custom answer', () => {
    expect(
      resolveQuestionAnswers([single], { scope: 'ui' }, { scope: '  Custom  ' })
    ).toEqual({ scope: 'Custom' })
    expect(resolveQuestionAnswers([single], { scope: 'ui' }, {})).toEqual({ scope: 'ui' })
  })

  it('multi-select combines options with the custom answer', () => {
    expect(
      resolveQuestionAnswers([multi], { areas: ['ui'] }, { areas: 'Edge case' })
    ).toEqual({ areas: ['ui', 'Edge case'] })
    expect(resolveQuestionAnswers([multi], { areas: [] }, { areas: '' })).toEqual({ areas: [] })
  })
})
