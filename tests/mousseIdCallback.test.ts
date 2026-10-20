import { afterEach, describe, expect, it } from 'vitest'
import { MOUSSE_ID_CALLBACK_PATH, MousseIdCallbacks, runtimeMousseIdOrigin } from '../src/main/mousseIdCallback'

describe('Mousse ID loopback callback', () => {
  let callbacks: MousseIdCallbacks | undefined
  afterEach(() => callbacks?.dispose())

  it('reports the decision from the approval page once', async () => {
    let decided = 0
    callbacks = new MousseIdCallbacks(() => { decided += 1 })
    const { id, url } = await callbacks.start()
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${MOUSSE_ID_CALLBACK_PATH}${id}$`))

    const response = await fetch(`${url}?status=approved`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Signed in to Mousse')
    await expect(callbacks.wait(id)).resolves.toBe('approved')
    expect(decided).toBe(1)
    await expect(fetch(`${url}?status=approved`)).rejects.toThrow()
  })

  it('treats anything but approved as denied', async () => {
    callbacks = new MousseIdCallbacks()
    const { id, url } = await callbacks.start()
    await fetch(`${url}?status=denied`)
    await expect(callbacks.wait(id)).resolves.toBe('denied')
  })

  it('ignores other paths and stops when cancelled', async () => {
    callbacks = new MousseIdCallbacks()
    const { id, url } = await callbacks.start()
    const wrong = await fetch(`${new URL(url).origin}${MOUSSE_ID_CALLBACK_PATH}someone-else?status=approved`)
    expect(wrong.status).toBe(404)
    callbacks.cancel(id)
    await expect(callbacks.wait(id)).resolves.toBe('cancelled')
    await expect(callbacks.wait('unknown')).resolves.toBe('cancelled')
  })

  it('reads the service address from the environment', () => {
    expect(runtimeMousseIdOrigin({ MOUSSE_ID_ORIGIN: ' https://api.mousse.work ' })).toBe('https://api.mousse.work')
    expect(runtimeMousseIdOrigin({ MOUSSE_PLUS_ORIGIN: 'http://127.0.0.1:8787' })).toBe('http://127.0.0.1:8787')
    expect(runtimeMousseIdOrigin({})).toBe('')
  })
})
