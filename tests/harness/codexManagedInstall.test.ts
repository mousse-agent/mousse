/**
 * The managed Codex install as the runtime and the probe see it: a broken install (changed files,
 * a version other than the pin) never launches until a check passes or a reinstall fixes it, and
 * its folders never mix with registry agents'.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentInstalls } from '../../src/mms/harness/agents/install'
import { agentView, RESERVED_AGENT_IDS, type RegistryAgent } from '../../src/mms/harness/agents/registry'
import { ChatGptAuth } from '../../src/mms/harness/chatgpt/chatgptAuth'
import { ChatGptTokenBroker } from '../../src/mms/harness/vendors/codex/broker'
import { ACTIVE_FILE, CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { createManagedCodexRuntime } from '../../src/mms/harness/vendors/codex/managedRuntime'
import { CODEX_MANAGED_VERSION, type CodexRelease } from '../../src/mms/harness/vendors/codex/release'
import type { DriverContext } from '../../src/mms/harness/driver'
import { decodeRegistrySource } from '../../src/mms/harness/drivers/acp'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { instanceEnv } from '../../src/mms/harness/env'
import { probeInstance } from '../../src/mms/harness/status'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { CodexLaunch, CodexProcess } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import type { CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { asInstanceConfigPatch } from '../../src/mms/protocol/validators'
import { tarGzOf, type ArchiveEntry } from './archiveFixtures'
import { plainCodec } from './chatgpt/fakeIssuer'

const TARGET = 'x86_64-unknown-linux-musl'
const URL = `https://github.com/openai/codex/releases/download/rust-v${CODEX_MANAGED_VERSION}/codex-package-${TARGET}.tar.gz`

const entries: ArchiveEntry[] = [
  { name: 'bin/', type: '5' },
  { name: 'bin/codex', data: '#!/bin/sh\necho codex\n', mode: 0o755 },
  { name: 'bin/codex-code-mode-host', data: 'host', mode: 0o755 },
  { name: 'codex-package.json', data: JSON.stringify({ layoutVersion: 1, version: CODEX_MANAGED_VERSION, target: TARGET, variant: 'codex', entrypoint: 'bin/codex' }) },
  { name: 'codex-path/', type: '5' },
  { name: 'codex-path/rg', data: 'rg', mode: 0o755 }
]
const archive = tarGzOf(entries)
const release: CodexRelease = { version: CODEX_MANAGED_VERSION, target: TARGET, url: URL, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), windows: false }
const fakeFetch = (async (input: string | URL | Request) =>
  String(input) === URL ? new Response(new Uint8Array(archive), { status: 200, headers: { 'content-length': String(archive.length) } }) : new Response('missing', { status: 404 })) as typeof fetch

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-managed-install-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Starts the app-server as a turn would (the service's own launch path). */
const launchNow = (service: CodexProviderService): Promise<unknown> => (service as unknown as { connection: () => Promise<unknown> }).connection()

function installation(): CodexInstallation {
  return new CodexInstallation({ installationHome: join(home, 'installation'), release, fetch: fakeFetch, runVersion: async () => `codex-cli ${CODEX_MANAGED_VERSION}\n` })
}

/** A managed runtime over a real installation; its launches are recorded and never spawn anything. */
function setup() {
  const install = installation()
  const profileHome = join(home, 'profile')
  const stateDir = join(profileHome, 'harness', 'codex-managed')
  const env = instanceEnv({ instanceId: 'codex:managed', driver: 'codex', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base: { PATH: '' } })
  const questions = new UserQuestionService()
  const context: DriverContext = {
    instanceId: 'codex:managed', builtIn: false, config: { home: 'private', setup: 'managed' }, env, profileHome,
    installationHome: join(home, 'installation'), stateDir, questions, findBinary: () => undefined, changed: () => {}
  }
  const launches: CodexLaunch[] = []
  const broker = new ChatGptTokenBroker()
  const runtime = createManagedCodexRuntime(context, {
    installation: install,
    broker,
    auth: (options) => new ChatGptAuth({ ...options, codec: plainCodec }),
    service: {
      launch: (launch): CodexProcess => {
        launches.push(launch)
        throw new Error('no app-server in this test')
      }
    }
  })
  const service = (runtime.adapter as unknown as { service: () => CodexProviderService }).service()
  const driver = codexDriver({ builtIn: () => service })
  const probe = () => probeInstance({ driver, runtime, env, config: context.config, force: true })
  const cleanup = async () => {
    runtime.stop()
    questions.shutdown()
    await broker.close()
  }
  return { install, runtime, service, launches, probe, cleanup }
}

describe('a broken managed Codex install never runs', () => {
  it('a file changed since install is broken after the check, refused at launch, and cleared by a reinstall', async () => {
    const { install, runtime, service, launches, probe, cleanup } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runtime.install!(() => {})
      expect(runtime.managed!()?.broken).toBeUndefined()
      expect((await probe()).install).toBe('installed')
      writeFileSync(join(install.dir, CODEX_MANAGED_VERSION, 'codex-path', 'rg'), 'changed')
      await runtime.verifyInstall!(new AbortController().signal)
      expect(runtime.managed!()?.broken).toMatch(/changed since install/)
      // The probe runs the check itself (Recheck) and reports the install broken.
      const checked = await probe()
      expect(checked.install).toBe('broken')
      expect(checked.runs.state).toBe('no')
      // No launch: the binary is not offered and the launch check refuses.
      await expect(launchNow(service)).rejects.toThrow(/not installed|not found|Reinstall/i)
      expect(launches).toEqual([])
      // A reinstall replaces the files and clears it.
      await runtime.install!(() => {})
      expect(runtime.managed!()?.broken).toBeUndefined()
      expect(readFileSync(join(install.dir, CODEX_MANAGED_VERSION, 'codex-path', 'rg'), 'utf8')).toBe('rg')
      expect((await probe()).install).toBe('installed')
    } finally {
      warn.mockRestore()
      await cleanup()
    }
  })

  it('an active.json naming another version is broken and never launched', async () => {
    const { install, runtime, service, launches, probe, cleanup } = setup()
    try {
      await runtime.install!(() => {})
      writeFileSync(join(install.dir, ACTIVE_FILE), JSON.stringify({ version: '0.170.0', target: TARGET, sha256: release.sha256 }))
      expect(runtime.managed!()?.broken).toMatch(/not 0\.170\.0/)
      expect((await probe()).install).toBe('broken')
      await expect(launchNow(service)).rejects.toThrow(/not installed|not found|Reinstall/i)
      expect(launches).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('managed Codex and registry agents keep apart', () => {
  it('the managed install lives outside agents/, and removing it leaves registry agents alone', async () => {
    const install = installation()
    // Registry trees, as AgentInstalls lays them out.
    const registryFile = join(home, 'installation', 'agents', 'codex-acp', '1.0.0', 'linux-x86_64', 'dist', 'bin', 'codex-acp')
    mkdirSync(join(registryFile, '..'), { recursive: true })
    writeFileSync(registryFile, 'registry agent')
    await install.install(() => {})
    expect(install.dir).toBe(join(home, 'installation', 'managed', 'codex'))
    expect(install.installed()?.path.startsWith(join(home, 'installation', 'managed', 'codex'))).toBe(true)
    expect(existsSync(join(home, 'installation', 'agents', 'codex'))).toBe(false)
    await expect(install.removeInstall({ force: true })).resolves.toMatchObject({ removed: true })
    expect(readFileSync(registryFile, 'utf8')).toBe('registry agent')
  })

  it('a registry agent with a reserved id is listed with why, and can never be added or installed', () => {
    expect(RESERVED_AGENT_IDS.has('codex')).toBe(true)
    const agent: RegistryAgent = {
      id: 'codex', name: 'Codex', version: '1.0.0', description: '', authors: [],
      distribution: { binary: { 'linux-x86_64': { archive: 'https://github.com/x/y/releases/download/v1/codex.tar.gz', cmd: './codex', args: [], env: {} } } }
    }
    expect(agentView(agent, ['linux-x86_64'])?.unsupported).toMatch(/its own entry/)
    expect(() => asInstanceConfigPatch({ source: { kind: 'registry', agentId: 'codex', version: '1.0.0', distribution: 'binary' } })).toThrow(/its own entry/)
    expect(decodeRegistrySource({ kind: 'registry', agentId: 'codex', version: '1.0.0', distribution: 'binary' })).toBeUndefined()
    const installs = new AgentInstalls({ installationHome: join(home, 'installation'), profileId: 'p1', registry: { agent: async () => agent, cached: () => [agent] } })
    expect(() => installs.installed({ kind: 'registry', agentId: 'codex', version: '1.0.0', distribution: 'binary' })).toThrow(/its own entry/)
    // Other ids are unchanged.
    expect(asInstanceConfigPatch({ source: { kind: 'registry', agentId: 'codex-acp', version: '1.0.0', distribution: 'binary' } }).source?.agentId).toBe('codex-acp')
  })
})
