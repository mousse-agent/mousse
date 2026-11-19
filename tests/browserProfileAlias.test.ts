import { describe, expect, it } from 'vitest'
import { profileAliasPath } from '../src/browser-worker/cdp/launch'

// Chrome on Windows exits as it starts on a profile folder past about 240 characters (seen with Chrome 158 in a
// worktree's dev home: a bot's profile at 242 characters ended with "CDP pipe ended", the same at 239 started).
const deep = 'C:\\Users\\me\\.mousse\\repositories\\0123456789abcdef0123456789abcdef\\worktrees\\threads\\11111111-2222-4333-8444-555555555555\\main\\.mousse-dev\\runtime\\browser\\user-data\\aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\\workspaces\\botbrowser_bot-0a1b2c3d4e5f'
const usual = 'C:\\Users\\me\\.mousse\\browser\\user-data\\aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\\workspaces\\botbrowser_bot-0a1b2c3d4e5f'
const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

describe('the short name Chrome is given for a profile folder', () => {
  it.each([
    ['a deep home on Windows', deep, 'win32', env, true],
    ['the usual home on Windows', usual, 'win32', env, false],
    ['a deep home elsewhere', deep, 'darwin', env, false],
    ['Windows without LOCALAPPDATA', deep, 'win32', {}, false]
  ] as const)('%s', (_name, folder, platform, environment, aliased) => {
    const alias = profileAliasPath(folder, platform, environment)
    if (!aliased) return expect(alias).toBeUndefined()
    expect(alias!.startsWith(`${env.LOCALAPPDATA}\\`)).toBe(true)
    expect(alias!.length).toBeLessThan(80)
  })

  it('is the same for one folder every time, and differs between folders', () => {
    expect(profileAliasPath(deep, 'win32', env)).toBe(profileAliasPath(deep.toUpperCase(), 'win32', env))
    expect(profileAliasPath(deep, 'win32', env)).not.toBe(profileAliasPath(`${deep}x`, 'win32', env))
  })
})
