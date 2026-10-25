/**
 * Account identity (S2): the account an instance runs as is the vendor's stable account id (or a
 * hash of the credential it runs with), never a plan or organization, so two accounts on the same
 * plan or in the same organization read apart. The gateway only keeps a salted hash of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceCounterStore } from '../../src/mms/harness/instances'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { claudeAccountSubject } from '../../src/mms/providers/claudeSubscription/accountSubject'
import { CodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-account-'))
  homes.push(dir)
  return dir
}

const claudeJson = (accountUuid: string, organizationUuid = 'org-1') =>
  JSON.stringify({ oauthAccount: { accountUuid, organizationUuid, emailAddress: `${accountUuid}@example.com`, organizationName: 'Acme' } })

describe('Claude account subject', () => {
  /** Files Claude Code would read, by path; anything else does not exist. */
  const read = (files: Record<string, string>) => (path: string) => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  }
  const workHome = (text: string, more: Record<string, string> = {}) => read({ [join('/homes/work', '.claude.json')]: text, ...more })
  const subject = (env: NodeJS.ProcessEnv, readText: (path: string) => string) =>
    claudeAccountSubject({ CLAUDE_CONFIG_DIR: '/homes/work', ...env }, { readText, home: '/users/me', platform: 'linux' })

  it('tells two claude.ai users of one organization apart, from the home Claude Code reads', () => {
    const a = subject({}, workHome(claudeJson('user-a')))
    const b = subject({}, workHome(claudeJson('user-b')))
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
    // No account recorded in the home: unknown, never a shared placeholder.
    expect(subject({}, read({}))).toBeUndefined()
    expect(subject({}, workHome('{}'))).toBeUndefined()
  })

  it('keys a token or key sign-in by its credential, with the stored sign-in, without exposing it', () => {
    const stored = workHome(claudeJson('user-a'))
    const one = subject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-one' }, stored)
    const two = subject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-two' }, stored)
    expect(one).not.toBe(two)
    expect(one).not.toContain('sk-ant')
    expect(one).not.toBe(subject({}, stored))
    // Claude Code may still use the stored sign-in (a key it was told to refuse): it is part of the id.
    expect(subject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-one' }, workHome(claudeJson('user-b')))).not.toBe(one)
    // A proxy alone is not a credential: the stored account still decides, and the route is part of it.
    const proxied = subject({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, stored)
    expect(proxied).toMatch(/^claude\.ai:user-a:/)
    expect(proxied).not.toBe(subject({}, stored))
    // Nothing Mousse can see: unknown.
    expect(subject({}, read({}))).toBeUndefined()
  })

  it('ignores cloud variables while their route is off: a claude.ai switch still reads as another account', () => {
    const cloud = { AWS_PROFILE: 'default', AWS_ACCESS_KEY_ID: 'AKIAONE', GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json', ANTHROPIC_VERTEX_PROJECT_ID: 'p1' }
    const a = subject(cloud, workHome(claudeJson('user-a')))
    const b = subject(cloud, workHome(claudeJson('user-b')))
    expect(a).toMatch(/^claude\.ai:user-a:/)
    expect(a).not.toBe(b)
  })

  it('on Bedrock, reads the AWS access key the calls are signed with; a profile without static keys is unknown', () => {
    const stored = claudeJson('user-a')
    const credentials = (key: string) => `[default]\naws_access_key_id = AKIADEFAULT\n\n[work]\naws_access_key_id = ${key}\naws_secret_access_key = secret\n`
    const files = (key: string) => workHome(stored, { [join('/users/me', '.aws', 'credentials')]: credentials(key) })
    const bedrock = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work' }
    const one = subject(bedrock, files('AKIAONE'))
    expect(one).toMatch(/^bedrock:key:/)
    expect(one).not.toContain('AKIAONE')
    // The same profile name over another key is another account.
    expect(subject(bedrock, files('AKIATWO'))).not.toBe(one)
    expect(subject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'AKIAENV' }, workHome(stored))).toMatch(/^bedrock:key:/)
    // SSO, roles, the default chain: Mousse cannot tell, so unknown (never the stored claude.ai account).
    expect(subject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'sso' }, files('AKIAONE'))).toBeUndefined()
    expect(subject({ CLAUDE_CODE_USE_BEDROCK: '1' }, workHome(stored))).toBeUndefined()
  })

  it('on Vertex, reads the principal of the Google credentials file, not its path', () => {
    const vertex = { CLAUDE_CODE_USE_VERTEX: '1', GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json', ANTHROPIC_VERTEX_PROJECT_ID: 'p1' }
    const key = (email: string) => workHome(claudeJson('user-a'), { '/keys/sa.json': JSON.stringify({ type: 'service_account', client_email: email, private_key: 'k' }) })
    const one = subject(vertex, key('one@p1.iam.gserviceaccount.com'))
    expect(one).toMatch(/^vertex:sa:one@/)
    // Another service account at the same path is another account.
    expect(subject(vertex, key('two@p1.iam.gserviceaccount.com'))).not.toBe(one)
    // A credential of another kind, or none (the metadata server): unknown.
    expect(subject(vertex, workHome(claudeJson('user-a'), { '/keys/sa.json': JSON.stringify({ type: 'external_account' }) }))).toBeUndefined()
    expect(subject({ CLAUDE_CODE_USE_VERTEX: '1' }, workHome(claudeJson('user-a')))).toBeUndefined()
  })

  it('an apiKeyHelper or route in Claude Code\'s settings is honoured: the stored sign-in is not taken for the account', () => {
    const settings = (value: unknown) => workHome(claudeJson('user-a'), { [join('/homes/work', 'settings.json')]: JSON.stringify(value) })
    expect(subject({}, settings({ apiKeyHelper: '~/bin/get-key.sh' }))).toBeUndefined()
    expect(subject({}, settings({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))).toBeUndefined()
    expect(subject({}, settings({ env: { ANTHROPIC_API_KEY: 'sk-ant-api-one' } }))).toMatch(/env:/)
  })
})

describe('Codex account subject', () => {
  it('tells two ChatGPT accounts on the same plan apart', () => {
    const service = new CodexProviderService(home(), new UserQuestionService(), {})
    try {
      const at = Date.now()
      ;(service as unknown as { probeResult: unknown }).probeResult = { at, result: { kind: 'signed_in', planType: 'plus', email: 'a@example.com' } }
      const a = service.account()
      ;(service as unknown as { probeResult: unknown }).probeResult = { at, result: { kind: 'signed_in', planType: 'plus', email: 'b@example.com' } }
      const b = service.account()
      expect(a?.label).toBe('ChatGPT Plus')
      expect(b?.label).toBe('ChatGPT Plus')
      expect(a?.subject).not.toBe(b?.subject)
      ;(service as unknown as { probeResult: unknown }).probeResult = { at, result: { kind: 'signed_in', planType: 'plus', email: null } }
      expect(service.account()?.subject).toBeUndefined()
    } finally {
      service.stop()
    }
  })
})

describe('gateway account state', () => {
  it('hashes the subject with a per-profile salt and the home; the snapshot never carries the subject', async () => {
    const first = new InstanceCounterStore(home())
    const second = new InstanceCounterStore(home())
    expect(first.accountIdentity('default', 'user-a')).toBe(first.accountIdentity('default', 'user-a'))
    expect(first.accountIdentity('default', 'user-a')).not.toBe(first.accountIdentity('private:claude:work', 'user-a'))
    expect(first.accountIdentity('default', 'user-a')).not.toBe(second.accountIdentity('default', 'user-a'))

    let subject = 'claude.ai:user-a:org-1'
    const adapter = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    const claude = adapterDriver({ ...adapter, driver: 'claude', startTurn: adapter.startTurn.bind(adapter), interrupt: adapter.interrupt.bind(adapter) }, {
      runtime: { auth: async () => ({ state: 'signed_in', account: { label: 'Claude Max' }, subject }), forgetConversation: () => {} }
    })
    let stored: unknown = { claude: { driver: 'claude', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const profileHome = home()
    const harness = testHarness({ drivers: [claude], instances, profileHome })
    try {
      const before = await harness.instances.recheck('claude')
      // Same plan and organization, another user: the generation moves on.
      subject = 'claude.ai:user-b:org-1'
      const after = await harness.instances.recheck('claude')
      expect(before.auth.account?.label).toBe(after.auth.account?.label)
      expect(before.auth.account?.id).not.toBe(after.auth.account?.id)
      expect(JSON.stringify(after)).not.toContain('user-b')
      expect(new InstanceCounterStore(profileHome).get('claude').accountGeneration).toBe(1)
    } finally {
      harness.stop()
    }
  })
})
