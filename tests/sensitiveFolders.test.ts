import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sensitiveFolderHolding,
  sensitiveFolders,
  type FolderRuleEnvironment
} from '../src/mms/files/sensitiveFolders'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const listed = (environment: FolderRuleEnvironment) =>
  sensitiveFolders(environment).map((entry) => entry.path)

describe('the folders another computer may not open as a project', () => {
  it('are the credential and settings folders under the home folder, wherever the tools are told to keep them', () => {
    const linux = listed({ platform: 'linux', home: '/home/me', env: {} })
    expect(linux).toEqual(
      expect.arrayContaining([
        '/home/me/.ssh',
        '/home/me/.gnupg',
        '/home/me/.aws',
        '/home/me/.kube',
        '/home/me/.docker',
        '/home/me/.config/gh',
        '/home/me/.config/gcloud'
      ])
    )
    const moved = listed({
      platform: 'linux',
      home: '/home/me',
      env: { GNUPGHOME: '/keys/gnupg', DOCKER_CONFIG: '/cfg/docker', XDG_CONFIG_HOME: '/xdg', GH_CONFIG_DIR: '/cfg/gh' }
    })
    expect(moved).toEqual(expect.arrayContaining(['/keys/gnupg', '/cfg/docker', '/cfg/gh', '/xdg/gcloud']))
    expect(moved).not.toContain('/home/me/.gnupg')
  })

  it("include the operating system's keychains and the folders browsers keep sign-ins in", () => {
    expect(listed({ platform: 'darwin', home: '/Users/me', env: {} })).toEqual(
      expect.arrayContaining([
        '/Users/me/Library/Keychains',
        '/Library/Keychains',
        '/System/Library/Keychains',
        '/Users/me/Library/Application Support/Google/Chrome',
        '/Users/me/Library/Safari'
      ])
    )
    expect(listed({ platform: 'linux', home: '/home/me', env: {} })).toEqual(
      expect.arrayContaining([
        '/home/me/.local/share/keyrings',
        '/home/me/.local/share/kwalletd',
        '/home/me/.config/google-chrome',
        '/home/me/.mozilla'
      ])
    )
    expect(
      listed({
        platform: 'win32',
        home: 'C:\\Users\\me',
        env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' }
      })
    ).toEqual(
      expect.arrayContaining([
        'C:\\Users\\me\\.ssh',
        'D:\\Roaming\\Microsoft\\Credentials',
        'D:\\Local\\Microsoft\\Credentials',
        'D:\\Roaming\\Microsoft\\Protect',
        'D:\\Roaming\\Microsoft\\Vault',
        'D:\\Roaming\\GitHub CLI',
        'D:\\Local\\Google\\Chrome\\User Data',
        'D:\\Local\\Microsoft\\Edge\\User Data'
      ])
    )
    // Where Windows does not say, the usual folders under the home folder stand in.
    expect(listed({ platform: 'win32', home: 'C:\\Users\\me', env: {} })).toContain(
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials'
    )
  })

  describe('as a folder is checked', () => {
    function fake() {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-')))
      cleanups.push(() => rmSync(base, { recursive: true, force: true }))
      const home = join(base, 'home')
      for (const name of ['.ssh/keys', '.config/gh', '.config/nvim', '.sshx', 'code/project']) mkdirSync(join(home, name), { recursive: true })
      const environment: FolderRuleEnvironment = { platform: process.platform, home, env: {} }
      const holding = (...folders: string[]) => sensitiveFolderHolding(folders, environment)
      return { base, home, holding }
    }

    it('refuses a folder in the list, a folder inside one, and every folder that holds one', () => {
      const { base, home, holding } = fake()
      expect(holding(join(home, '.ssh'))).toBe('SSH keys')
      expect(holding(join(home, '.ssh', 'keys'))).toBe('SSH keys')
      expect(holding(join(home, '.config', 'gh'))).toBe('GitHub CLI sign-in')
      // The home folder, and what is above it, hold the credentials folders.
      for (const holder of [join(home, '.config'), home, base, tmpdir()]) expect(holding(holder), holder).toBeTruthy()
    })

    it('leaves alone folders that only start like one or sit beside one', () => {
      const { home, holding } = fake()
      for (const folder of [join(home, '.sshx'), join(home, '.config', 'nvim'), join(home, 'code', 'project')])
        expect(holding(folder), folder).toBeUndefined()
    })

    it('sees a folder by what it really is, so a link cannot stand in for it', () => {
      const { base, home, holding } = fake()
      const link = join(base, 'innocent')
      symlinkSync(join(home, '.ssh'), link, process.platform === 'win32' ? 'junction' : 'dir')
      // The caller passes the folder as given and as it really is.
      expect(holding(link, realpathSync(link))).toBe('SSH keys')
      // A credentials folder that is itself a link leads to a folder that is just as sensitive.
      const store = join(base, 'dotfiles', 'aws')
      mkdirSync(store, { recursive: true })
      symlinkSync(store, join(home, '.aws'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(holding(store, realpathSync(store))).toBe('AWS credentials')
    })

    it('folds case where the file system does', () => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') return
      const { home, holding } = fake()
      expect(holding(join(home, '.ssh').toUpperCase())).toBe('SSH keys')
    })
  })
})
