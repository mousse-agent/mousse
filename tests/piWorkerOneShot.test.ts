/**
 * `pi:worker`: Pi's Bedrock models run single requests (titles, branch names, pull request drafts, commit messages, a
 * bot's name and digest) in a worker process of their own, held to one request on the wire. Shown on the real pi-ai
 * Bedrock stream and AWS SDK at a loopback stub (`harness/realPiWorker.ts`), with made-up keys, started through the
 * Pi runtime's single-request transport as a title request starts it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { piDriver } from '../src/mms/harness/drivers/pi'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { testHarness } from '../src/mms/run/testkit/harness'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { bedrockInputs } from '../src/mms/harness/drivers/pi/workerOneShot'
import { routeLabel } from '../src/mms/harness/oneShot/admission'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { placesLeft } from './harness/realOpencode'
import { BEDROCK_MODEL, bedrockModel, bedrockStub, ENTRY_KEY_ID, ENTRY_SECRET, piPerson, PROMPT_LINE, piWorkerRuntime, piWorkerScript, runWorkerDirect, sendWorkerOnce, workerRequest, type StubAnswer } from './harness/realPiWorker'

let script: string
beforeAll(async () => {
  script = await piWorkerScript()
}, 120_000)

const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(answer: StubAnswer, input: { stored?: () => { type: 'api_key'; key: string; env?: Record<string, string> } | undefined; ambient?: Record<string, string> } = {}) {
  const person = piPerson()
  cleanups.push(person.remove)
  const stub = await bedrockStub(answer)
  cleanups.push(() => stub.close())
  const ambient = input.ambient ?? { AWS_ACCESS_KEY_ID: ENTRY_KEY_ID, AWS_SECRET_ACCESS_KEY: ENTRY_SECRET, AWS_REGION: 'us-east-1' }
  const runtime = piWorkerRuntime({ person, script, stub, ambient, ...(input.stored ? { stored: input.stored } : {}) })
  return { person, stub, runtime }
}

describe('pi:worker route', () => {
  const catalogue = (model: { id: string }) => ({ models: { getModel: (_provider: string, id: string) => (id === model.id ? model : undefined), getModels: () => [model] } as never })

  it('a Bedrock model runs on pi:worker, held; any other Pi model stays on pi:direct', () => {
    const bedrock = piDriver({ credentials: () => catalogue(bedrockModel()) })
    const decision = bedrock.oneShotRoute!({ config: { home: 'default' }, instanceId: 'pi:amazon-bedrock', model: BEDROCK_MODEL } as never)
    expect(decision).toMatchObject({ route: { id: 'pi:worker' } })
    expect(routeLabel((decision as { route: never }).route)).toBe('held')
    const gpt = Object.values(OPENAI_MODELS as unknown as Record<string, { id: string }>)[0]!
    const openai = piDriver({ credentials: () => catalogue(gpt) })
    expect(openai.oneShotRoute!({ config: { home: 'default' }, instanceId: 'pi:openai', model: gpt.id } as never)).toMatchObject({ route: { id: 'pi:direct' } })
  })
})

describe('pi:worker from the title listing to the answer', () => {
  it('a signed-in Bedrock entry lists its models as held on pi:worker, and a title request on one is answered by the worker', async () => {
    const person = piPerson()
    cleanups.push(person.remove)
    const stub = await bedrockStub({ text: 'Fix OAuth login loop' })
    cleanups.push(() => stub.close())
    // The profile's real provider store and catalogue, with a bearer token saved for Bedrock.
    const auth = new ProviderAuthService(join(person.root, 'provider-auth.json'))
    cleanups.push(() => auth.stop())
    await auth.setApiKey('amazon-bedrock', 'bedrock-bearer-e2e')
    // Requests go to the stub: the catalogue's model, its endpoint the stub's.
    const models = { ...auth.models, getModel: (provider: string, id: string) => (provider === 'amazon-bedrock' && id === BEDROCK_MODEL ? bedrockModel(stub.url) : auth.models.getModel(provider as never, id as never)), getModels: (provider: string) => auth.models.getModels(provider as never) }
    const credentials = { has: (id: string) => auth.has(id), getConfiguredLlmProviders: () => auth.getConfiguredLlmProviders(), getConfiguredProviders: () => auth.getConfiguredProviders(), getProviderDisplayName: (id: string) => auth.getProviderDisplayName(id), credentials: auth.credentials, models }
    let stored: unknown = { 'pi:amazon-bedrock': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [piDriver({ credentials: () => credentials as never, worker: { script } })], instances, profileHome: person.profile })
    cleanups.push(() => harness.stop())
    // The entry's check, which a launched route waits for.
    await harness.instances.recheck('pi:amazon-bedrock')
    const entry = harness.titleListing().entries.find((each) => each.instanceId === 'pi:amazon-bedrock')
    expect(entry?.models.find((model) => model.id === BEDROCK_MODEL)).toMatchObject({ state: 'held', route: 'pi:worker' })
    const answer = await harness.oneShot({ selection: { instanceId: 'pi:amazon-bedrock', llmProvider: 'amazon-bedrock', model: BEDROCK_MODEL }, purpose: 'title', system: 'You name chats.', prompt: `${PROMPT_LINE}: fix the login bug`, maxChars: 80 })
    expect(answer).toEqual({ text: 'Fix OAuth login loop' })
    expect(stub.signers()).toEqual(['bearer'])
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)
})

describe('pi:worker sends a failed request once (real AWS SDK at a stub)', () => {
  const cases: Array<[429 | 503, string]> = [[503, 'unavailable'], [429, 'rate_limited']]
  it.each(cases)('%s: one request on the wire', async (status, kind) => {
    const { person, stub, runtime } = await setup({ status })
    const { seen, sent } = sendWorkerOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe(kind)
    expect(seen.sent).toBe(1)
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]!.path).toContain('/converse-stream')
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)

  it.each(cases)('control: %s without AWS_MAX_ATTEMPTS, the SDK sends the same request three times', async (status) => {
    const person = piPerson()
    cleanups.push(person.remove)
    const stub = await bedrockStub({ status })
    cleanups.push(() => stub.close())
    const env = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...person.env }
    const events = await runWorkerDirect(script, env, workerRequest(stub, { AWS_ACCESS_KEY_ID: ENTRY_KEY_ID, AWS_SECRET_ACCESS_KEY: ENTRY_SECRET, AWS_REGION: 'us-east-1' }))
    expect(events.at(-1)).toMatchObject({ event: 'end', error: expect.any(String) })
    expect(stub.requests).toHaveLength(3)
  }, 90_000)
})

describe('pi:worker answers', () => {
  it('streams the answer back, signs with the entry’s keys, and leaves nothing behind', async () => {
    const { person, stub, runtime } = await setup({ text: 'Fix OAuth login loop' })
    const { seen, sent } = sendWorkerOnce(runtime)
    await expect(sent).resolves.toBe('Fix OAuth login loop')
    expect(seen.text.join('')).toBe('Fix OAuth login loop')
    expect(seen.launched).toEqual([process.execPath])
    expect(stub.signers()).toEqual([ENTRY_KEY_ID])
    // No tool is declared.
    expect(JSON.parse(stub.requests[0]!.body)).not.toHaveProperty('toolConfig')
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)

  it('a tool call the model starts is reported, so the runner ends the request', async () => {
    const { runtime } = await setup({ tool: 'read_file' })
    const { seen, sent } = sendWorkerOnce(runtime)
    await sent.catch(() => undefined)
    expect(seen.tools).toEqual(['read_file'])
  }, 90_000)

  it('a worker that writes in its empty folder fails the request, and its place is still removed', async () => {
    const person = piPerson()
    cleanups.push(person.remove)
    const stub = await bedrockStub({ text: 'ok' })
    cleanups.push(() => stub.close())
    // A stand-in worker that answers but leaves a file where it runs.
    const writer = join(person.root, 'writer-worker.mjs')
    writeFileSync(writer, [
      "import { writeFileSync } from 'node:fs'",
      "process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n')",
      "process.stdin.once('data', () => { writeFileSync('notes.txt', 'x'); process.stdout.write(JSON.stringify({ event: 'end', text: 'ok' }) + '\\n', () => process.exit(0)) })"
    ].join('\n'))
    const runtime = piWorkerRuntime({ person, script: writer, stub, ambient: { AWS_ACCESS_KEY_ID: ENTRY_KEY_ID, AWS_SECRET_ACCESS_KEY: ENTRY_SECRET, AWS_REGION: 'us-east-1' } })
    const error = await sendWorkerOnce(runtime).sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('tool_detected')
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)

  it('a bearer token stored as the entry’s key signs the request', async () => {
    const { stub, runtime } = await setup({ text: 'ok' }, { stored: () => ({ type: 'api_key', key: 'bedrock-bearer-0001' }), ambient: { AWS_REGION: 'us-east-1' } })
    await expect(sendWorkerOnce(runtime).sent).resolves.toBe('ok')
    expect(stub.signers()).toEqual(['bearer'])
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer bedrock-bearer-0001')
  }, 90_000)
})

describe('pi:worker credentials', () => {
  it('reads the profile’s keys at each request: a credentials file replaced between two requests signs the second with the new key', async () => {
    const person = piPerson()
    cleanups.push(person.remove)
    const aws = join(person.home, '.aws')
    mkdirSync(aws, { recursive: true })
    const write = (id: string) => {
      const next = join(aws, 'credentials.next')
      writeFileSync(next, `[work]\naws_access_key_id = ${id}\naws_secret_access_key = secret-${id}\n`)
      // Replaced, as a rotation tool writes it: a new file over the old.
      renameSync(next, join(aws, 'credentials'))
    }
    write('AKIAROTATEFIRST00001')
    const stub = await bedrockStub({ text: 'ok' })
    cleanups.push(() => stub.close())
    const runtime = piWorkerRuntime({ person, script, stub, stored: () => ({ type: 'api_key', key: '<authenticated>', env: { AWS_PROFILE: 'work' } }), ambient: { AWS_REGION: 'us-east-1' } })
    await expect(sendWorkerOnce(runtime).sent).resolves.toBe('ok')
    write('AKIAROTATESECOND0002')
    await expect(sendWorkerOnce(runtime).sent).resolves.toBe('ok')
    expect(stub.signers()).toEqual(['AKIAROTATEFIRST00001', 'AKIAROTATESECOND0002'])
  }, 90_000)

  it('a profile that signs in with SSO is refused with its reason, before anything is sent', async () => {
    const person = piPerson()
    cleanups.push(person.remove)
    mkdirSync(join(person.home, '.aws'), { recursive: true })
    writeFileSync(join(person.home, '.aws', 'config'), '[profile corp]\nsso_session = corp\nsso_account_id = 111111111111\nregion = us-east-1\n')
    const stub = await bedrockStub({ text: 'ok' })
    cleanups.push(() => stub.close())
    const runtime = piWorkerRuntime({ person, script, stub, ambient: { AWS_PROFILE: 'corp' } })
    const { seen, sent } = sendWorkerOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('not_admitted')
    expect((error as Error).message).toMatch(/profile "corp" signs in with IAM Identity Center \(SSO\)/)
    expect(seen.sent).toBe(0)
    expect(stub.requests).toEqual([])
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)

  // Every way the entry can sign in, and what the worker is given for it. `home` holds the person's AWS files.
  const files = {
    config: [
      '[default]', 'region = eu-west-1', 'aws_access_key_id = AKIADEFAULT', 'aws_secret_access_key = default-secret', 'max_attempts = 7',
      '[profile keys]', 'region = eu-central-1',
      '[profile sso]', 'sso_start_url = https://example.awsapps.com/start',
      '[profile process]', 'credential_process = /usr/bin/creds',
      '[profile role]', 'role_arn = arn:aws:iam::111111111111:role/x', 'source_profile = keys',
      '[profile web]', 'web_identity_token_file = /tmp/token',
      '[profile login]', 'login_session = arn:aws:iam::111111111111:user/x',
      '[profile empty]', 'region = us-west-2'
    ].join('\n'),
    credentials: ['[keys]', 'aws_access_key_id = AKIAKEYS', 'aws_secret_access_key = keys-secret', 'aws_session_token = keys-token', '[other]', 'aws_access_key_id = AKIAOTHER', 'aws_secret_access_key = other-secret'].join('\n')
  }
  type Row = [string, { key?: string; env?: Record<string, string> } | undefined, Record<string, string>, { bearerToken?: string; env?: Record<string, string>; refused?: RegExp; signedOut?: RegExp }]
  const rows: Row[] = [
    ['a stored bearer token, over everything else', { key: 'stored-bearer' }, { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'us-east-2' }, { bearerToken: 'stored-bearer', env: { AWS_REGION: 'us-east-2' } }],
    ['the ambient marker with AWS_BEARER_TOKEN_BEDROCK', { key: '<authenticated>' }, { AWS_BEARER_TOKEN_BEDROCK: 'env-bearer' }, { bearerToken: 'env-bearer', env: {} }],
    ['a profile the sign-in stored, over keys in the environment', { key: '', env: { AWS_PROFILE: 'keys' } }, { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 's' }, { env: { AWS_ACCESS_KEY_ID: 'AKIAKEYS', AWS_SECRET_ACCESS_KEY: 'keys-secret', AWS_SESSION_TOKEN: 'keys-token', AWS_REGION: 'eu-central-1' } }],
    ['keys in the environment, over AWS_PROFILE', { key: '<authenticated>' }, { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_PROFILE: 'keys' }, { env: { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' } }],
    ['AWS_PROFILE, with AWS_REGION over the profile’s region', undefined, { AWS_PROFILE: 'keys', AWS_REGION: 'ap-south-1' }, { env: { AWS_ACCESS_KEY_ID: 'AKIAKEYS', AWS_SECRET_ACCESS_KEY: 'keys-secret', AWS_SESSION_TOKEN: 'keys-token', AWS_REGION: 'ap-south-1' } }],
    ['nothing set: the default profile, and none of its other settings', { key: '<authenticated>' }, {}, { env: { AWS_ACCESS_KEY_ID: 'AKIADEFAULT', AWS_SECRET_ACCESS_KEY: 'default-secret', AWS_REGION: 'eu-west-1' } }],
    ['an SSO profile', undefined, { AWS_PROFILE: 'sso' }, { refused: /IAM Identity Center \(SSO\)/ }],
    ['a credential-process profile', undefined, { AWS_PROFILE: 'process' }, { refused: /a credential process/ }],
    ['an assumed-role profile', undefined, { AWS_PROFILE: 'role' }, { refused: /an assumed role/ }],
    ['a web-identity profile', undefined, { AWS_PROFILE: 'web' }, { refused: /web identity/ }],
    ['an `aws login` profile', undefined, { AWS_PROFILE: 'login' }, { refused: /`aws login`/ }],
    ['web identity in the environment', undefined, { AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/t', AWS_ROLE_ARN: 'arn' }, { refused: /web identity/ }],
    ['a container role', undefined, { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/creds' }, { refused: /container/ }],
    ['a profile with no keys', undefined, { AWS_PROFILE: 'empty' }, { signedOut: /no access key/ }],
    ['a profile in neither file', undefined, { AWS_PROFILE: 'missing' }, { signedOut: /not in/ }]
  ]
  it.each(rows)('%s', async (_name, stored, env, expected) => {
    const person = piPerson()
    cleanups.push(person.remove)
    mkdirSync(join(person.home, '.aws'), { recursive: true })
    writeFileSync(join(person.home, '.aws', 'config'), files.config)
    writeFileSync(join(person.home, '.aws', 'credentials'), files.credentials)
    const reading = bedrockInputs(stored, { HOME: person.home, USERPROFILE: person.home, ...env })
    if (expected.refused) return expect(reading).rejects.toThrow(expected.refused)
    if (expected.signedOut) return expect(reading).rejects.toMatchObject({ code: 'signed_out', message: expect.stringMatching(expected.signedOut) })
    const inputs = await reading
    expect(inputs.bearerToken).toBe(expected.bearerToken)
    expect(inputs.env).toEqual(expected.env)
  })
})
