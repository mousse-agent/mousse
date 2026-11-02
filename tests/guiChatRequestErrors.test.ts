import { describe, expect, it } from 'vitest'
import { guiChatRequestError } from '../src/main/mms/requestErrors'
import { MmsProtocolError } from '../src/mms/protocol/client'

describe('GUI chat connection errors', () => {
  it.each(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTCONN'])('explains %s without promising a rejected turn or safe replay', (code) => {
    const cause = Object.assign(new Error('private socket details'), { code })
    const error = guiChatRequestError(cause)
    expect(error.code).toBe('workspace_connection_lost')
    expect(error.message).toContain('turn may still be running')
    expect(error.message).not.toContain('private socket details')
    expect(error.errorInfo).toEqual({ category: 'unavailable', retryable: false })
    expect(error.cause).toBe(cause)
  })
  it('classifies a plain socket close', () => {
    expect(guiChatRequestError(new Error('Connection closed')).code).toBe('workspace_connection_lost')
  })
  it('retains explicit protocol admission errors', () => {
    const error = guiChatRequestError(new MmsProtocolError('thread_not_found', 'Thread not found'))
    expect(error.code).toBe('thread_not_found')
    expect(error.message).toBe('Thread not found')
  })
  it('treats a request the client stopped waiting for as one that may have happened', () => {
    const cause = new Error('Request timeout: orchestrator.send')
    const error = guiChatRequestError(cause)
    expect(error.code).toBe('outcome_uncertain')
    expect(error.message).toContain('may have arrived')
    expect(error.errorInfo).toEqual({ category: 'unavailable', retryable: true })
    expect(error.cause).toBe(cause)
  })
  it('does not misclassify unrelated internal errors as a disconnect', () => {
    expect(guiChatRequestError(new Error('Other bug')).code).toBe('internal_error')
  })
})
