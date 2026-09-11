export { BrowserSessionManager, BrowserAutomationError } from './BrowserSessionManager'
export type { BrowserAutomationCancellation, BrowserAutomationPolicy, BrowserSessionManagerOptions } from './BrowserSessionManager'
export { BrowserToolDispatcher } from './BrowserToolDispatcher'
export { ManagedBrowserWorkflowAdapter } from './BrowserWorkflowAdapter'

import type { BrowserBroker } from '../BrowserBroker'
import type { BrowserAutomationCancellation, BrowserAutomationPolicy } from './BrowserSessionManager'
import { BrowserSessionManager } from './BrowserSessionManager'
import { BrowserToolDispatcher } from './BrowserToolDispatcher'
import { ManagedBrowserWorkflowAdapter } from './BrowserWorkflowAdapter'

export interface BrowserAutomationCompositionOptions {
  profileId: string
  profileRoot: string
  broker: Pick<BrowserBroker, 'call'>
  cancellation?: BrowserAutomationCancellation
  policy?: BrowserAutomationPolicy
  requestHuman?: ConstructorParameters<typeof BrowserToolDispatcher>[0]['requestHuman']
}

export function createBrowserAutomation(options: BrowserAutomationCompositionOptions) {
  const sessions = new BrowserSessionManager(options)
  const tools = new BrowserToolDispatcher({ sessions, requestHuman: options.requestHuman })
  const workflow = new ManagedBrowserWorkflowAdapter(tools)
  return { sessions, tools, workflow }
}

