import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { KOKORO_82M } from '../../src/shared/readAloud'
import { SpeechSettings } from '../../src/renderer/speech/SpeechSettings'
import { useReadAloudStore, type ReadAloudStatus } from '../../src/renderer/readAloud/readAloudStore'

// Server rendering reads a store's initial state, so the seed goes there.
const initial = { ...useReadAloudStore.getInitialState() }
afterEach(() => {
  Object.assign(useReadAloudStore.getInitialState(), initial)
})

const sampleButton = (status: ReadAloudStatus) => {
  Object.assign(useReadAloudStore.getInitialState(), {
    selection: { source: 'local', modelId: KOKORO_82M.id },
    activeKey: status === 'idle' ? null : 'speech-settings-preview',
    status
  })
  const html = renderToStaticMarkup(createElement(SpeechSettings))
  const button = html.match(/<button[^>]*aria-label="(?:Play|Stop) sample"[^>]*>.*?<\/button>/)?.[0]
  expect(button).toBeDefined()
  return button!
}

describe('Speech settings sample button', () => {
  it('offers to play the sample when nothing is playing', () => {
    const button = sampleButton('idle')
    expect(button).toContain('aria-label="Play sample"')
    expect(button).not.toContain('aria-busy')
  })

  it('shows a spinner while the voice loads, and still stops on click', () => {
    const button = sampleButton('loading')
    expect(button).toContain('aria-label="Stop sample"')
    expect(button).toContain('aria-busy="true"')
    expect(button).toContain('title="Loading voice, click to stop"')
    expect(button).toContain('icon-spin')
  })

  it('shows stop once the sample is audible', () => {
    const button = sampleButton('playing')
    expect(button).toContain('title="Stop sample"')
    expect(button).not.toContain('aria-busy')
    expect(button).not.toContain('icon-spin')
  })
})
