import { describe, expect, it } from 'vitest'
import { ATTENTION_LADDER, attentionOfStatus, needsMeLabel, threadAttention, threadStatus, worstOf } from '../src/shared/threadAttention'

describe('threadStatus and threadAttention', () => {
  it('reads each activity as one rung of the ladder', () => {
    expect(threadAttention('awaiting_input')).toBe('needs-me')
    expect(threadAttention('processing')).toBe('working')
    expect(threadAttention('waiting')).toBe('working')
    expect(threadAttention('paused')).toBe('paused')
    expect(threadAttention('completed')).toBe('done')
    expect(threadAttention('idle')).toBe('quiet')
    expect(threadAttention(undefined)).toBe('quiet')
  })

  it('tells an approval from a question, both needing the person', () => {
    expect(threadStatus('awaiting_input', true)).toBe('approval')
    expect(threadStatus('awaiting_input')).toBe('question')
    expect(attentionOfStatus('approval')).toBe('needs-me')
    expect(attentionOfStatus('question')).toBe('needs-me')
  })

  it('keeps Working and Waiting apart for the row, one level for the roll-up', () => {
    expect(threadStatus('processing')).toBe('working')
    expect(threadStatus('waiting')).toBe('waiting')
    expect(attentionOfStatus('waiting')).toBe('working')
  })

  it('ignores the approval flag for a thread that is not waiting', () => {
    expect(threadStatus('processing', true)).toBe('working')
    expect(threadStatus('completed', true)).toBe('done')
  })
})

describe('worstOf', () => {
  it('orders needs-me, working, paused, done, quiet', () => {
    expect(ATTENTION_LADDER).toEqual(['needs-me', 'working', 'paused', 'done', 'quiet'])
    expect(worstOf(['done', 'needs-me', 'working'])).toBe('needs-me')
    expect(worstOf(['done', 'paused', 'working'])).toBe('working')
    expect(worstOf(['quiet', 'done', 'paused'])).toBe('paused')
    expect(worstOf(['quiet', 'done'])).toBe('done')
  })

  it('is quiet with nothing to roll up', () => {
    expect(worstOf([])).toBe('quiet')
    expect(worstOf(['quiet', 'quiet'])).toBe('quiet')
  })
})

describe('needsMeLabel', () => {
  it('says the count in one phrase', () => {
    expect(needsMeLabel(1)).toBe('1 thread needs you')
    expect(needsMeLabel(3)).toBe('3 threads need you')
  })
})
