// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { chatStatusFromPhase, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const at = '2026-11-15T10:00:00.000Z'
const opus = { provider: 'claude-subscription', model: 'opus', name: 'Claude Opus 5.5' }
const sonnet = { provider: 'claude-subscription', model: 'sonnet', name: 'Claude Sonnet 5.5' }
const message = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, timestamp: at, ...extra })

/** A thread whose second turn carries `marker`, as the chat shows it. */
function show(content: string, marker: NonNullable<ChatMessage['contextHandoff']>) {
  const messages = [
    message('u1', 'user', 'First request'), message('a1', 'assistant', 'First answer'),
    message('u2', 'user', 'Second request'), message('m1', 'assistant', content, { kind: 'context_handoff', contextHandoff: marker }),
    message('a2', 'assistant', 'Second answer')
  ]
  act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase('idle') })))
  // The chat has other status regions (empty until something is announced): the markers are the ones that say something.
  const markers = [...host.querySelectorAll('[role="status"]')].filter((region) => region.textContent?.trim())
  return { markers, said: markers.map((marker) => marker.textContent?.replace(/\s+/g, ' ').trim()), text: host.textContent ?? '' }
}

describe('a reasoning change in the transcript', () => {
  it('is one line between the message and its answer, naming both levels', () => {
    const { markers, said, text } = show('Reasoning: Medium → High', { from: { ...opus, effort: 'medium' }, to: { ...opus, effort: 'high' } })
    expect(said).toEqual(['Reasoning:Medium→High'])
    expect(markers[0]!.getAttribute('aria-label')).toBe('Reasoning changed: Medium to High')
    const order = ['Second request', 'Reasoning:', 'Second answer'].map((part) => text.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBeGreaterThan(-1)
  })

  it('names the default level, and reads a level packed into an older message\'s model', () => {
    expect(show('', { from: opus, to: { ...opus, effort: 'xhigh' } }).said).toEqual(['Reasoning:Default→XHigh'])
    expect(show('', { from: { provider: opus.provider, model: 'opus:low' }, to: { ...opus, effort: 'off' } }).said).toEqual(['Reasoning:Low→Off'])
  })

  it('is part of the model line when the model changed too: one marker, each side with its level', () => {
    const { said } = show('Claude Opus 5.5 → Claude Sonnet 5.5', { from: { ...opus, effort: 'low' }, to: { ...sonnet, effort: 'high' } })
    expect(said).toEqual(['Model changedClaude Opus 5.5 · Low→Claude Sonnet 5.5 · High'])
  })

  it('says a switch that sent the chat over is a model change, with what was sent on hover', () => {
    const full = show('', { from: opus, to: sonnet, strategy: 'full_summary' }).markers[0]!
    expect(full.textContent).toMatch(/^Model changed/)
    expect(full.getAttribute('title')).toBe('Sent the new model the chat so far')
    expect(show('', { from: opus, to: sonnet, strategy: 'delta' }).markers[0]!.getAttribute('title')).toBe('Sent the new model the messages it missed')
    expect(show('', { from: opus, to: sonnet, strategy: 'native_resume' }).markers[0]!.hasAttribute('title')).toBe(false)
  })

  it('leaves a fork that kept the model as a fork', () => {
    const { said } = show('Forked from Draft', { from: opus, to: { ...opus, effort: 'high' }, transfer: 'fork' })
    expect(said).toEqual(['Forked from DraftClaude Opus 5.5 · High'])
  })
})
