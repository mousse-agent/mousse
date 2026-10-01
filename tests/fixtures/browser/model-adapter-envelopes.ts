/** Deterministic provider envelopes used by M03 schema tests; no provider calls or credentials. */
export const openAiClickEnvelope = (x: number, y: number) => ({
  id: 'fixture-openai-response',
  output: [{
    type: 'computer_call', call_id: 'fixture-openai-call', status: 'completed', pending_safety_checks: [],
    action: { type: 'click', button: 'left', x, y }
  }]
})

export const anthropicClickEnvelope = (x: number, y: number) => ({
  content: [{ type: 'tool_use', id: 'fixture-anthropic-call', name: 'computer', input: { action: 'left_click', coordinate: [x, y] } }]
})

export const geminiClickEnvelope = (x: number, y: number, decision?: 'allow' | 'require_confirmation' | 'block') => ({
  id: 'fixture-gemini-interaction',
  steps: [{ type: 'function_call', id: 'fixture-gemini-call', name: 'click', arguments: { x, y, ...(decision ? { safety_decision: { decision } } : {}) } }]
})

export const openAiMultiCallEnvelope = () => ({
  id: 'fixture-openai-multi-response',
  output: [
    { type: 'computer_call', call_id: 'fixture-openai-call-a', status: 'completed', pending_safety_checks: [], action: { type: 'screenshot' } },
    { type: 'computer_call', call_id: 'fixture-openai-call-b', status: 'completed', pending_safety_checks: [], action: { type: 'wait' } }
  ]
})

export const anthropicMultiCallEnvelope = () => ({
  content: [
    { type: 'tool_use', id: 'fixture-anthropic-call-a', name: 'computer', input: { action: 'screenshot' } },
    { type: 'tool_use', id: 'fixture-anthropic-call-b', name: 'computer', input: { action: 'wait' } }
  ]
})

export const geminiMultiCallEnvelope = () => ({
  id: 'fixture-gemini-multi-interaction',
  steps: [
    { type: 'function_call', id: 'fixture-gemini-call-a', name: 'click', arguments: { x: 100, y: 100 } },
    { type: 'function_call', id: 'fixture-gemini-call-b', name: 'wait', arguments: {} }
  ]
})
