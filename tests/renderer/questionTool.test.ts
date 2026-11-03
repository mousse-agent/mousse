// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuestionTool, type QuestionToolPart } from '../../src/renderer/chat/components/agent-elements/question/question-tool'
import type { QuestionConfig } from '../../src/renderer/chat/components/agent-elements/question/question-prompt'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const part = (questions: QuestionConfig[]): QuestionToolPart => ({
  type: 'tool-AskUserQuestion',
  toolCallId: 'q1',
  state: 'input-streaming',
  input: { questions }
})

describe('QuestionTool', () => {
  it('shows the question when it arrives after the first render', () => {
    // A streaming tool call renders before its questions arrive.
    act(() => root.render(createElement(QuestionTool, { part: part([]) })))
    expect(host.textContent).toBe('')

    act(() => root.render(createElement(QuestionTool, { part: part([{ kind: 'text', title: 'Which branch?' }]) })))
    expect(host.textContent).toContain('Which branch?')
  })
})
