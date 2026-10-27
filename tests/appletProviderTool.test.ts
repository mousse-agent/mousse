import { expect, it } from 'vitest'
import { sameMessageSnapshot } from '../src/renderer/stores/appStore'
import type { ChatMessage } from '../src/shared/types'

it('recognizes a durable applet reference arriving after a completed text snapshot', () => {
  const message:ChatMessage={id:'answer',role:'assistant',content:'same',timestamp:'now'}
  expect(sameMessageSnapshot([message],[{...message,presentationParts:[{type:'applet',reference:{appletId:'a',revisionId:'r',sourceHash:'h',title:'Title',description:''}}]}])).toBe(false)
})
