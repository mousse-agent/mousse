import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceEnv } from '../../src/mms/harness/env'
import { ownerUpdateLaunch, wingetHasNoUpgrade, withUpdateEnv } from '../../src/mms/harness/ownerUpdate'

const noPath = { env: { PATH: '' }, searchPath: [] }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('owner update command', () => {
  it('runs the CLI\'s own updater with the executable the instance runs, not another copy on PATH', () => {
    // `node` stands in for the CLI: its executable is the resolved binary.
    const resolved = ownerUpdateLaunch('node update --yes', { path: process.execPath }, noPath)
    expect(resolved?.launch.command).toBe(process.execPath)
    expect(resolved?.args).toEqual(['update', '--yes'])
  })

  it('finds nothing to run when the owner\'s program is not on PATH', () => {
    expect(ownerUpdateLaunch('mousse-no-such-updater upgrade x', { path: process.execPath }, noPath)).toBeUndefined()
    expect(ownerUpdateLaunch('  ', undefined, noPath)).toBeUndefined()
  })

  it('runs Scoop\'s own script with PowerShell, from the Scoop folder the executable sits in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-scoop-'))
    dirs.push(dir)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const powershell = join(bin, 'powershell.exe')
    writeFileSync(powershell, '')
    chmodSync(powershell, 0o755)
    const script = join(dir, 'scoop', 'apps', 'scoop', 'current', 'bin', 'scoop.ps1')
    mkdirSync(join(script, '..'), { recursive: true })
    writeFileSync(script, '')
    const env = { env: { PATH: '' }, searchPath: [bin] }
    const resolved = ownerUpdateLaunch('scoop update codex', { path: join(dir, 'scoop', 'shims', 'codex.exe') }, env, 'win32')
    expect(resolved?.launch.command).toBe(powershell)
    expect([...resolved!.launch.args, ...resolved!.args]).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'update', 'codex'])
    // No Scoop script anywhere: nothing to run.
    expect(ownerUpdateLaunch('scoop update codex', { path: join(dir, 'elsewhere', 'codex.exe') }, { ...env, env: { PATH: '', USERPROFILE: bin } }, 'win32')).toBeUndefined()
  })

  it('sets the update\'s own variables over the entry\'s, also over those it enforces, whatever their case', () => {
    const env = {
      instanceId: 'codex:work', driver: 'codex', configRevision: 1, homeId: 'private:codex:work', searchPath: [],
      env: { codex_home: '/private/work', PATH: '/bin' },
      enforced: { CODEX_HOME: '/private/work', CODEX_SQLITE_HOME: '/private/work' }
    } as unknown as InstanceEnv
    const next = withUpdateEnv(env, { CODEX_HOME: '/Users/me/.codex' })
    expect(next.env).toEqual({ PATH: '/bin', CODEX_HOME: '/Users/me/.codex' })
    expect(next.enforced).toEqual({ CODEX_SQLITE_HOME: '/private/work' })
    expect(withUpdateEnv(env, undefined)).toBe(env)
  })

  it('tells WinGet having no newer package from a failed update', () => {
    const winget = 'winget upgrade --id OpenAI.Codex --exact'
    // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE, as Node reports it either way, or WinGet's own words.
    expect(wingetHasNoUpgrade(winget, 0x8a15002b, '')).toBe(true)
    expect(wingetHasNoUpgrade(winget, -1978335189, '')).toBe(true)
    expect(wingetHasNoUpgrade(winget, 0, 'No available upgrade found.\nNo newer package versions are available from the configured sources.')).toBe(true)
    expect(wingetHasNoUpgrade(winget, 1, 'Installer failed with exit code: 1603')).toBe(false)
    expect(wingetHasNoUpgrade('npm install -g @openai/codex@latest', 0x8a15002b, '')).toBe(false)
  })
})
