import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkHostTrust,
  judgeWindowsReport,
  parseSddl,
  rightsMask,
  untrustedBecause,
  windowsScript
} from '../../../src/mms/net/editor/hostTrust'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// What the system reports for a plain OpenSSH Server install: SYSTEM and Administrators own and change the
// folder and its keys, and authenticated users may read the public keys.
const ADMIN_OWNED = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)'
const FILE_ACL = 'O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;AU)'
const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'

describe('reading a security descriptor', () => {
  it('finds the owner and each allow entry', () => {
    expect(parseSddl(ADMIN_OWNED)).toEqual({
      owner: 'BA',
      aces: [
        { type: 'A', flags: 'OICI', rights: 'FA', sid: 'SY' },
        { type: 'A', flags: 'OICI', rights: 'FA', sid: 'BA' },
        { type: 'A', flags: 'OICI', rights: '0x1200a9', sid: 'AU' }
      ]
    })
    expect(parseSddl(`O:${USER_SID}G:SYD:(A;;FA;;;${USER_SID})`).owner).toBe(USER_SID)
    // An audit section is not part of the access list.
    expect(parseSddl('O:BAG:SYD:(A;;FA;;;SY)S:(AU;SA;FA;;;WD)').aces).toHaveLength(1)
  })

  it('knows the rights, in letters and in hex', () => {
    expect(rightsMask('FA')).toBe(0x1f01ff)
    expect(rightsMask('FRFX')).toBe(0x120089 | 0x1200a0)
    expect(rightsMask('0x1200a9')).toBe(0x1200a9)
    expect(rightsMask('GR')).toBe(0x80000000)
    expect(rightsMask('ZZ')).toBeUndefined()
    expect(rightsMask('F')).toBeUndefined()
    expect(rightsMask('')).toBeUndefined()
  })
})

describe('which files can be trusted', () => {
  it('trusts what SYSTEM, Administrators or TrustedInstaller own and only they can change', () => {
    expect(untrustedBecause(ADMIN_OWNED)).toBeUndefined()
    expect(untrustedBecause(FILE_ACL)).toBeUndefined()
    expect(untrustedBecause(`O:${TRUSTED_INSTALLER}G:SYD:(A;;FA;;;SY)(A;;FR;;;BU)`)).toBeUndefined()
    expect(untrustedBecause('O:SYG:SYD:(A;;FA;;;SY)')).toBeUndefined()
    expect(
      untrustedBecause('O:S-1-5-18G:SYD:(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)')
    ).toBeUndefined()
  })

  it('does not trust a file that another account owns', () => {
    expect(untrustedBecause(`O:${USER_SID}G:SYD:(A;;FA;;;SY)(A;;FA;;;BA)`)).toMatch(
      /owned by an account/u
    )
    expect(untrustedBecause('O:BUG:SYD:(A;;FA;;;SY)')).toMatch(/owned by an account/u)
    expect(untrustedBecause('G:SYD:(A;;FA;;;SY)')).toMatch(/owner/u)
  })

  it.each([
    ['Users can write', '(A;OICI;FW;;;BU)'],
    ['Authenticated Users can modify', '(A;;0x1301bf;;;AU)'],
    ['Everyone has all rights', '(A;;FA;;;WD)'],
    ['Everyone can write by the generic right', '(A;;GW;;;WD)'],
    ['a user can append', '(A;;0x4;;;BU)'],
    ['a user can delete', '(A;;SD;;;BU)'],
    ['a user can change permissions', '(A;;WD;;;BU)'],
    ['a user can take ownership', '(A;;WO;;;BU)'],
    ['a named account can write', `(A;;0x2;;;${USER_SID})`],
    ['a right that is not known', '(A;;QQ;;;BU)'],
    ['a callback entry that allows writing', '(XA;;FW;;;BU)']
  ])('does not trust a file where %s', (_name, entry) => {
    expect(untrustedBecause(`O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)${entry}`)).toMatch(
      /can change it/u
    )
  })

  it('lets other accounts read, and ignores a deny entry and an entry that only reaches what is inside', () => {
    expect(untrustedBecause('O:BAG:SYD:(A;;FA;;;SY)(A;;FR;;;WD)(A;;FRFX;;;BU)')).toBeUndefined()
    expect(untrustedBecause('O:BAG:SYD:(A;;FA;;;SY)(D;;FW;;;BU)')).toBeUndefined()
    expect(untrustedBecause('O:BAG:SYD:(A;;FA;;;SY)(A;OICIIO;FW;;;BU)')).toBeUndefined()
    // The creator-owner placeholder gets what the owner gets, and the owner is checked.
    expect(untrustedBecause('O:BAG:SYD:(A;;FA;;;SY)(A;OICIIO;FA;;;CO)')).toBeUndefined()
  })
})

const report = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    service: { state: 'Running', pid: 4242 },
    listeners: [
      { LocalAddress: '0.0.0.0', OwningProcess: 4242 },
      { LocalAddress: '::', OwningProcess: 4242 }
    ],
    items: [
      { path: 'C:\\ProgramData\\ssh', attributes: 16, sddl: ADMIN_OWNED },
      { path: 'C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub', attributes: 32, sddl: FILE_ACL }
    ],
    ...overrides
  })

describe('what the system reports about the SSH server', () => {
  it('is trusted when sshd runs and alone listens, and its folder and keys are the system’s', () => {
    expect(judgeWindowsReport(report())).toEqual({ ok: true })
    // A single listener or item may come as an object and not a list.
    expect(
      judgeWindowsReport(
        report({
          listeners: { LocalAddress: '127.0.0.1', OwningProcess: 4242 },
          items: { path: 'C:\\ProgramData\\ssh', attributes: 16, sddl: ADMIN_OWNED }
        })
      )
    ).toEqual({ ok: true })
    // A listener on another address of the computer cannot be reached through loopback and does not count.
    expect(
      judgeWindowsReport(
        report({
          listeners: [
            { LocalAddress: '127.0.0.1', OwningProcess: 4242 },
            { LocalAddress: '192.168.1.20', OwningProcess: 9999 }
          ]
        })
      )
    ).toEqual({ ok: true })
  })

  it.each([
    ['sshd is not installed', { service: null }, /not running/u],
    ['sshd is stopped', { service: { state: 'Stopped', pid: 0 } }, /not running/u],
    ['nothing listens', { listeners: [] }, /Nothing listens/u],
    [
      'another program listens on port 22',
      { listeners: [{ LocalAddress: '127.0.0.1', OwningProcess: 777 }] },
      /other than the sshd service/u
    ],
    [
      'another program listens beside sshd',
      {
        listeners: [
          { LocalAddress: '0.0.0.0', OwningProcess: 4242 },
          { LocalAddress: '127.0.0.1', OwningProcess: 777 }
        ]
      },
      /other than the sshd service/u
    ],
    ['the folder is not reported', { items: [] }, /not reported/u],
    [
      'the folder belongs to a user account',
      {
        items: [
          { path: 'C:\\ProgramData\\ssh', attributes: 16, sddl: `O:${USER_SID}G:SYD:(A;;FA;;;SY)` }
        ]
      },
      /owned by an account/u
    ],
    [
      'a key can be changed by users',
      {
        items: [
          { path: 'C:\\ProgramData\\ssh', attributes: 16, sddl: ADMIN_OWNED },
          { path: 'k.pub', attributes: 32, sddl: 'O:BAG:SYD:(A;;FA;;;SY)(A;;FW;;;BU)' }
        ]
      },
      /can change it/u
    ],
    [
      'the folder is a link',
      { items: [{ path: 'C:\\ProgramData\\ssh', attributes: 16 | 0x400, sddl: ADMIN_OWNED }] },
      /link/u
    ],
    ['an item has no permissions', { items: [{ path: 'x', attributes: 16 }] }, /could not be read/u]
  ])('is not trusted when %s', (_name, overrides, detail) => {
    const verdict = judgeWindowsReport(report(overrides))
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.detail).toMatch(detail)
  })

  it('is not trusted when the report is not a report', () => {
    for (const text of ['', 'not json', 'null', '42', '[]'])
      expect(judgeWindowsReport(text).ok).toBe(false)
  })
})

describe('asking the system', () => {
  const win = {
    platform: 'win32' as const,
    directories: ['C:\\ProgramData\\ssh'],
    systemRoot: 'C:\\Windows'
  }

  it('has nothing to check off Windows', async () => {
    for (const platform of ['linux', 'darwin'] as const)
      expect(
        await checkHostTrust({
          platform,
          directories: ['/etc/ssh'],
          run: () => Promise.reject(new Error('never'))
        })
      ).toEqual({ ok: true })
  })

  it('runs PowerShell from the system folder, as a script that reads only and writes nothing', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const verdict = await checkHostTrust({
      ...win,
      run: async (file, args) => {
        calls.push({ file, args })
        return { code: 0, stdout: report(), missing: false, timedOut: false }
      }
    })
    expect(verdict).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file.replace(/\\/gu, '/')).toBe(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const script = calls[0]!.args.at(-1)!
    expect(script).toContain("Name='sshd'")
    expect(script).toContain('Get-NetTCPConnection')
    expect(script).toContain('GetSecurityDescriptorSddlForm')
    // No private key is named, and nothing is written or run.
    expect(script).not.toMatch(
      /Set-Content|Out-File|Remove-Item|Invoke-Expression|Start-Process|Get-Content/u
    )
    expect(script).toContain('_key\\.pub$')
  })

  it('quotes the folder, whatever its name', () => {
    expect(windowsScript("C:\\Program Data\\o'ssh")).toContain("$dir = 'C:\\Program Data\\o''ssh'")
  })

  it('says no when the program is missing, fails, times out or throws', async () => {
    for (const result of [
      { code: null, stdout: '', missing: true, timedOut: false },
      { code: 1, stdout: report(), missing: false, timedOut: false },
      { code: null, stdout: '', missing: false, timedOut: true }
    ])
      expect((await checkHostTrust({ ...win, run: async () => result })).ok).toBe(false)
    expect(
      (await checkHostTrust({ ...win, run: () => Promise.reject(new Error('spawn failed')) })).ok
    ).toBe(false)
    expect(
      (
        await checkHostTrust({
          ...win,
          directories: [],
          run: async () => ({ code: 0, stdout: report(), missing: false, timedOut: false })
        })
      ).ok
    ).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'reads a real folder with the real system tools, and does not trust one an ordinary account made',
    async () => {
      const folder = await mkdtemp(join(tmpdir(), 'mousse trust '))
      cleanup.push(() => rm(folder, { recursive: true, force: true }))
      const verdict = await checkHostTrust({ directories: [folder] })
      // Whatever sshd is doing on this machine, a folder in the temp folder is not the system's own.
      expect(verdict.ok).toBe(false)
      expect(!verdict.ok && verdict.detail).not.toMatch(/could not report|did not report/u)
    },
    60_000
  )
})
