import type { BrowserModelCapabilityRecord, BrowserModelProvider } from '../../../shared/browser/modelAdapters'
import { anthropicComputerCapability } from './anthropic'
import { googleComputerCapability } from './google'
import { openAiComputerCapability } from './openai'

const genericB1: BrowserModelCapabilityRecord = {
  provider: 'openai', model: 'mousse-generic-tool-loop', endpoint: 'mms-agent-tools', tier: 'B1', availability: 'experimental',
  adapterRevision: 'm03-generic-dispatcher-v1', browserRevision: 'managed-chromium-certified', testedAt: '2026-09-11',
  coordinateSystem: 'semantic-ref', supportsImages: false, supportsSemanticRefs: true, supportsOrderedBatches: false, supportsSafetyDecisions: true,
  limitations: ['Uses the existing M01 structured browser tools and semantic observation refs.', 'Screenshots and coordinate fallback are disabled.', 'No exact provider/model evaluation has qualified this synthetic profile as available.']
}

const genericB2: BrowserModelCapabilityRecord = {
  provider: 'openai', model: 'mousse-generic-vision-tool-loop', endpoint: 'mms-agent-tools', tier: 'B2', availability: 'experimental',
  adapterRevision: 'm03-generic-dispatcher-vision-v1', browserRevision: 'managed-chromium-certified', testedAt: '2026-09-11',
  coordinateSystem: 'screenshot-pixels-top-left', supportsImages: true, supportsSemanticRefs: true, supportsOrderedBatches: false, supportsSafetyDecisions: true,
  limitations: ['The host must gate screenshots on the selected model and attach the exact observation geometry.', 'No live provider/model conformance is claimed by this catalog record.']
}

const unknownB0: BrowserModelCapabilityRecord = {
  provider: 'google', model: 'unknown', endpoint: 'none', tier: 'B0', availability: 'unavailable', adapterRevision: 'none', browserRevision: 'unknown', testedAt: '2026-09-11',
  coordinateSystem: 'semantic-ref', supportsImages: false, supportsSemanticRefs: false, supportsOrderedBatches: false, supportsSafetyDecisions: false,
  limitations: ['No reliable tool calling or browser conformance record is available. Browser tools stay hidden.']
}

export const browserModelCapabilities: readonly BrowserModelCapabilityRecord[] = [unknownB0, genericB1, genericB2, openAiComputerCapability, anthropicComputerCapability, googleComputerCapability]

export function getBrowserModelCapability(provider: BrowserModelProvider, model: string): BrowserModelCapabilityRecord {
  const exact = browserModelCapabilities.find((item) => item.provider === provider && item.model === model)
  if (exact) return exact
  return {
    provider, model, endpoint: 'unknown', tier: 'B0', availability: 'unavailable', adapterRevision: 'none', browserRevision: 'unknown', testedAt: '2026-09-11',
    coordinateSystem: 'semantic-ref', supportsImages: false, supportsSemanticRefs: false, supportsOrderedBatches: false, supportsSafetyDecisions: false,
    limitations: ['No adapter or conformance record exists for this provider/model. Browser tools must remain hidden.']
  }
}
