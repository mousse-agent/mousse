import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ComposerQuestionModal,
  QuestionOptionList,
  isQuestionAnswered,
  questionDialogTitle,
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

describe('QuestionOptionList selection state', () => {
  const render = (value: string | string[] | undefined, allowMultiple?: boolean) =>
    renderToStaticMarkup(createElement(QuestionOptionList, {
      options: [...single.options, { id: 'db', label: 'Database' }],
      value,
      allowMultiple,
      onToggle: () => undefined
    }))
  const pressed = (html: string) => [...html.matchAll(/class="composer-question-option( selected)?" aria-pressed="(true|false)"[^>]*><span[^>]*>([^<]+)/g)]
    .filter((m) => m[2] === 'true').map((m) => m[3])

  it('marks only the chosen single-select option as selected', () => {
    const html = render('api')
    expect(pressed(html)).toEqual(['API'])
    expect(html.match(/ selected"/g)).toHaveLength(1)
  })

  it('marks every chosen multi-select option and nothing when empty', () => {
    expect(pressed(render(['ui', 'db'], true))).toEqual(['UI', 'Database'])
    expect(pressed(render([], true))).toEqual([])
    expect(pressed(render(''))).toEqual([])
  })
})

describe('ComposerQuestionModal', () => {
  const render = (questions: UserQuestion[]) =>
    renderToStaticMarkup(createElement(ComposerQuestionModal, {
      pending: { requestId: 'r1', questions },
      onSubmit: () => undefined,
      onDismiss: () => undefined
    }))

  it('titles the dialog in words', () => {
    expect(questionDialogTitle(0, 1)).toBe('Question')
    expect(questionDialogTitle(1, 3)).toBe('Questions · 2 of 3')
    const html = render([single])
    expect(html).toContain('aria-label="Question"')
    expect(html).not.toContain('Q:')
    expect(render([single, multi])).toContain('Questions · 1 of 2')
  })

  it('shows no Back with one question and dims Submit until it has an answer', () => {
    const html = render([single])
    expect(html).not.toContain('>Back<')
    expect(html).toMatch(/<button type="button" class="composer-question-submit" disabled="">Submit<\/button>/)
    expect(html).toContain('title="Skip question"')
  })

  it('keeps Back and Next with several questions', () => {
    const html = render([single, multi])
    expect(html).toContain('>Back<')
    expect(html).toMatch(/<button type="button" class="composer-question-submit">Next<\/button>/)
    expect(html).toContain('title="Skip questions"')
  })
})
