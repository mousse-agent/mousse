// @vitest-environment jsdom
/**
 * A component that throws while the window draws used to empty React's root and leave the window blank, with no
 * trace. Now the window shows one line with Reload, and the error goes to main's log with its stack and the
 * components that were drawing. Mounted through `createAppRoot` and `RootErrorBoundary`, as `main.tsx` mounts the app.
 */
import { act, createElement as h, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRoot, RootErrorBoundary } from '../../src/renderer/lib/appRoot'
import { installWindowErrorReporting, resetRendererErrorReportsForTests } from '../../src/renderer/services/rendererErrors'
import type { RendererErrorReport } from '../../src/shared/diagnostics/rendererError'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let reportError: ReturnType<typeof vi.fn<(report: RendererErrorReport) => void>>
let showBroken: () => void

function BrokenView(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'title')")
}

/** Starts on a working view; `showBroken` switches to one that throws, as switching views did. */
function Views() {
  const [broken, setBroken] = useState(false)
  showBroken = () => setBroken(true)
  return broken ? h(BrokenView) : h('p', null, 'Chat')
}

beforeEach(() => {
  resetRendererErrorReportsForTests()
  reportError = vi.fn()
  ;(window as unknown as { mousse: unknown }).mousse = { diagnostics: { reportError } }
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createAppRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('a component that throws while drawing', () => {
  it('shows one line with Reload instead of a blank window, and logs the error with both stacks', () => {
    act(() => root.render(h(RootErrorBoundary, null, h(Views))))
    expect(container.textContent).toContain('Chat')

    act(() => showBroken())

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.querySelector('button')?.textContent).toBe('Reload')
    expect(alert!.querySelector('details')?.textContent).toContain("reading 'title'")

    expect(reportError).toHaveBeenCalledTimes(1)
    const report = reportError.mock.calls[0][0]
    expect(report).toMatchObject({ kind: 'render', name: 'TypeError', message: "Cannot read properties of undefined (reading 'title')" })
    expect(report.stack).toContain('BrokenView')
    expect(report.componentStack).toContain('BrokenView')
    expect(report.componentStack).toContain('Views')
  })

  it('Reload does not reload while an editor has unsaved edits, and says so', async () => {
    const keepEdits = (event: Event) => event.preventDefault()
    window.addEventListener('beforeunload', keepEdits)
    try {
      act(() => root.render(h(RootErrorBoundary, null, h(BrokenView))))
      await act(async () => { container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click() })
      expect(container.textContent).toContain('Save or close unsaved files first.')
    } finally {
      window.removeEventListener('beforeunload', keepEdits)
    }
  })
})

describe('errors outside React', () => {
  it('logs uncaught errors and unhandled rejections, and an error thrown in a loop as one line with a count', () => {
    const stop = installWindowErrorReporting()
    try {
      const thrown = new Error('frame callback failed')
      for (let i = 0; i < 3; i += 1) {
        window.dispatchEvent(new ErrorEvent('error', { error: thrown, message: thrown.message, filename: 'app://index.js', lineno: 4, colno: 9 }))
      }
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('read timed out') }))

      expect(reportError.mock.calls.map(([report]) => [report.kind, report.message])).toEqual([
        ['error', 'frame callback failed'],
        ['rejection', 'read timed out']
      ])
      expect(reportError.mock.calls[0][0]).toMatchObject({ source: 'app://index.js:4:9' })
      expect(reportError.mock.calls[0][0].stack).toContain('frame callback failed')

      // Past the repeat window the same error is sent again, with how many copies were held back.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
      window.dispatchEvent(new ErrorEvent('error', { error: thrown, message: thrown.message }))
      expect(reportError.mock.calls.at(-1)![0]).toMatchObject({ kind: 'error', repeats: 2 })
    } finally {
      stop()
    }
  })
})
