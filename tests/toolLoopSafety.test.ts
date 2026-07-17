import { describe, expect, it } from 'vitest'
import {
  assertToolLoopFinished,
  assertToolLoopTokenBudget
} from '../src/mms/orchestrator/LlmClient'

describe('LLM tool-loop safety', () => {
  it('does not turn an unfinished tool loop into a successful Done response', () => {
    expect(() => assertToolLoopFinished('toolUse')).toThrow('before producing a final response')
    expect(() => assertToolLoopFinished('stop')).not.toThrow()
  })

  it('stops runaway cumulative usage before it reaches extreme totals', () => {
    expect(() => assertToolLoopTokenBudget(512_001, 128_000)).toThrow('safety budget')
    expect(() => assertToolLoopTokenBudget(512_000, 128_000)).not.toThrow()
  })
})
