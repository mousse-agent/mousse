// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import type { SkillDescriptor } from '../../src/shared/integrations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: () => ({ isRecording: false, recordingPending: false, transcribing: false, recordingDuration: 0, levels: null, error: undefined, dismissError: () => {}, notice: null, start: () => {}, stop: () => {} })
}))

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const skill = (id: string, extra: Partial<SkillDescriptor> = {}): SkillDescriptor => ({
  id,
  name: id,
  description: `${id} skill`,
  rootPath: `/skills/${id}`,
  skillPath: `/skills/${id}/SKILL.md`,
  scope: 'project',
  source: 'mousse-project',
  ...extra
})

const SKILLS = [skill('review'), skill('test-writer', { scope: 'global', source: 'claude-global', managed: false })]

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  Element.prototype.scrollIntoView ??= () => {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render() {
  const onSend = vi.fn()
  function Harness() {
    const [input, setInput] = useState('')
    const props: ChatComposerProps = {
      input,
      onInputChange: setInput,
      attachedFiles: [],
      onAttachedFilesChange: () => {},
      voiceMessages: [],
      onVoiceMessagesChange: () => {},
      enabledSkills: SKILLS,
      onSend
    }
    return createElement(ChatComposer, props)
  }
  act(() => root.render(createElement(Harness)))
  return { onSend }
}

const box = () => host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const list = () => host.querySelector<HTMLElement>('#composer-command-suggestions')
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.textContent)

function type(value: string) {
  const node = box()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
    node.setSelectionRange(value.length, value.length)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (key: string) => {
  act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

describe('/ for skills in the composer', () => {
  it('offers skills only mid-message, and a pick sends the skill, not a slash command', () => {
    const { onSend } = render()
    type('fix this /rev')
    expect(list()?.getAttribute('aria-label')).toBe('Skill suggestions')
    expect(options()).toEqual(['reviewreview skill'])
    expect(list()?.textContent).toContain('Skills only mid-message')
    expect(host.querySelector('[role="option"] [role="img"]')?.getAttribute('aria-label')).toBe('Project')

    press('Enter')
    expect(box().value).toBe('fix this @review ')
    expect(list()).toBeNull()

    type('fix this @review please')
    press('Enter')
    expect(onSend).toHaveBeenCalledWith({ type: 'skill', skillId: 'review' })
  })

  it('lists commands and skills at the start; a picked skill leaves the same @ token', () => {
    render()
    type('/te')
    expect(list()?.getAttribute('aria-label')).toBe('Slash command suggestions')
    expect(options()).toEqual(['/steer <prompt>Inject guidance mid-turn (after the next tool call)', 'test-writertest-writer skill'])
    const icons = [...host.querySelectorAll('[role="option"] [role="img"]')].map((icon) => icon.getAttribute('aria-label'))
    expect(icons).toEqual(['Command', 'Claude Code · personal'])
    type('/re')
    expect(options()).toEqual(['/rename <title>Rename this thread', 'reviewreview skill'])
    press('ArrowDown')
    press('Enter')
    expect(box().value).toBe('@review ')
  })

  it('stays closed in a path or with no matching skill, so Enter sends the text as typed', () => {
    const { onSend } = render()
    type('open src/rev')
    expect(list()).toBeNull()
    type('fix this /zzz')
    expect(list()).toBeNull()
    press('Enter')
    expect(onSend).toHaveBeenCalledWith(undefined)
  })
})
