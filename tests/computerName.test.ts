import { describe, expect, it } from 'vitest'
import { chooseComputerName, resolveComputerName, stripLocalSuffix } from '../src/main/computerName'

const base = { platform: 'darwin' as const, env: {}, hostname: () => 'Avarnics-Mac-mini.local' }

describe('computer name', () => {
  it('strips the .local suffix from a hostname', () => {
    expect(stripLocalSuffix('Avarnics-Mac-mini.local')).toBe('Avarnics-Mac-mini')
    expect(stripLocalSuffix('box.LOCAL.')).toBe('box')
    expect(stripLocalSuffix('build.example.com')).toBe('build.example.com')
  })

  it('prefers the name the system reports on macOS and Linux', () => {
    expect(chooseComputerName({ platform: 'darwin', env: {}, hostname: 'x.local', lookup: "Avarnic's Mac mini\n" }))
      .toBe("Avarnic's Mac mini")
    expect(chooseComputerName({ platform: 'linux', env: {}, hostname: 'x', lookup: 'Work laptop\n' })).toBe('Work laptop')
  })

  it('uses COMPUTERNAME on Windows, then the hostname', () => {
    expect(chooseComputerName({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-1' }, hostname: 'desktop-1.lan' })).toBe('DESKTOP-1')
    expect(chooseComputerName({ platform: 'win32', env: {}, hostname: 'desktop-1.lan' })).toBe('desktop-1.lan')
  })

  it('falls back to the hostname without .local when the system gives nothing', () => {
    expect(chooseComputerName({ platform: 'darwin', env: {}, hostname: 'Avarnics-Mac-mini.local', lookup: '  \n' })).toBe('Avarnics-Mac-mini')
    expect(chooseComputerName({ platform: 'linux', env: {}, hostname: 'box', lookup: undefined })).toBe('box')
  })

  it('removes control characters and keeps at most 64 characters', () => {
    expect(chooseComputerName({ platform: 'darwin', env: {}, hostname: 'h', lookup: 'Mac\u0007\tmini' })).toBe('Mac mini')
    expect(Array.from(chooseComputerName({ platform: 'darwin', env: {}, hostname: 'h', lookup: 'é'.repeat(100) }))).toHaveLength(64)
  })

  it('asks scutil on macOS and hostnamectl on Linux', async () => {
    const calls: string[][] = []
    const run = async (file: string, args: string[]) => { calls.push([file, ...args]); return 'Pretty name\n' }
    await expect(resolveComputerName({ ...base, run })).resolves.toBe('Pretty name')
    await expect(resolveComputerName({ ...base, platform: 'linux', run })).resolves.toBe('Pretty name')
    await expect(resolveComputerName({ ...base, platform: 'win32', env: { COMPUTERNAME: 'PC' }, run })).resolves.toBe('PC')
    expect(calls).toEqual([['scutil', '--get', 'ComputerName'], ['hostnamectl', '--pretty']])
  })

  it('falls back to the hostname when the lookup fails or times out', async () => {
    const run = async () => { throw new Error('ETIMEDOUT') }
    await expect(resolveComputerName({ ...base, run })).resolves.toBe('Avarnics-Mac-mini')
  })
})
