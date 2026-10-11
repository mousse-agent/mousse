import { expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { nativeClient, providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import { sameMessageSnapshot } from '../src/renderer/stores/appStore'
import type { ChatMessage } from '../src/shared/types'

it('offers and dispatches structured applet publication through the actual provider tool loop', async () => {
  const source={schemaVersion:1,title:'Comparison',description:'Offline comparison',html:'<output>OK</output>',css:'',js:''}
  const calls:Context[]=[]
  const client=nativeClient([
    providerResponse([{type:'toolCall',id:'applet-call',name:'publish_applet',arguments:source}], 'toolUse'),
    providerResponse([{type:'text',text:'Here is the comparison.'}], 'stop')
  ],calls)
  const publish=vi.fn(()=>({queued:true,title:source.title}))
  const result=await client.chat([userMessage('Compare visually')],undefined,{onPublishApplet:publish,appletInstructions:'Current applet catalogue: none'})
  expect(result.text).toBe('Here is the comparison.')
  expect(calls[0].tools?.some(tool=>tool.name==='publish_applet')).toBe(true)
  expect(calls[0].systemPrompt).toContain('Current applet catalogue: none')
  expect(publish).toHaveBeenCalledExactlyOnceWith(source)
  expect(calls[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'toolResult',toolName:'publish_applet',isError:false})]))
})
it('recognizes a durable applet reference arriving after a completed text snapshot', () => {
  const message:ChatMessage={id:'answer',role:'assistant',content:'same',timestamp:'now'}
  expect(sameMessageSnapshot([message],[{...message,presentationParts:[{type:'applet',reference:{appletId:'a',revisionId:'r',sourceHash:'h',title:'Title',description:''}}]}])).toBe(false)
})
