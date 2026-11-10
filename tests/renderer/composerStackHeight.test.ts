// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_STACK_VAR,
  watchComposerStackHeight
} from '../../src/renderer/chat/components/agent-elements/composer-stack-height'

let resizeCallbacks: Array<() => void> = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    resizeCallbacks.push(this.callback)
  }
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback)
  }
}
const resize = () => resizeCallbacks.forEach((callback) => callback())
const mutations = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A CSS height transition on the composer input, 200ms long, now at `currentTime`. */
function heightTransition(currentTime: number) {
  return {
    transitionProperty: 'height',
    currentTime,
    effect: { getComputedTiming: () => ({ endTime: 200 }) }
  }
}

let shell: HTMLElement
let stack: HTMLElement
let jump: HTMLElement
let height: number
let transitions: ReturnType<typeof heightTransition>[]
let writes: string[]
let stop: () => void

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  shell = document.createElement('div')
  shell.className = 'mousse-chat-shell'
  stack = document.createElement('div')
  jump = document.createElement('button')
  jump.className = 'chat-jump'
  shell.append(jump, stack)
  document.body.append(shell)
  height = 120
  transitions = []
  // Mid-transition the stack is between sizes; seeked to the end it reports the settled size.
  Object.defineProperty(stack, 'offsetHeight', {
    get: () => (transitions.some((t) => t.currentTime < 200) ? 105 : height)
  })
  ;(stack as unknown as { getAnimations: () => unknown[] }).getAnimations = () => transitions
  jump.animate = vi.fn(() => ({ cancel: vi.fn(), effect: null, onfinish: null })) as unknown as HTMLElement['animate']
  writes = []
  const setProperty = shell.style.setProperty.bind(shell.style)
  shell.style.setProperty = (name: string, value: string | null) => {
    if (name === COMPOSER_STACK_VAR) writes.push(String(value))
    setProperty(name, value)
  }
  stop = watchComposerStackHeight(stack, shell)
})

afterEach(() => {
  stop()
  shell.remove()
  vi.unstubAllGlobals()
})

describe('watchComposerStackHeight', () => {
  it('publishes the stack height and follows its size', () => {
    expect(shell.style.getPropertyValue(COMPOSER_STACK_VAR)).toBe('120px')
    height = 150
    resize()
    expect(shell.style.getPropertyValue(COMPOSER_STACK_VAR)).toBe('150px')
  })

  it('writes the folded height once when a fold starts, not on every frame', async () => {
    writes = []
    height = 90
    transitions = [heightTransition(0)]
    shell.setAttribute('data-composer-compact', 'true')
    shell.setAttribute('data-composer-motion', 'true')
    await mutations()
    expect(writes).toEqual(['90px'])
    // The transition was seeked to its end to measure, then put back.
    expect(transitions[0].currentTime).toBe(0)

    // Each frame of the fold resizes the stack; the transcript is left alone.
    for (const time of [40, 80, 120, 160]) {
      transitions[0].currentTime = time
      resize()
    }
    expect(writes).toEqual(['90px'])

    transitions = []
    shell.removeAttribute('data-composer-motion')
    await mutations()
    resize()
    expect(writes).toEqual(['90px'])
    expect(shell.style.getPropertyValue(COMPOSER_STACK_VAR)).toBe('90px')
  })

  it('moves Go to latest with a transform only, from where it was', async () => {
    height = 90
    transitions = [heightTransition(0)]
    shell.setAttribute('data-composer-compact', 'true')
    shell.setAttribute('data-composer-motion', 'true')
    await mutations()
    expect(jump.animate).toHaveBeenCalledTimes(1)
    const [keyframes, timing] = vi.mocked(jump.animate).mock.calls[0] as [Keyframe[], KeyframeAnimationOptions]
    expect(keyframes).toEqual([{ transform: 'translateY(-30px)' }, { transform: 'translateY(0)' }])
    expect(keyframes.flatMap((frame) => Object.keys(frame))).toEqual(['transform', 'transform'])
    expect(timing).toMatchObject({ duration: 200, easing: 'ease-out', composite: 'add' })
  })

  it('re-measures when a fold is reversed before the last one finished', async () => {
    height = 90
    transitions = [heightTransition(0)]
    shell.setAttribute('data-composer-compact', 'true')
    shell.setAttribute('data-composer-motion', 'true')
    await mutations()
    height = 120
    transitions = [heightTransition(60)]
    shell.removeAttribute('data-composer-compact')
    await mutations()
    expect(writes.slice(-2)).toEqual(['90px', '120px'])
  })
})
