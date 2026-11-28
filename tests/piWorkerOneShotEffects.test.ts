/**
 * `pi:worker` claims `isolation: verified`, `tools: none_offered` and `attempts: one`. Shown on the real pi-ai Bedrock
 * stream and AWS SDK (`harness/realPiWorker.ts`: throwaway folders, a loopback stub of Bedrock's runtime, made-up keys),
 * started through the Pi runtime's single-request transport as a title request starts it.
 *
 * The person's setup sits where the AWS SDK and Pi would read it: `~/.aws/config` and `~/.aws/credentials` with
 * `max_attempts`, `retry_mode`, a region, an app id for the user agent, other profiles' keys and a `credential_process`
 * that writes a marker, the same files again behind `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE`,
 * `AWS_MAX_ATTEMPTS` and `AWS_RETRY_MODE` in Mousse's environment, and Pi's own agent folder (`PI_CODING_AGENT_DIR` and
 * `~/.pi/agent`) with settings, an `AGENTS.md` and an extension that writes a marker when it loads. Nothing may run, no
 * request may carry their lines, the request must be signed with the entry's keys in the entry's region, declare no
 * tool, be sent once, and the place must be gone after.
 *
 * The control runs the same worker on the same person with the AWS SDK's own lookup (their home, their variables, no
 * keys in the request): their credential process runs, their default profile signs the request in its region, their
 * app id reaches its user agent, and their `max_attempts` sends it five times, so the checks above would see each of
 * them. Pi's extension writes its marker when Node loads it, so the marker check would see it run.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { placesLeft } from './harness/realOpencode'
import { bedrockStub, ENTRY_KEY_ID, ENTRY_SECRET, piPerson, piWorkerRuntime, piWorkerScript, PROMPT_LINE, runWorkerDirect, sendWorkerOnce, workerRequest } from './harness/realPiWorker'

let script: string
beforeAll(async () => {
  script = await piWorkerScript()
}, 120_000)

const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Every line of the person's setup that must not reach a request. */
const STRINGS = ['AKIAUSERDEFAULT0001', 'AKIAOTHERPROFILE001', 'AKIAPROCESS00000001', 'ap-southeast-2', 'PI_SETTINGS_LINE_c41d', 'PI_AGENTS_LINE_c41d', 'PERSON_UA_DEFAULT_c41d', 'PERSON_UA_OTHER_c41d']

/** A person with AWS and Pi setup in their home and behind Mousse's environment. */
function personWithSetup() {
  const person = piPerson()
  cleanups.push(person.remove)
  const markers = join(person.root, 'markers')
  mkdirSync(markers)
  const process = join(person.root, 'credential-process.cjs')
  writeFileSync(process, `require('fs').writeFileSync(${JSON.stringify(join(markers, 'credential-process'))}, 'x'); console.log(JSON.stringify({ Version: 1, AccessKeyId: 'AKIAPROCESS00000001', SecretAccessKey: 'process-secret' }))\n`)
  const config = [
    '[default]', 'region = ap-southeast-2', 'max_attempts = 5', 'retry_mode = adaptive', 'sdk_ua_app_id = PERSON_UA_DEFAULT_c41d', `credential_process = "${globalThis.process.execPath}" "${process}"`,
    '[profile other]', 'region = ap-southeast-2', 'max_attempts = 5', 'sdk_ua_app_id = PERSON_UA_OTHER_c41d', ''
  ].join('\n')
  const credentials = ['[other]', 'aws_access_key_id = AKIAOTHERPROFILE001', 'aws_secret_access_key = other-secret', '[spare]', 'aws_access_key_id = AKIAUSERDEFAULT0001', 'aws_secret_access_key = spare-secret', ''].join('\n')
  const aws = join(person.home, '.aws')
  mkdirSync(aws, { recursive: true })
  writeFileSync(join(aws, 'config'), config)
  writeFileSync(join(aws, 'credentials'), credentials)
  // The same files again, where Mousse's environment points the SDK.
  const elsewhere = join(person.root, 'aws-elsewhere')
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, 'config'), config)
  writeFileSync(join(elsewhere, 'credentials'), credentials)
  // Pi's own agent folder, in the home and behind its variable.
  const extension = (dir: string, tag: string) => {
    mkdirSync(join(dir, 'extensions'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'amazon-bedrock', systemPrompt: 'PI_SETTINGS_LINE_c41d' }))
    writeFileSync(join(dir, 'AGENTS.md'), 'PI_AGENTS_LINE_c41d\n')
    const file = join(dir, 'extensions', `marker-${tag}.mjs`)
    writeFileSync(file, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(markers, `pi-extension-${tag}`))}, 'x')\nexport default function () {}\n`)
    return file
  }
  const piHome = extension(join(person.home, '.pi', 'agent'), 'HOME')
  const piDir = join(person.root, 'pi-agent')
  const piVariable = extension(piDir, 'VAR')
  const ambient = {
    AWS_ACCESS_KEY_ID: ENTRY_KEY_ID,
    AWS_SECRET_ACCESS_KEY: ENTRY_SECRET,
    AWS_REGION: 'us-east-1',
    AWS_PROFILE: 'other',
    AWS_CONFIG_FILE: join(elsewhere, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(elsewhere, 'credentials'),
    AWS_MAX_ATTEMPTS: '5',
    AWS_RETRY_MODE: 'adaptive',
    PI_CODING_AGENT_DIR: piDir
  }
  return { person, markers, ambient, extensions: [piHome, piVariable] }
}

describe('pi:worker holds the person’s AWS and Pi setup out of a single request (real AWS SDK at a stub)', () => {
  it('runs nothing of theirs, sends none of their lines, signs with the entry’s keys in its region, declares no tool, sends once, and leaves nothing behind', async () => {
    const { person, markers, ambient } = personWithSetup()
    const stub = await bedrockStub({ status: 503 })
    cleanups.push(() => stub.close())
    // Outside Mousse's own profile folder, where the places are.
    const home = () => readdirSync(person.home, { recursive: true }).filter((path) => !String(path).startsWith('Mousse')).sort()
    const homeBefore = home()
    const runtime = piWorkerRuntime({ person, script, stub, ambient })
    const { seen, sent } = sendWorkerOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('unavailable')
    expect(seen.sent).toBe(1)
    // Once, though their config and environment ask for five attempts.
    expect(stub.requests).toHaveLength(1)
    const request = stub.requests[0]!
    // The request went out, so the checks below read what it carries.
    expect(request.body).toContain(PROMPT_LINE)
    expect(stub.signers()).toEqual([ENTRY_KEY_ID])
    expect(String(request.headers.authorization)).toContain('/us-east-1/bedrock/aws4_request')
    expect(JSON.parse(request.body)).not.toHaveProperty('toolConfig')
    const everything = `${request.path}\n${JSON.stringify(request.headers)}\n${request.body}`
    for (const line of STRINGS) expect(everything).not.toContain(line)
    expect(readdirSync(markers)).toEqual([])
    expect(placesLeft(person.profile)).toEqual([])
    // Nothing of the SDK's or Pi's was made in their home.
    expect(home()).toEqual(homeBefore)
  }, 90_000)

  it('control: with the SDK’s own lookup, their credential process runs, their profile signs in its region, and their max_attempts sends five times', async () => {
    const { person, markers, extensions } = personWithSetup()
    const stub = await bedrockStub({ status: 503 })
    cleanups.push(() => stub.close())
    // Their default profile and home, and no keys or region in the request: the SDK finds them in their files.
    const env = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...person.env, AWS_PROFILE: 'default' }
    const events = await runWorkerDirect(script, env, workerRequest(stub, {}))
    expect(stub.requests, JSON.stringify(events.at(-1))).toHaveLength(5)
    expect(stub.signers()[0]).toBe('AKIAPROCESS00000001')
    expect(String(stub.requests[0]!.headers.authorization)).toContain('/ap-southeast-2/bedrock/')
    expect(readdirSync(markers)).toContain('credential-process')
    // Their profile's app id reaches the request's user agent.
    expect(JSON.stringify(stub.requests[0]!.headers)).toContain('PERSON_UA_DEFAULT_c41d')
    // Pi's extensions write their markers when loaded.
    for (const file of extensions) execFileSync(process.execPath, [file])
    expect(readdirSync(markers)).toEqual(expect.arrayContaining(['pi-extension-HOME', 'pi-extension-VAR']))
  }, 90_000)
})
