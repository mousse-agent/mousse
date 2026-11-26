/**
 * Frames from other sites, as the browser worker reads and acts on them:
 * - a frame that went away while it was read is skipped, while a browser that is gone fails the read.
 */
import { describe, expect, it } from 'vitest'
import { CdpDisconnectedError, isCdpTargetGoneError } from '../src/browser-worker/cdp/connection'

/** An error as `CdpConnection` rejects a command Chromium answered with an error. */
const chromiumError = (message: string, code = -32000) => Object.assign(new Error(message), { cdpCode: code })

describe('a frame that went away is told apart from a browser that went away', () => {
  it.each([
    ['its session detached', chromiumError('Session with given id not found.', -32001), true],
    ['its target closed', chromiumError('No target with given id found'), true],
    ['it navigated or closed during the command', chromiumError('Inspected target navigated or closed'), true],
    ['its frame is gone from the page', chromiumError('Frame with the given id was not found.'), true],
    ['the pipe to the browser closed', new CdpDisconnectedError('CDP pipe ended'), false],
    ['a command Chromium refused for another reason', chromiumError('Could not compute content quads.'), false],
    ['an error that is not Chromium\'s answer', new Error('Session with given id not found.'), false]
  ])('%s', (_case, error, gone) => {
    expect(isCdpTargetGoneError(error)).toBe(gone)
  })
})
