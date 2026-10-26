import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseChatGptModels } from '../../../src/mms/harness/chatgpt/models'
import { FakeIssuer, guardNetwork, tempHomes } from './fakeIssuer'
import { chatgptAuth, signIn } from './signInFlow'

guardNetwork()
const homes = tempHomes()
let issuer: FakeIssuer
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
})
afterEach(async () => {
  await issuer.stop()
})

describe('ChatGPT plan models', () => {
  it('keeps listed models in the server order, with their capabilities', () => {
    const models = parseChatGptModels({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }, { nope: 1 }, { effort: 'bad effort!' }], context_window: 400000, input_modalities: ['text', 'image'] },
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-5.5-mini', visibility: 'list', context_window: -1, input_modalities: 'image' },
        { slug: 'bad slug/../x', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'a'.repeat(129), visibility: 'list' },
        'garbage'
      ]
    })
    expect(models).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: { efforts: ['low', 'high'], images: true, contextWindow: 400000 } },
      { id: 'gpt-5.5-mini', label: 'gpt-5.5-mini', capabilities: { efforts: [], images: false } }
    ])
  })

  it('a body without models[] is an error', () => {
    expect(() => parseChatGptModels({ data: [] })).toThrow(expect.objectContaining({ failure: 'invalid_response' }))
  })

  it('lists with the active account\'s token, and follows an account switch', async () => {
    const auth = chatgptAuth(issuer, homes())
    issuer.onModels = () => ({ status: 200, body: { models: [{ slug: 'gpt-5.5', visibility: 'list' }] } })
    await signIn(issuer, auth, { subject: 'alice' })
    const alice = (await auth.access()).accessToken
    expect((await auth.listModels()).map((model) => model.id)).toEqual(['gpt-5.5'])
    await signIn(issuer, auth, { subject: 'bob' }, { method: 'chatgpt-new-account', clientId: 'oaiapp_two' })
    const bob = (await auth.access()).accessToken
    await auth.listModels()
    expect(issuer.modelRequests.map((request) => request.authorization)).toEqual([`Bearer ${alice}`, `Bearer ${bob}`])
  })

  it('a 401 fails auth_expired so the sign-in is checked again', async () => {
    const auth = chatgptAuth(issuer, homes())
    await signIn(issuer, auth, { subject: 'alice' })
    issuer.onModels = () => ({ status: 401, body: { error: { code: 'invalid_api_key' } } })
    await expect(auth.listModels()).rejects.toMatchObject({ code: 'auth_expired', failure: 'unauthorized' })
    // The tokens are kept: a 401 alone is not a revocation.
    expect(auth.status().state).toBe('signed_in')
  })
})
