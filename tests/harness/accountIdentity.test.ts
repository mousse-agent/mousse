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
import { claudeAccountSubject } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
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
  it('tells two claude.ai users of one organization apart, from the home Claude Code reads', () => {
    const read = (files: Record<string, string>) => (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    }
    const env = { CLAUDE_CONFIG_DIR: '/homes/work' }
    const a = claudeAccountSubject({ authMethod: 'claude.ai' }, env, read({ [join('/homes/work', '.claude.json')]: claudeJson('user-a') }))
    const b = claudeAccountSubject({ authMethod: 'claude.ai' }, env, read({ [join('/homes/work', '.claude.json')]: claudeJson('user-b') }))
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
    // No account recorded in the home: unknown, never a shared placeholder.
    expect(claudeAccountSubject({ authMethod: 'claude.ai' }, env, read({}))).toBeUndefined()
    expect(claudeAccountSubject({ authMethod: 'claude.ai' }, env, read({ [join('/homes/work', '.claude.json')]: '{}' }))).toBeUndefined()
  })

  it('keys a token or key sign-in by its credential, without exposing it', () => {
    const one = claudeAccountSubject({ authMethod: 'oauth_token', apiProvider: 'firstParty' }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-one' })
    const two = claudeAccountSubject({ authMethod: 'oauth_token', apiProvider: 'firstParty' }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-two' })
    expect(one).not.toBe(two)
    expect(one).not.toContain('sk-ant')
    // A method whose credential Mousse cannot see is unknown.
    expect(claudeAccountSubject({ authMethod: 'api_key' }, {})).toBeUndefined()
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
      expect(a?.label).toBe(b?.label)
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
