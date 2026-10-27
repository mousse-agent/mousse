/**
 * A profile wired as `MmsProfileServices` wires it: the built-in Claude Code, Codex and Antigravity
 * services read their launch settings and sign-out from the instance config (the gateway's), and
 * the instance map seeds built-ins from their vendor files. `start()` is one Mousse start on the
 * same home and profile config, so a test can stop it and start again, or edit the files between.
 * No CLI, agent or network is reached: sign-in checks and model lists are fakes.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { vi } from 'vitest'
import { antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type Harness } from '../../src/mms/harness/gateway'
import { ALL_MIRROR_FIELDS, LAUNCH_MIRROR_FIELDS } from '../../src/mms/harness/vendorMirror'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../src/mms/providers/antigravity/AntigravityProviderService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { createCodexProviderService, type CodexAccountReading } from '../../src/mms/providers/codex/CodexProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { CliProviderConfigPatch } from '../../src/shared/providerAuth'

/** The profile config's `providers` section, kept across starts. */
export interface ProfileStore {
  instances: unknown
  seedVersion?: number
  /** Every write of the instance map, in order. */
  writes: Array<{ instances: Record<string, unknown>; seedVersion: number }>
  /** The profile config cannot be read (reads throw). */
  unreadable?: boolean
}

export const VENDOR_DIRS = {
  claude: ['providers', 'claude-subscription'],
  codex: ['providers', 'codex'],
  antigravity: ['providers', 'antigravity']
} as const
export type Vendor = keyof typeof VENDOR_DIRS

export function tempHome(prefix = 'mousse-vendor-mirror-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function settingsPath(home: string, vendor: Vendor): string {
  return join(home, ...VENDOR_DIRS[vendor], 'settings.json')
}

/** Writes a vendor `settings.json` as an older Mousse left it (an object, or raw text). */
export function writeVendor(home: string, vendor: Vendor, settings: Record<string, unknown> | string): void {
  mkdirSync(join(home, ...VENDOR_DIRS[vendor]), { recursive: true })
  writeFileSync(settingsPath(home, vendor), typeof settings === 'string' ? settings : JSON.stringify(settings))
}

export function readVendorText(home: string, vendor: Vendor): string {
  return readFileSync(settingsPath(home, vendor), 'utf8')
}

export function readVendor(home: string, vendor: Vendor): Record<string, unknown> {
  return JSON.parse(readVendorText(home, vendor)) as Record<string, unknown>
}

/** An executable file the launch-settings checks accept; nothing runs it to a result that matters. */
export function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true })
}

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })

function fakeQuery(): Query {
  return Object.assign((async function* () {})(), {
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    supportedModels: vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet', description: '' }])
  }) as unknown as Query
}

export interface StartedProfile {
  harness: Harness
  instanceMap: ProviderInstanceService
  claude: ClaudeSubscriptionProviderService
  codex: ReturnType<typeof createCodexProviderService>
  antigravity: AntigravityProviderService
  /** `claude auth status` runs (none spawn). */
  claudeAuth: ReturnType<typeof vi.fn>
  /** Codex account reads (none start an app-server). */
  codexAccount: ReturnType<typeof vi.fn>
  questions: UserQuestionService
  stop(): void
}

/** One start of Mousse on `home` with the profile config `store`. */
export function startProfile(home: string, store: ProfileStore): StartedProfile {
  const questions = new UserQuestionService()
  let harness: Harness | undefined
  const launchOf = (instanceId: string) => () => harness?.launchFor(instanceId) ?? {}
  const signedOutOf = (instanceId: string) => () => harness?.signedOutInMousse(instanceId) ?? false
  const saveLaunchOf = (instanceId: string) => async (patch: CliProviderConfigPatch) => {
    if (!harness) throw new Error('not started')
    await harness.instances.configure(instanceId, patch)
  }
  const claudeAuth = vi.fn(async () => SIGNED_IN)
  const claude = new ClaudeSubscriptionProviderService(home, questions, {
    findBinary: () => undefined,
    runAuth: claudeAuth,
    query: () => fakeQuery(),
    live: false,
    launchConfig: launchOf('claude'),
    signedOut: signedOutOf('claude'),
    saveLaunch: saveLaunchOf('claude')
  })
  const codexAccount = vi.fn(async (): Promise<CodexAccountReading> => ({ kind: 'signed_in', planType: 'plus', email: 'me@example.com' }))
  const codex = createCodexProviderService(home, questions, {
    findBinary: () => undefined,
    launch: () => {
      throw new Error('tests never start a Codex app-server')
    }
  }, {
    launch: launchOf('codex'),
    signedOut: signedOutOf('codex'),
    saveLaunch: saveLaunchOf('codex'),
    account: { read: codexAccount },
    models: { list: async () => [{ id: 'gpt-x', label: 'GPT X' }] }
  })
  const antigravity = new AntigravityProviderService(home, home, questions, undefined, {
    launch: launchOf('antigravity'),
    saveLaunch: saveLaunchOf('antigravity'),
    connect: () => {
      throw new Error('tests never start Antigravity')
    }
  })
  const instanceMap = new ProviderInstanceService({
    store: {
      read: () => {
        if (store.unreadable) throw new Error('The profile config could not be read')
        return { instances: store.instances, seedVersion: store.seedVersion }
      },
      write: (next) => {
        store.writes.push(next)
        store.instances = next.instances
        store.seedVersion = next.seedVersion
      }
    },
    mirrorFor: (instanceId) =>
      instanceId === 'claude' ? claude.vendorMirror(ALL_MIRROR_FIELDS)
        : instanceId === 'codex' ? codex.vendorMirror(ALL_MIRROR_FIELDS)
          : instanceId === 'antigravity' ? antigravity.vendorMirror(LAUNCH_MIRROR_FIELDS)
            : undefined
  })
  instanceMap.list()
  harness = createHarnessGateway({
    profileHome: home,
    installationHome: home,
    instanceMap,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    // No registry lookups.
    latest: { get: () => undefined, refresh: async () => false } as never,
    drivers: [
      piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) as never }),
      claudeCodeDriver({ builtIn: () => claude }),
      codexDriver({ builtIn: () => codex }),
      antigravityDriver({ builtIn: () => antigravity })
    ]
  })
  const started = harness
  return {
    harness: started,
    instanceMap,
    claude,
    codex,
    antigravity,
    claudeAuth,
    codexAccount,
    questions,
    stop: () => {
      started.stop()
      claude.stop()
      codex.stop()
      antigravity.stop()
      questions.shutdown()
    }
  }
}

/** The stored config of one instance (what the profile config holds now). */
export function storedConfig(store: ProfileStore, instanceId: string): Record<string, unknown> {
  const entry = (store.instances as Record<string, { config?: Record<string, unknown> }> | undefined)?.[instanceId]
  return { ...(entry?.config ?? {}) }
}
