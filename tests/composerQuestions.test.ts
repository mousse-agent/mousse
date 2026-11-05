// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_ADVANCE_MS,
  ComposerQuestionModal,
  QuestionOptionList,
  isQuestionAnswered,
  nextUnansweredStep,
  questionDialogLabel,
  resolveQuestionAnswers
} from '../src/renderer/components/ComposerQuestionModal'
import type { UserQuestion, UserQuestionAnswers } from '../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    { id: 'api', label: 'API' },
    { id: 'db', label: 'Database' }
  ]
}

const third: UserQuestion = {
  id: 'size',
  prompt: 'How big?',
  options: [
    { id: 's', label: 'Small' },
    { id: 'l', label: 'Large' }
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

  it('labels the dialog in words, without a position', () => {
    expect(questionDialogLabel(1)).toBe('Question')
    expect(questionDialogLabel(3)).toBe('3 questions')
  })

  it('moves on to the next unanswered question, wrapping, else the last one', () => {
    expect(nextUnansweredStep([true, false, false], 0)).toBe(1)
    expect(nextUnansweredStep([false, true, true], 1)).toBe(0)
    expect(nextUnansweredStep([true, true, false], 0)).toBe(2)
    expect(nextUnansweredStep([true, true, true], 0)).toBe(2)
  })
})

describe('QuestionOptionList selection state', () => {
  const render = (value: string | string[] | undefined, allowMultiple?: boolean) =>
    renderToStaticMarkup(createElement(QuestionOptionList, {
      options: multi.options,
      value,
      allowMultiple,
      onToggle: () => undefined
    }))
  const checked = (html: string) => [...html.matchAll(/aria-checked="true"[^>]*>.*?composer-question-option-label">([^<]+)/g)].map((m) => m[1])

  it('single choice is a radio group with only the chosen row selected', () => {
    const html = render('api')
    expect(html).toContain('role="radiogroup"')
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(checked(html)).toEqual(['API'])
    expect(html.match(/ selected"/g)).toHaveLength(1)
  })

  it('several choices are checkboxes; every chosen row is selected', () => {
    const html = render(['ui', 'db'], true)
    expect(html).toContain('role="group"')
    expect(html.match(/role="checkbox"/g)).toHaveLength(3)
    expect(checked(html)).toEqual(['UI', 'Database'])
    expect(checked(render([], true))).toEqual([])
    expect(checked(render(''))).toEqual([])
  })

  it('is one Tab stop: the selected row, else the first', () => {
    const tabStops = (html: string) => [...html.matchAll(/tabindex="0"[^>]*>.*?composer-question-option-label">([^<]+)/g)].map((m) => m[1])
    expect(tabStops(render('api'))).toEqual(['API'])
    expect(tabStops(render(''))).toEqual(['UI'])
  })
})

describe('ComposerQuestionModal', () => {
  let root: Root
  let host: HTMLElement
  let submitted: UserQuestionAnswers[]
  let dismissed: number

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    submitted = []
    dismissed = 0
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const open = (questions: UserQuestion[]) => {
    act(() => root.render(createElement(ComposerQuestionModal, {
      pending: { requestId: 'r1', questions },
      onSubmit: (answers) => submitted.push(answers),
      onDismiss: () => { dismissed += 1 }
    })))
  }
  const prompts = () => [...host.querySelectorAll('.composer-question-prompt')].map((node) => node.textContent)
  const footer = () => [...host.querySelectorAll<HTMLButtonElement>('.composer-question-modal-footer button')]
    .map((button) => button.textContent + (button.disabled ? ' (disabled)' : ''))
  const option = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.composer-question-option')]
    .find((button) => button.textContent === label)!
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label)!
  const dots = () => [...host.querySelectorAll<HTMLButtonElement>('.composer-question-dot')]
  const click = (element: HTMLElement) => act(() => element.click())
  const key = (element: Element, name: string) =>
    act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })

  it('shows one question at a time under a word label, with no position text and no close button', () => {
    open([single, multi])
    expect(prompts()).toEqual(['Which area?'])
    expect(host.querySelector('.composer-question-modal-title')?.textContent).toBe('2 questions')
    expect(host.textContent).not.toMatch(/of 2|Q:/)
    expect(dots()).toHaveLength(2)
    expect(host.querySelector('[aria-label="Close"], .modal-close')).toBeNull()
    // First question: no Back; single choice needs no Next.
    expect(footer()).toEqual(['Skip'])
  })

  it('a single question has no dots and waits for an answer before Submit', () => {
    open([single])
    expect(host.querySelector('.composer-question-modal-title')?.textContent).toBe('Question')
    expect(dots()).toHaveLength(0)
    expect(footer()).toEqual(['Skip', 'Submit (disabled)'])
    click(option('API'))
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['Which area?'])
    expect(footer()).toEqual(['Skip', 'Submit'])
    click(button('Submit'))
    expect(submitted).toEqual([{ scope: 'api' }])
  })

  it('picking a single choice moves on to the next question by itself and fills its dot', () => {
    open([single, multi])
    click(option('UI'))
    expect(prompts()).toEqual(['Which area?'])
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['Which areas?'])
    expect(host.querySelector('.composer-question-slide')?.className).toContain('from-next')
    expect(dots().map((dot) => dot.className.includes('is-answered'))).toEqual([true, false])
    expect(dots()[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('does not move on from the last question, and skips questions already answered', () => {
    open([single, multi, third])
    click(dots()[2]!)
    click(option('Large'))
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['How big?'])
    click(dots()[0]!)
    expect(prompts()).toEqual(['Which area?'])
    expect(host.querySelector('.composer-question-slide')?.className).toContain('from-previous')
    click(option('API'))
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['Which areas?'])
  })

  it('dots jump to any question', () => {
    open([single, multi, third])
    click(dots()[2]!)
    expect(prompts()).toEqual(['How big?'])
    expect(footer()).toEqual(['Skip', 'Back', 'Submit (disabled)'])
    click(dots()[1]!)
    expect(prompts()).toEqual(['Which areas?'])
  })

  it('Submit stays disabled with "Answer all to submit" until every question is answered', () => {
    open([single, multi])
    click(dots()[1]!)
    click(option('UI'))
    click(option('Database'))
    expect(footer()).toEqual(['Skip', 'Back', 'Submit (disabled)'])
    expect(host.querySelector('.composer-question-hint')?.textContent).toBe('Answer all to submit')
    click(button('Back'))
    click(option('API'))
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['Which areas?'])
    expect(host.querySelector('.composer-question-hint')).toBeNull()
    expect(footer()).toEqual(['Skip', 'Back', 'Submit'])
    click(button('Submit'))
    expect(submitted).toEqual([{ scope: 'api', areas: ['ui', 'db'] }])
  })

  it('several choices or a typed answer show Next instead of moving on', () => {
    open([multi, single])
    expect(footer()).toEqual(['Skip'])
    click(option('API'))
    act(() => vi.advanceTimersByTime(AUTO_ADVANCE_MS))
    expect(prompts()).toEqual(['Which areas?'])
    expect(footer()).toEqual(['Skip', 'Next'])
    click(button('Next'))
    expect(prompts()).toEqual(['Which area?'])
    click(option('Other…'))
    const input = host.querySelector<HTMLInputElement>('.composer-question-other-input')!
    expect(document.activeElement).toBe(input)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Docs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(input, 'Enter')
    expect(submitted).toEqual([{ areas: ['api'], scope: 'Docs' }])
  })

  it('picking an option closes "Other" for a single choice', () => {
    open([single])
    click(option('Other…'))
    expect(host.querySelector('.composer-question-other-input')).not.toBeNull()
    click(option('UI'))
    expect(host.querySelector('.composer-question-other-input')).toBeNull()
    expect(option('UI').getAttribute('aria-checked')).toBe('true')
  })

  it('arrow keys move between the rows, wrapping around', () => {
    open([single, multi])
    const first = option('UI')
    act(() => first.focus())
    key(first, 'ArrowDown')
    expect(document.activeElement).toBe(option('API'))
    key(option('API'), 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Other…')
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(option('UI'))
    key(option('UI'), 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('Other…')
  })

  it('Escape skips', () => {
    open([single, multi])
    key(option('UI'), 'Escape')
    expect(dismissed).toBe(1)
    click(button('Skip'))
    expect(dismissed).toBe(2)
    expect(submitted).toEqual([])
  })
})
