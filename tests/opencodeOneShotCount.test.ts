/**
 * `opencode:sealed` claims one request on the wire (`attempts: one`). Counted here at a stub: the real OpenCode
 * (`realOpencode.ts`), started through the runtime's single-request transport as a title request starts it, against a
 * loopback model that answers 429 or 503. A dummy key; no sign-in.
 *
 * The request is `POST /api/session/:id/generate`, which makes its model request with no session runner. A prompt on
 * the same session (`/api/session/:id/prompt`) runs the runner, which retries a failed model request itself up to ten
 * times from about 2 s apart (2.0.20 `session/runner/retry.ts`): seen on OpenCode 2.0.20 as three requests for two 503s
 * when nothing stops it, and one only when an interrupt wins the race against its first retry. `generate` runs no tool
 * either: one of OpenCode's own free models, offered `read`, that calls it gets no second request (on `prompt` the read
 * runs and the model is asked again and again).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { modelStub, opencodeBinary, opencodeRuntime, placesLeft, sendOnce, stubProviderConfig, throwawayUser } from './harness/realOpencode'

const binary = opencodeBinary()
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe.skipIf(!binary)('opencode:sealed sends one request (real OpenCode)', () => {
  it.each([
    [429, 'rate_limited'],
    [503, 'unavailable']
  ] as const)('a model that answers %i is asked once, and the request fails as %s', async (status, kind) => {
    const user = throwawayUser()
    cleanups.push(user.remove)
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    stub.statuses = [status, status, status, status]
    const runtime = opencodeRuntime(binary!, user.env, user.profile, { oneShotConfigContent: stubProviderConfig(stub, 'dummy-key') })
    cleanups.push(() => runtime.stop())
    const { seen, sent } = sendOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeDefined()
    expect(classifyOneShotFailure(error)).toBe(kind)
    expect(seen.sent).toBe(1)
    // OpenCode's runner would have asked again about 2 s later; its server is gone, and nothing more arrived.
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(stub.requests).toHaveLength(1)
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)

  it('one of OpenCode’s own free models is offered read alone, and a read it calls is not run: still one request', async () => {
    const user = throwawayUser()
    cleanups.push(user.remove)
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const target = join(user.root, 'secret.txt')
    writeFileSync(target, 'UNIQUE_FILE_CONTENT')
    stub.toolCall = { name: 'read', arguments: { filePath: target, path: target } }
    // OpenCode's own provider, pointed at the stub: a model named `-free` is one of its free ones.
    const runtime = opencodeRuntime(binary!, user.env, user.profile, { oneShotConfigContent: stubProviderConfig(stub, 'public', 'opencode', 'stub-free') })
    cleanups.push(() => runtime.stop())
    const { seen, sent } = sendOnce(runtime, 'opencode/stub-free')
    // No text comes back (the runner fails it as empty), and nothing was run for it.
    expect(await sent).toBe('')
    expect(seen.sent).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]!.tools).toEqual(['read'])
    expect(stub.requests.map((request) => request.text).join('')).not.toContain('UNIQUE_FILE_CONTENT')
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)
})
