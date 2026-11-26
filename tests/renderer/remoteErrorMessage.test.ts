import { expect, it } from 'vitest'
import { NET_ERRORS } from '../../src/shared/net'
import { remoteErrorMessage } from '../../src/renderer/lib/remoteComputers'

const failure = (code: keyof typeof NET_ERRORS, message = NET_ERRORS[code].message) => ({ code, message })

it("shows the other computer's own words for its refusal", () => {
  expect(remoteErrorMessage(failure('bad_request', 'That folder does not exist on this computer.'), 'Mac mini')).toBe(
    'That folder does not exist on this computer.'
  )
})

it('words a bare code for a person, never with its log message', () => {
  for (const code of ['bad_request', 'unsupported_version', 'profile_unsupported', 'rate_limited', 'peer_offline', 'forbidden'] as const) {
    const shown = remoteErrorMessage(failure(code), 'Mac mini')
    expect(shown, code).toContain('Mac mini')
    expect(shown, code).not.toBe(NET_ERRORS[code].message)
  }
})
