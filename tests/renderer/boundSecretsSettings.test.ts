// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { SecretsSettings } from '../../src/renderer/components/settings/SecretsSettings'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('lists a bound secret by service and removes it through the ordinary Settings action', async () => {
  const removed: string[] = []
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request: async (method: string, params: {name: string}) => {
    if (method === 'secrets.list') return { secrets: [{ name: 'KEY', keep: 'saved', binding: { service: 'OpenAI', host: 'api.openai.com', readOnly: true } }] }
    if (method === 'secrets.delete') removed.push(params.name)
    return {}
  } } }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(SecretsSettings)))
    expect(host.textContent).toContain('for OpenAI, read only')
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Remove KEY"]')!
    await act(async () => button.click())
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm remove')!.click())
    expect(removed).toEqual(['KEY'])
    expect(host.textContent).not.toContain('for OpenAI, read only')
  } finally { act(() => root.unmount()); host.remove() }
})
