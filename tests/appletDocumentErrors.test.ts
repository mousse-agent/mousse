import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { APPLET_EVENT_PREFIX, appletDocument } from '../src/shared/appletDocument'

// Runs the applet page's own script and collects the errors it reports to the host card.
function reportedErrors(fire: (window: Window) => void): string[] {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('log', (line: unknown) => {
    if (typeof line !== 'string' || !line.startsWith(APPLET_EVENT_PREFIX)) return
    const event = JSON.parse(line.slice(APPLET_EVENT_PREFIX.length)) as { type: string; payload: unknown }
    if (event.type === 'error') errors.push(String(event.payload))
  })
  const dom = new JSDOM(
    appletDocument({ schemaVersion: 1, title: 'Test', description: 'Test', html: '<p>hi</p>', css: '', js: '' } as never),
    { runScripts: 'dangerously', virtualConsole }
  )
  try {
    fire(dom.window as unknown as Window)
  } finally {
    dom.window.close()
  }
  return errors
}

describe('applet runtime errors', () => {
  it('does not report the browser ResizeObserver loop notice, but still reports real errors', () => {
    const errors = reportedErrors((window) => {
      const fire = (message: string) =>
        window.dispatchEvent(new (window as unknown as typeof globalThis).ErrorEvent('error', { message, cancelable: true }))
      fire('ResizeObserver loop completed with undelivered notifications.')
      fire('ResizeObserver loop limit exceeded')
      fire('Uncaught TypeError: lamp is undefined')
    })
    expect(errors).toEqual(['Uncaught TypeError: lamp is undefined'])
  })
})
