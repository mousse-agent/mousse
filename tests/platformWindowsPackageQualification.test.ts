import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FrameDecoder,
  lastJson,
  parseJsonLines,
  parseRunnerArgs,
  plantLegacyHome,
  PROTOCOL_VERSION,
  LEGACY_THREAD_ID,
  LEGACY_AUTH_KEY
} from '../scripts/qualification/windows/windowsPackageQualification.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-q04-win-'))
  roots.push(root)
  return root
}

describe('Windows package qualification helpers', () => {
  it('round-trips length-prefixed protocol frames used by the fixture client', () => {
    const hello = {
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      ownerToken: 'abc',
      clientType: 'cli',
      requestedCapabilities: ['profiles-v1']
    }
    const decoder = new FrameDecoder()
    decoder.push(encodeFrame(hello))
    decoder.push(encodeFrame({ kind: 'hello_ok', protocolVersion: 1, instanceId: 'x', capabilities: ['pty'], globalSequence: 0 }))
    expect(decoder.shiftAll()).toEqual([
      hello,
      { kind: 'hello_ok', protocolVersion: 1, instanceId: 'x', capabilities: ['pty'], globalSequence: 0 }
    ])
  })

  it('plants a legacy personal config/thread/shared-credential home without a live key', () => {
    const home = join(tempRoot(), 'home')
    const planted = plantLegacyHome(home)
    expect(planted.threadId).toBe(LEGACY_THREAD_ID)
    const conf = JSON.parse(readFileSync(planted.confPath, 'utf8'))
    expect(conf.settings.profile.username).toBe('legacy-user')
    expect(conf.providers.llmProvider).toBe('openrouter')
    expect(conf.scheduled.jobs).toEqual([
      expect.objectContaining({
        id: 'job-1',
        schedule: { kind: 'once', runAt: '2099-01-01T09:00:00.000Z' },
        enabled: false,
        state: 'paused',
        nextRunAt: null
      })
    ])
    const auth = JSON.parse(readFileSync(planted.authPath, 'utf8'))
    expect(auth.openai).toEqual({ type: 'api_key', key: LEGACY_AUTH_KEY })
    expect(JSON.parse(readFileSync(planted.transcriptPath, 'utf8')).id).toBe(LEGACY_THREAD_ID)
  })

  it('parses packaged CLI JSON lines and runner flags', () => {
    expect(parseJsonLines('not json\n{"started":true,"pid":12}\n')).toEqual([{ started: true, pid: 12 }])
    expect(lastJson('{"a":1}\n{"b":2}\n')).toEqual({ b: 2 })
    expect(parseRunnerArgs(['--package', 'D:\\win-unpacked', '--work-root', 'D:\\q04'])).toEqual({
      packageDir: 'D:\\win-unpacked',
      workRoot: 'D:\\q04'
    })
    expect(() => parseRunnerArgs(['--unknown'])).toThrow(/Unknown argument/)
  })
})
