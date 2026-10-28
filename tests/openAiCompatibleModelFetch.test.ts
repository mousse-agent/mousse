import { expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { enhanceProvidersWithOpenAiCompatibleFetch, inferTemplateForModelId } from '../src/mms/providers/openAiCompatibleModelFetch'

it('enables live /models discovery for other OpenAI-compatible providers', () => {
  const providers = builtinProviders()
  const moonshot = providers.find((provider) => provider.id === 'moonshotai')!
  const google = providers.find((provider) => provider.id === 'google')!
  expect(moonshot.refreshModels).toBeUndefined()
  enhanceProvidersWithOpenAiCompatibleFetch(providers)
  expect(moonshot.refreshModels).toBeTypeOf('function')
  expect(google.refreshModels).toBeUndefined()
})

const template = (api: string) => ({ id: `template-${api}`, api }) as unknown as Model<Api>
const FALLBACK = template('fallback')
const ALL_APIS = new Map(['anthropic-messages', 'google-generative-ai', 'openai-responses', 'openai-completions'].map((api) => [api, template(api)]))
const apiOf = (id: string, templates = ALL_APIS) => inferTemplateForModelId(id, templates, FALLBACK).api

it('picks the template API from the model family hints, first matching row wins', () => {
  const expected: Record<string, string> = {
    'claude-sonnet-4-6': 'anthropic-messages',
    'Qwen3-Coder': 'anthropic-messages',
    'fable-1': 'anthropic-messages',
    'anthropic/haiku': 'anthropic-messages',
    'claude-via-gpt': 'anthropic-messages',
    'gemini-2.5-pro': 'google-generative-ai',
    'google/gemma-3': 'google-generative-ai',
    'gpt-5': 'openai-responses',
    'grok-4': 'openai-responses',
    'gpt-5-codex': 'openai-responses',
    'muse-spark': 'openai-responses',
    'luna-1': 'openai-responses',
    'sol-mini': 'openai-responses',
    'terra-2': 'openai-responses',
    'o3-mini': 'openai-responses',
    o4: 'openai-responses',
    solar: 'openai-completions',
    'xo3': 'openai-completions',
    'kimi-k2': 'openai-completions',
    'deepseek-chat': 'openai-completions'
  }
  expect(Object.fromEntries(Object.keys(expected).map((id) => [id, apiOf(id)]))).toEqual(expected)
})

it('falls back when the matching row has no template, without trying a later row', () => {
  const noAnthropic = new Map([...ALL_APIS].filter(([api]) => api !== 'anthropic-messages'))
  expect(apiOf('claude-sonnet-4-6', noAnthropic)).toBe('fallback')
  expect(apiOf('kimi-k2', new Map([['openai-responses', template('openai-responses')]]))).toBe('openai-responses')
  expect(apiOf('kimi-k2', new Map())).toBe('fallback')
})
