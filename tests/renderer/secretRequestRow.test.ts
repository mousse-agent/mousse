// @vitest-environment jsdom
// #595: the transcript row of a `secret_request` reads the secret's name from the tool's real result text, so a
// secret that was given shows as given, in the current wording and in threads saved with the one before.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretRequestRow } from '../../src/renderer/components/secrets/SecretRequestRow'
import { secretOutcomeText, type SecretRequestOutcome } from '../../src/mms/secrets/SecretRequests'

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

function show(output: unknown, status: string): string {
  act(() => root.render(createElement(SecretRequestRow, { input: { label: 'GitHub token' }, output, status } as never)))
  return host.querySelector('[data-testid="secret-request-row"]')?.textContent ?? ''
}

const OUTCOMES: Array<[string, SecretRequestOutcome]> = [
  ['stored with a file', { kind: 'stored', name: 'GITHUB_TOKEN', keep: 'day', file: '/home/me/.mousse/secrets/threads/t1/GITHUB_TOKEN' }],
  ['stored without a file', { kind: 'stored', name: 'GITHUB_TOKEN', keep: 'thread' }],
  ['a saved one reused', { kind: 'saved_reused', name: 'GITHUB_TOKEN', file: '/f' }]
]

describe('a secret request in the transcript', () => {
  it.each(OUTCOMES)('shows a secret %s as given, under its name', (_what, outcome) => {
    expect(show(secretOutcomeText(outcome).text, 'success')).toContain('Given. Kept out of the chat as GITHUB_TOKEN.')
  })

  it('reads a result saved in the earlier wording, and as content parts', () => {
    const earlier = 'The user gave the secret. It is kept by Mousse as GITHUB_TOKEN (for 24 hours); you never see its value.'
    expect(show(earlier, 'success')).toContain('as GITHUB_TOKEN.')
    expect(show([{ type: 'text', text: secretOutcomeText(OUTCOMES[0][1]).text }], 'success')).toContain('as GITHUB_TOKEN.')
  })

  it('shows a declined request as not given', () => {
    expect(show(secretOutcomeText({ kind: 'declined' }).text, 'error')).toContain('Not given.')
  })
})
