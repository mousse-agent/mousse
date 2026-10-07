import { expect, it } from 'vitest'
import { contextHandoff, previousTurnModel } from '../src/mms/orchestrator/contextHandoff'
import { createNativeContext, migrateLegacyContext } from '../src/mms/orchestrator/nativeContext'
import { nativeAgentAssistantMessage } from '../src/mms/providers/nativeAgentHistory'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../src/shared/types'
const from = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
const to = { provider: 'claude-subscription', model: 'opus:medium' }
const message = (extra: Partial<ChatMessage>): ChatMessage => ({ id: 'x', role: 'user', content: 'hello', timestamp: '2026-10-07T00:00:00Z', ...extra })
it('marks only admitted transitions, including provider switches with equal model IDs', () => {
 expect(contextHandoff(undefined, to)).toBeUndefined()
 expect(contextHandoff(to, to)).toBeUndefined()
 expect(contextHandoff(to, {...to, model: 'opus:high'})).toBeUndefined()
 expect(contextHandoff(from, to)).toEqual({ from, to })
 expect(contextHandoff({ ...to, provider: 'other' }, to)).toBeDefined()
})
it('uses persisted admitted selections and ignores hidden undo history', () => {
 const context = createNativeContext([nativeAgentAssistantMessage('old', from.model, from.provider)])
 expect(previousTurnModel([message({ modelSelection: to })], context)).toEqual(to)
 expect(previousTurnModel([message({ modelSelection: to, hidden: true })], context)).toEqual(from)
 expect(previousTurnModel([], migrateLegacyContext([message({role:'assistant'})]))).toBeUndefined()
})
it('keeps the marker separate from adjacent answers and excludes it from migrated model context', () => {
 const marker = message({ id: 'handoff', role: 'assistant', kind: 'context_handoff', content: 'gpt-6.1-sol → opus:medium', contextHandoff: { from, to } })
 const messages = [message({id:'u'}), marker, message({id:'a',role:'assistant',content:'Answer'})]
 const ui = mousseToUIMessages(messages)
 expect(ui.map(m=>m.id)).toEqual(['u','handoff','a'])
 expect(ui[1].metadata).toMatchObject({ contextHandoff: { from, to } })
 expect(migrateLegacyContext(messages).messages).toHaveLength(2)
})
