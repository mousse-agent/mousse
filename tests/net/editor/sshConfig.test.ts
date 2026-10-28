import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_SSH_NOTICE,
  EditorSshConfig,
  defaultProxyProgram,
  editorSshPaths,
  findSshClients,
  includeSpellings,
  insertInclude,
  knownHostsWord,
  proxyCommand,
  removeInclude,
  renderConfig,
  systemSshVerifier,
  userWord,
  type LiveComputer,
  type SshVerifier
} from '../../../src/mms/net/editor/sshConfig'
import { NetService } from '../../../src/mms/net/NetService'
import { newId, type NodeId } from '../../../src/shared/net'
import { NET_LOCAL_METHODS, type EditorSshStatus } from '../../../src/shared/net/local'
import { KEY_A, KEY_B, KEY_RSA } from '../ssh/bed'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** A program path with a space, as in `C:\Program Files` or `Application Support`. */
const CLI = join(tmpdir(), 'mousse app', 'mousse-cli').replace(/\\/gu, '/')
const passes: SshVerifier = async () => ({ ok: true })

/** A temporary HOME and Mousse home, both with a space in the path. Nothing here is the real home. */
async function bed(
  options: {
    mousseInsideHome?: boolean
    verify?: SshVerifier
    profile?: string
    root?: string
  } = {}
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'mousse editor ')))
  if (!options.root) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home dir')
  await mkdir(home, { recursive: true })
  const mousseHome =
    options.mousseInsideHome === false ? join(root, 'mousse home') : join(home, '.mousse')
  const make = (profile = options.profile ?? 'default', verify = options.verify ?? passes) =>
    new EditorSshConfig({ home, mousseHome, cli: CLI, profile, verify })
  const editor = make()
  return {
    root,
    home,
    mousseHome,
    make,
    editor,
    userConfig: join(home, '.ssh', 'config'),
    paths: editor.paths
  }
}
const computer = (name: string, user?: string): LiveComputer => ({
  node: newId('node'),
  name,
  ...(user ? { user } : {})
})
const paths = (platform: NodeJS.Platform, home: string, mousseHome: string) =>
  editorSshPaths({ home, mousseHome, platform })
const LINE = 'Include ~/.mousse/ssh/config'
const SPELLINGS = ['~/.mousse/ssh/config']
const insert = (text: string) => insertInclude(text, LINE, SPELLINGS, 'linux')
const remove = (text: string) => removeInclude(text, SPELLINGS, 'linux')

describe('where the Include line goes', () => {
  it('goes ahead of the first Host line and of every other line', () => {
    const text = 'AddKeysToAgent yes\nHost work\n  User me\n'
    const { text: out, added } = insert(text)
    expect(added).toBe(true)
    expect(out).toBe(`${LINE}\n${text}`)
    const lines = out.split('\n')
    expect(lines.indexOf(LINE)).toBeLessThan(lines.findIndex((line) => /^Host\b/u.test(line)))
  })

  it('goes ahead of a Match line as well', () => {
    const { text } = insert('Match host *.corp\n  User corp\nHost a\n')
    expect(text.split('\n')[0]).toBe(LINE)
  })

  it('keeps CRLF files in CRLF and leaves every original byte alone', () => {
    const original =
      '# mine\r\nHost work\r\n  HostName w.example\r\n\r\nHost *\r\n  ForwardAgent no\r\n'
    const { text } = insert(original)
    expect(text).toBe(`${LINE}\r\n${original}`)
    expect(text.replace(`${LINE}\r\n`, '')).toBe(original)
  })

  it('keeps a byte order mark at the start of the file', () => {
    const original = '\xEF\xBB\xBFHost work\n'
    const { text } = insert(original)
    expect(text).toBe(`\xEF\xBB\xBF${LINE}\nHost work\n`)
    expect(remove(text).text).toBe(original)
  })

  it('handles an empty file, a file without a final newline and a file of comments', () => {
    expect(insert('').text).toBe(`${LINE}\n`)
    expect(insert('Host a').text).toBe(`${LINE}\nHost a`)
    expect(insert('# only a comment\n').text).toBe(`${LINE}\n# only a comment\n`)
  })

  it('adds nothing when the line is already in force, whatever its spelling', () => {
    expect(insert(`${LINE}\nHost a\n`).added).toBe(false)
    expect(insert(`include="~/.mousse/ssh/config"\nHost a\n`).added).toBe(false)
    expect(insert(`Include other.conf ~/.mousse/ssh/config\nHost a\n`).added).toBe(false)
  })

  it('does not count a copy below a Host line, which ssh reads for that block only', () => {
    const text = `Host a\n  ${LINE}\n`
    const { text: out, added } = insert(text)
    expect(added).toBe(true)
    expect(out).toBe(`${LINE}\n${text}`)
  })
})

describe('undo', () => {
  it("removes only the line that names Mousse's file", () => {
    const original = [
      'Include ~/.ssh/work.conf',
      'Host a',
      '  User a',
      '# Include ~/.mousse/ssh/config in a comment stays',
      'Host b',
      '  HostName b.example',
      ''
    ].join('\n')
    const { text } = insert(original)
    expect(remove(text)).toEqual({ text: original, removed: 1 })
  })

  it('works on CRLF text, is case-insensitive and ignores `=`', () => {
    const original = 'Host a\r\n  User a\r\n'
    expect(remove(`INCLUDE = "~/.mousse/ssh/config"\r\n${original}`).text).toBe(original)
  })

  it('leaves a line that also names another file', () => {
    const text = 'Include ~/.ssh/work.conf ~/.mousse/ssh/config\nHost a\n'
    expect(remove(text)).toEqual({ text, removed: 0 })
  })

  it('is a no-op when the line is absent', () => {
    const text = 'Host a\n  User a\n'
    expect(remove(text)).toEqual({ text, removed: 0 })
  })
})

describe('the line and the words in the config', () => {
  it('uses ~/ when the Mousse home is under the home directory, on every platform', () => {
    expect(includeSpellings(paths('linux', '/home/me', '/home/me/.mousse'), 'linux')).toEqual({
      line: 'Include ~/.mousse/ssh/config',
      spellings: ['~/.mousse/ssh/config', '/home/me/.mousse/ssh/config']
    })
    expect(
      includeSpellings(
        paths('win32', 'C:\\Users\\John Doe', 'C:\\Users\\John Doe\\.mousse'),
        'win32'
      )
    ).toMatchObject({
      line: 'Include ~/.mousse/ssh/config',
      spellings: ['~/.mousse/ssh/config', 'C:/Users/John Doe/.mousse/ssh/config']
    })
  })

  it('quotes a path with spaces, with forward slashes on Windows', () => {
    expect(
      includeSpellings(
        paths('win32', 'C:\\Users\\John Doe', 'C:\\Users\\John Doe\\My Mousse'),
        'win32'
      ).line
    ).toBe('Include "~/My Mousse/ssh/config"')
    expect(includeSpellings(paths('win32', 'C:\\Users\\me', 'D:\\Mousse Data'), 'win32').line).toBe(
      'Include "D:/Mousse Data/ssh/config"'
    )
    expect(includeSpellings(paths('linux', '/home/me', '/srv/mousse data'), 'linux').line).toBe(
      'Include "/srv/mousse data/ssh/config"'
    )
  })

  it('writes the known_hosts path the way the Include line is written', () => {
    expect(knownHostsWord(paths('win32', 'C:\\Users\\me', 'C:\\Users\\me\\.mousse'), 'win32')).toBe(
      '~/.mousse/ssh/known_hosts'
    )
    expect(knownHostsWord(paths('win32', 'C:\\Users\\me', 'D:\\Mousse Data'), 'win32')).toBe(
      '"D:/Mousse Data/ssh/known_hosts"'
    )
    expect(knownHostsWord(paths('linux', '/home/me', '/home/me/mousse home'), 'linux')).toBe(
      '"~/mousse home/ssh/known_hosts"'
    )
  })

  it('refuses characters ssh would read as a token, a glob or an escape', () => {
    for (const home of ['/srv/100%', '/srv/${HOME}', '/srv/a"b', '/srv/a[1]', '/srv/a\\b'])
      expect(() => includeSpellings(paths('linux', '/home/me', home), 'linux')).toThrow(
        /cannot take/
      )
  })

  it('builds a ProxyCommand that survives spaces, quotes and percent signs, and names the profile', () => {
    const node = newId('node')
    const tail = `net ssh-proxy ${node} --profile default`
    expect(proxyCommand('/usr/local/bin/mousse-cli', node, 'default', 'linux')).toBe(
      `/usr/local/bin/mousse-cli ${tail}`
    )
    expect(proxyCommand('/opt/Mousse App/mousse-cli', node, 'default', 'linux')).toBe(
      `'/opt/Mousse App/mousse-cli' ${tail}`
    )
    expect(proxyCommand("/opt/it's/mousse-cli", node, 'default', 'linux')).toBe(
      `'/opt/it'"'"'s/mousse-cli' ${tail}`
    )
    expect(proxyCommand('/opt/100%/mousse-cli', node, 'default', 'linux')).toBe(
      `/opt/100%%/mousse-cli ${tail}`
    )
    expect(
      proxyCommand('C:\\Program Files\\Mousse\\mousse-cli.cmd', node, 'default', 'win32')
    ).toBe(`"C:/Program Files/Mousse/mousse-cli.cmd" ${tail}`)
    expect(
      proxyCommand({ program: '/home/me/Mousse.AppImage', args: ['--cli'] }, node, 'p-1', 'linux')
    ).toBe(`/home/me/Mousse.AppImage --cli net ssh-proxy ${node} --profile p-1`)
    expect(() => proxyCommand('C:\\a$b\\mousse-cli.cmd', node, 'default', 'win32')).toThrow()
    expect(() => proxyCommand('/x/mousse-cli', 'nod_nope' as NodeId, 'default', 'linux')).toThrow()
    expect(() => proxyCommand('/x/mousse-cli', node, 'a b; rm', 'linux')).toThrow()
  })

  it('renders one block per computer, the same way every time', () => {
    const a = computer('Work box', 'bob'),
      b = computer('Étude', 'John Doe')
    const rendered = [
      { node: a.node, alias: 'mousse-work-box-aaaaaa', name: a.name, user: a.user, profile: 'one' },
      { node: b.node, alias: 'mousse-etude-bbbbbb', name: b.name, user: b.user, profile: 'two' }
    ]
    const context = {
      knownHosts: '~/.mousse/ssh/known_hosts',
      cli: '/opt/mousse-cli',
      platform: 'linux' as const
    }
    const text = renderConfig(rendered, context)
    expect(renderConfig([...rendered].reverse(), context)).toBe(text)
    expect(text).toContain('Host mousse-work-box-aaaaaa\n')
    expect(text).toContain('  User bob\n')
    expect(text).toContain('  User "John Doe"\n')
    expect(text).toContain(`  ProxyCommand /opt/mousse-cli net ssh-proxy ${a.node} --profile one\n`)
    expect(text).toContain(`  ProxyCommand /opt/mousse-cli net ssh-proxy ${b.node} --profile two\n`)
    expect(text).toContain('  HostKeyAlias mousse-work-box-aaaaaa\n')
    expect(text).toContain('  UserKnownHostsFile ~/.mousse/ssh/known_hosts\n')
    for (const setting of [
      'StrictHostKeyChecking yes',
      'ForwardAgent no',
      'ForwardX11 no',
      'ControlMaster no',
      'UpdateHostKeys no'
    ])
      expect(text).toContain(`  ${setting}\n`)
    expect(text).not.toMatch(/^\s+Port /mu)
  })

  it('writes only login names that every ssh client parses the same way', () => {
    for (const ok of ['bob', 'John Doe', 'a.b_c-d', 'me@corp', 'a+b'])
      expect(userWord(ok)).toBe(ok.includes(' ') ? `"${ok}"` : ok)
    for (const bad of [
      'a=b',
      'a,b',
      'a;b',
      'a:b',
      'a\\b',
      'DOMAIN\\me',
      'a"b',
      "a'b",
      'a%b',
      'a#b',
      '-oProxyCommand=x',
      'a\nb',
      '',
      ' ',
      'x'.repeat(65)
    ])
      expect(userWord(bad)).toBeUndefined()
  })

  it('leaves the User line out when the name cannot be written safely', () => {
    const a = computer('Box')
    for (const user of ['-oProxyCommand=x', 'a=b', 'a"b', 'a\nb', 'a\\b', '', undefined]) {
      const text = renderConfig(
        [{ node: a.node, alias: 'mousse-box-aaaaaa', name: 'Box', user, profile: 'default' }],
        { knownHosts: '/k', cli: 'mousse-cli', platform: 'linux' }
      )
      expect(text).not.toMatch(/^\s+User /mu)
    }
  })

  it('names a comment safely when a computer name has line breaks', () => {
    const a = computer('x')
    const text = renderConfig(
      [
        {
          node: a.node,
          alias: 'mousse-x-aaaaaa',
          name: 'evil\nHost *\n  ProxyCommand rm',
          profile: 'default'
        }
      ],
      { knownHosts: '/k', cli: 'mousse-cli', platform: 'linux' }
    )
    expect(text.split('\n').filter((line) => /^Host /u.test(line))).toEqual([
      'Host mousse-x-aaaaaa'
    ])
  })
})

describe('the program a ProxyCommand starts', () => {
  const exists =
    (...present: string[]) =>
    (path: string) =>
      present.includes(path)
  it('finds the launcher next to the app binary on Windows', () => {
    expect(
      defaultProxyProgram('win32', {
        execPath: 'C:\\Program Files\\Mousse\\Mousse.exe',
        env: {},
        exists: exists('C:\\Program Files\\Mousse\\mousse-cli.cmd')
      })
    ).toEqual({ program: 'C:\\Program Files\\Mousse\\mousse-cli.cmd' })
  })

  it('finds the launcher in Contents/Resources of a macOS app bundle', () => {
    expect(
      defaultProxyProgram('darwin', {
        execPath: '/Applications/Mousse.app/Contents/MacOS/Mousse',
        env: {},
        exists: exists('/Applications/Mousse.app/Contents/Resources/mousse-cli')
      })
    ).toEqual({ program: '/Applications/Mousse.app/Contents/Resources/mousse-cli' })
  })

  it('uses the AppImage file itself, whose folder changes on every start', () => {
    expect(
      defaultProxyProgram('linux', {
        execPath: '/tmp/.mount_MousseAB12/mousse',
        env: { APPIMAGE: '/home/me/Apps/Mousse.AppImage' },
        exists: exists('/home/me/Apps/Mousse.AppImage', '/tmp/.mount_MousseAB12/mousse-cli')
      })
    ).toEqual({ program: '/home/me/Apps/Mousse.AppImage', args: ['--cli'] })
  })

  it('uses the launcher next to the binary on Linux, and mousse-cli from PATH as the last resort', () => {
    expect(
      defaultProxyProgram('linux', {
        execPath: '/opt/Mousse/mousse',
        env: {},
        exists: exists('/opt/Mousse/mousse-cli')
      })
    ).toEqual({ program: '/opt/Mousse/mousse-cli' })
    expect(
      defaultProxyProgram('linux', { execPath: '/opt/Mousse/mousse', env: {}, exists: () => false })
    ).toEqual({ program: 'mousse-cli' })
  })
})

describe('files', () => {
  it('writes nothing until it is used', async () => {
    const { editor, home, mousseHome } = await bed()
    expect((await editor.status()).included).toBe(false)
    await editor.syncIfPrepared(() => [computer('Box')])
    await editor.acknowledgeNotice()
    expect(await readdir(home)).toEqual([])
    expect(existsSync(mousseHome)).toBe(false)
  })

  it('creates a missing ~/.ssh and the config, adds the line at the top and raises the notice once', async () => {
    const { editor, userConfig, paths: p } = await bed()
    const box = computer('Work box', 'bob')
    const first = await editor.prepare([box])
    expect(first).toMatchObject({ ok: true, added: true })
    if (!first.ok) throw new Error('unreachable')
    expect(first.status).toMatchObject({
      available: true,
      enabled: true,
      included: true,
      noticePending: true,
      notice: EDITOR_SSH_NOTICE,
      includeLine: 'Include ~/.mousse/ssh/config'
    })
    expect(await readFile(userConfig, 'utf8')).toBe('Include ~/.mousse/ssh/config\n')
    const alias = first.status.computers[0]!.alias
    expect(alias).toMatch(new RegExp(`^mousse-work-box-${box.node.slice(4, 10)}$`))
    const config = await readFile(p.config, 'utf8')
    expect(config).toContain(`Host ${alias}`)
    expect(config).toContain('  User bob')
    expect(config).toContain(`--profile default`)
    if (process.platform !== 'win32') {
      expect((await stat(p.config)).mode & 0o777).toBe(0o600)
      expect((await stat(p.dir)).mode & 0o777).toBe(0o700)
      expect((await stat(userConfig)).mode & 0o777).toBe(0o600)
    }

    const second = await editor.prepare([box])
    expect(second).toMatchObject({ ok: true, added: false })
    expect(await readFile(userConfig, 'utf8')).toBe('Include ~/.mousse/ssh/config\n')
    expect(second.ok && second.status.noticePending).toBe(true)
    const seen = await editor.acknowledgeNotice()
    expect(seen.noticePending).toBe(false)
    expect(seen.notice).toBeUndefined()
  })

  it('keeps the rest of an existing file byte for byte, also bytes that are not UTF-8', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    const original = Buffer.concat([
      Buffer.from('# caf'),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('\r\nHost work\r\n  User me\r\n\r\n\tHostName   w.example   \r\n')
    ])
    await writeFile(userConfig, original)
    await editor.prepare([computer('Box')])
    const written = await readFile(userConfig)
    expect(written.subarray(0, 30).toString('latin1')).toBe('Include ~/.mousse/ssh/config\r\n')
    expect(written.subarray(30).equals(original)).toBe(true)
    await editor.disable()
    expect((await readFile(userConfig)).equals(original)).toBe(true)
  })

  it('leaves a file that is not plain text alone', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    const utf16 = Buffer.from('\ufeffHost a\n', 'utf16le')
    await writeFile(userConfig, utf16)
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'unreadable' })
    expect((await readFile(userConfig)).equals(utf16)).toBe(true)
  })

  it('changes the file in place, so its mode and identity stay', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    if (process.platform !== 'win32') await chmod(userConfig, 0o640)
    const before = await stat(userConfig)
    await editor.prepare([computer('Box')])
    const after = await stat(userConfig)
    // Same file, not a new one renamed over it: it keeps its ACL, owner, links and attributes.
    expect(after.ino).toBe(before.ino)
    if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o640)
    await editor.disable()
    expect((await stat(userConfig)).ino).toBe(before.ino)
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
  })

  it('leaves a read-only file alone and says how to add the line by hand', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    await chmod(userConfig, 0o444)
    cleanup.push(() => chmod(userConfig, 0o644))
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'unwritable' })
    expect(!result.ok && result.message).toContain('Include ~/.mousse/ssh/config')
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
    expect((await stat(userConfig)).mode & 0o200).toBe(0)
  })

  it('leaves no temporary files beside the config', async () => {
    const { editor, home, paths: p } = await bed()
    await editor.prepare([computer('Box')])
    await editor.disable()
    await editor.enable([computer('Box')])
    expect((await readdir(join(home, '.ssh'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect((await readdir(p.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect((await readdir(p.dir)).filter((name) => name.startsWith('check-'))).toEqual([])
  })

  it('writes through a symbolic link and keeps the link', async () => {
    const { editor, userConfig, home, root } = await bed()
    await mkdir(join(home, '.ssh'))
    const real = join(root, 'dotfiles config')
    await writeFile(real, 'Host a\n  User a\n')
    try {
      await symlink(real, userConfig)
    } catch {
      return // Creating links needs a privilege on some Windows setups.
    }
    await editor.prepare([computer('Box')])
    expect((await lstat(userConfig)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('Include ~/.mousse/ssh/config\nHost a\n  User a\n')
    await editor.disable()
    expect((await lstat(userConfig)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('Host a\n  User a\n')
  })

  it('creates the file a dangling link points to', async () => {
    const { editor, userConfig, home, root } = await bed()
    await mkdir(join(home, '.ssh'))
    const real = join(root, 'dotfiles config')
    try {
      await symlink(real, userConfig)
    } catch {
      return
    }
    const result = await editor.prepare([computer('Box')])
    expect(result.ok).toBe(true)
    expect((await lstat(userConfig)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('Include ~/.mousse/ssh/config\n')
  })

  it('reports a link whose folder is missing instead of creating folders', async () => {
    const { editor, userConfig, home, root } = await bed()
    await mkdir(join(home, '.ssh'))
    try {
      await symlink(join(root, 'nowhere', 'config'), userConfig)
    } catch {
      return
    }
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'unwritable' })
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
  })

  it('writes an absolute, quoted line when the Mousse home is outside the home directory', async () => {
    const { editor, userConfig, mousseHome } = await bed({ mousseInsideHome: false })
    await editor.prepare([computer('Box')])
    expect(await readFile(userConfig, 'utf8')).toBe(
      `Include "${mousseHome}/ssh/config"\n`.replace(/\\/gu, '/')
    )
  })

  it('undo removes only the line and turns the feature off until it is turned on again', async () => {
    const { editor, userConfig, home, paths: p } = await bed()
    await mkdir(join(home, '.ssh'))
    const original = 'Include ~/.ssh/work.conf\n\nHost a\n  User a\n'
    await writeFile(userConfig, original)
    const box = computer('Box')
    await editor.prepare([box])
    expect(await readFile(userConfig, 'utf8')).toBe(`Include ~/.mousse/ssh/config\n${original}`)

    const undone = await editor.disable()
    expect(undone).toMatchObject({ ok: true, removed: 1 })
    expect(undone.ok && undone.leftover).toBeUndefined()
    expect(undone.ok && undone.status).toMatchObject({
      enabled: false,
      included: false,
      noticePending: false
    })
    expect(await readFile(userConfig, 'utf8')).toBe(original)
    // Mousse's own files stay, so turning it on again is instant and the pinned keys survive.
    expect(existsSync(p.config)).toBe(true)

    // First use does not turn it back on.
    const refused = await editor.prepare([box])
    expect(refused).toMatchObject({ ok: false, code: 'off' })
    expect(await readFile(userConfig, 'utf8')).toBe(original)
    await editor.syncIfPrepared(() => [box, computer('Other')])
    expect((await editor.status()).computers).toHaveLength(1)

    const again = await editor.enable([box])
    expect(again).toMatchObject({ ok: true, added: true })
    expect(await readFile(userConfig, 'utf8')).toBe(`Include ~/.mousse/ssh/config\n${original}`)
    expect((await editor.status()).enabled).toBe(true)
  })

  it("undo of a feature that was never used changes nothing in the user's file", async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    expect(await editor.disable()).toMatchObject({ ok: true, removed: 0 })
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
  })

  it('treats a line the person removed by hand as turned off, and does not add it again', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    const box = computer('Box')
    await editor.prepare([box])
    // The person deletes the line in their editor.
    await writeFile(userConfig, 'Host a\n')

    const result = await editor.prepare([box])
    expect(result).toMatchObject({ ok: false, code: 'off' })
    expect(!result.ok && result.message).toContain('removed')
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
    expect(result.status.enabled).toBe(false)
    expect(await editor.prepare([box])).toMatchObject({ ok: false, code: 'off' })

    // Only turning it on in Settings adds it again.
    expect(await editor.enable([box])).toMatchObject({ ok: true, added: true })
    expect(await readFile(userConfig, 'utf8')).toBe('Include ~/.mousse/ssh/config\nHost a\n')
  })

  it('does not add a second copy when the person moved the line under a Host line', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    const moved = 'Host a\n  Include ~/.mousse/ssh/config\n'
    await writeFile(userConfig, moved)
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'scoped' })
    expect(await readFile(userConfig, 'utf8')).toBe(moved)
    expect(result.status).toMatchObject({ included: false, scoped: true })
  })

  it('says so when undo cannot remove a line the person edited', async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    const box = computer('Box')
    await editor.prepare([box])
    const edited = 'Include ~/.mousse/ssh/config # editor ssh\nHost a\n'
    await writeFile(userConfig, edited)
    expect((await editor.status()).edited).toBe(true)

    const undone = await editor.disable()
    expect(undone).toMatchObject({ ok: true, removed: 0, leftover: true })
    expect(undone.ok && undone.status).toMatchObject({
      enabled: false,
      included: true,
      edited: true
    })
    expect(await readFile(userConfig, 'utf8')).toBe(edited)
  })

  it('keeps an alias when the computer is renamed, and drops it when the computer is revoked', async () => {
    const { editor, paths: p } = await bed()
    const a = computer('Work box'),
      b = computer('Laptop')
    const first = await editor.prepare([a, b])
    if (!first.ok) throw new Error('unreachable')
    const aliasOf = (name: string) => first.status.computers.find((row) => row.name === name)!.alias
    await editor.pinHostKey(a.node, KEY_A)
    await editor.pinHostKey(b.node, KEY_B)

    await editor.syncIfPrepared(() => [{ ...a, name: 'Renamed' }, b])
    let status = await editor.status()
    expect(status.computers.find((row) => row.node === a.node)).toMatchObject({
      alias: aliasOf('Work box'),
      name: 'Renamed',
      hostKeyPinned: true
    })
    expect(await readFile(p.config, 'utf8')).toContain('# Renamed')

    await editor.syncIfPrepared(() => [b])
    status = await editor.status()
    expect(status.computers.map((row) => row.alias)).toEqual([aliasOf('Laptop')])
    expect(await readFile(p.config, 'utf8')).not.toContain(aliasOf('Work box'))
    const pinned = await readFile(p.knownHosts, 'utf8')
    expect(pinned).not.toContain(aliasOf('Work box'))
    expect(pinned).toContain(`${aliasOf('Laptop')} ${KEY_B.type} ${KEY_B.key}`)
  })

  it('writes the file again at every start, so a program path that moved is found', async () => {
    const { home, mousseHome, editor, paths: p } = await bed()
    const box = computer('Box')
    await editor.prepare([box])
    expect(await readFile(p.config, 'utf8')).toContain(proxyCommand(CLI, box.node, 'default'))
    const moved = new EditorSshConfig({
      home,
      mousseHome,
      cli: '/Applications/Mousse.app/Contents/Resources/mousse-cli',
      verify: passes
    })
    await moved.syncIfPrepared(() => [box])
    expect(await readFile(p.config, 'utf8')).toContain(
      `ProxyCommand /Applications/Mousse.app/Contents/Resources/mousse-cli net ssh-proxy ${box.node} --profile default`
    )
  })

  it('gives two computers with the same name different aliases', async () => {
    const { editor } = await bed()
    const result = await editor.prepare([computer('Box'), computer('Box')])
    if (!result.ok) throw new Error('unreachable')
    expect(new Set(result.status.computers.map((row) => row.alias)).size).toBe(2)
  })

  it('stores the login name once the computer has said it', async () => {
    const { editor, paths: p } = await bed()
    const box = computer('Box')
    await editor.prepare([box])
    expect(await readFile(p.config, 'utf8')).not.toMatch(/^\s+User /mu)
    await editor.syncIfPrepared(() => [{ ...box, user: 'bob' }])
    expect(await readFile(p.config, 'utf8')).toMatch(/^ {2}User bob$/mu)
    await editor.syncIfPrepared(() => [box])
    expect(await readFile(p.config, 'utf8')).toMatch(/^ {2}User bob$/mu)
  })

  it('keeps the aliases it has when the device list cannot be read', async () => {
    const { editor, paths: p } = await bed()
    const box = computer('Box')
    await editor.prepare([box])
    await editor.syncIfPrepared(() => {
      throw new Error('not ready')
    })
    expect((await editor.status()).computers).toHaveLength(1)
    expect(await readFile(p.config, 'utf8')).toContain('Host mousse-box-')
  })

  it("never writes the user's file when it only syncs", async () => {
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    const box = computer('Box')
    await editor.prepare([box])
    await writeFile(userConfig, 'Host a\n') // the line removed by hand
    const stamp = (await stat(userConfig)).mtimeMs
    await editor.syncIfPrepared(() => [box, computer('Other')])
    await editor.syncIfPrepared(() => [])
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
    expect((await stat(userConfig)).mtimeMs).toBe(stamp)
  })
})

describe('when another program changes the file during a write', () => {
  it('makes the change again on the new text', async () => {
    const { home, mousseHome, userConfig } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    const attempts: number[] = []
    const editor = new EditorSshConfig({
      home,
      mousseHome,
      cli: CLI,
      verify: passes,
      afterRead: async (attempt) => {
        attempts.push(attempt)
        if (attempt === 0) await writeFile(userConfig, 'Host a\nHost b\n')
      }
    })
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: true, added: true })
    expect(attempts).toEqual([0, 1])
    expect(await readFile(userConfig, 'utf8')).toBe(
      'Include ~/.mousse/ssh/config\nHost a\nHost b\n'
    )
  })

  it("gives up after three tries and leaves the other program's text alone", async () => {
    const { home, mousseHome, userConfig } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    let last = ''
    const editor = new EditorSshConfig({
      home,
      mousseHome,
      cli: CLI,
      verify: passes,
      afterRead: async (attempt) => {
        last = `Host a\n# change ${attempt}\n`
        await writeFile(userConfig, last)
      }
    })
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'unwritable' })
    expect(!result.ok && result.message).toContain('kept changing')
    expect(await readFile(userConfig, 'utf8')).toBe(last)
  })
})

describe('never breaking ssh', () => {
  const failing =
    (detail: string): SshVerifier =>
    async () => ({
      ok: false,
      code: 'ssh_check_failed',
      detail
    })

  it('does not touch ~/.ssh/config when the scratch check fails, and says why', async () => {
    const { editor, userConfig, home } = await bed({ verify: failing('ssh.exe: Bad permissions') })
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'ssh_check_failed' })
    expect(!result.ok && result.message).toContain('Bad permissions')
    expect(!result.ok && result.message).toContain('did not change ~/.ssh/config')
    expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
  })

  it('does not create ~/.ssh when the check fails', async () => {
    const { editor, home } = await bed({ verify: failing('boom') })
    await editor.prepare([computer('Box')])
    expect(existsSync(join(home, '.ssh'))).toBe(false)
  })

  it('refuses when there is no ssh to check with', async () => {
    const { editor, userConfig } = await bed({
      verify: async () => ({ ok: false, code: 'no_ssh', detail: 'The ssh command was not found.' })
    })
    expect(await editor.prepare([computer('Box')])).toMatchObject({ ok: false, code: 'no_ssh' })
    expect(existsSync(userConfig)).toBe(false)
  })

  it('puts the file back exactly when the check on the real file fails', async () => {
    const calls: string[] = []
    const verify: SshVerifier = async ({ config }) => {
      calls.push(config)
      return calls.length === 1
        ? { ok: true }
        : { ok: false, code: 'ssh_check_failed', detail: 'parse error' }
    }
    const { editor, userConfig, home } = await bed({ verify })
    await mkdir(join(home, '.ssh'))
    const original = Buffer.from([...Buffer.from('Host a\r\n  User a\r\n# caf'), 0xe9, 0x0d, 0x0a])
    await writeFile(userConfig, original)
    const result = await editor.prepare([computer('Box')])
    expect(result).toMatchObject({ ok: false, code: 'ssh_check_failed' })
    expect(!result.ok && result.message).toContain('put ~/.ssh/config back as it was')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(userConfig)
    expect((await readFile(userConfig)).equals(original)).toBe(true)
    expect(result.status.included).toBe(false)
  })

  it('removes a file it created when the check on it fails', async () => {
    let calls = 0
    const verify: SshVerifier = async () =>
      ++calls === 1 ? { ok: true } : { ok: false, code: 'ssh_check_failed', detail: 'parse error' }
    const { editor, userConfig } = await bed({ verify })
    expect(await editor.prepare([computer('Box')])).toMatchObject({ ok: false })
    expect(existsSync(userConfig)).toBe(false)
  })

  it('reads an unrelated host and an alias in the scratch check', async () => {
    const seen: string[][] = []
    const { editor } = await bed({
      verify: async ({ hosts }) => {
        seen.push(hosts)
        return { ok: true }
      }
    })
    await editor.prepare([computer('Box')])
    expect(seen[0]).toHaveLength(2)
    expect(seen[0]![0]).toBe('mousse-check.invalid')
    expect(seen[0]![1]).toMatch(/^mousse-box-/u)
  })

  it('reports a failing real file in the status', async () => {
    let fail = false
    const { editor } = await bed({
      verify: async () =>
        fail ? { ok: false, code: 'ssh_check_failed', detail: 'later' } : { ok: true }
    })
    await editor.prepare([computer('Box')])
    expect((await editor.status()).problem).toBeUndefined()
    fail = true
    expect((await editor.status()).problem).toMatchObject({ code: 'ssh_check_failed' })
  })

  it("restores Mousse's file when a sync would leave ssh unable to read it", async () => {
    let fail = false
    const { editor, paths: p } = await bed({
      verify: async () =>
        fail ? { ok: false, code: 'ssh_check_failed', detail: 'later' } : { ok: true }
    })
    const box = computer('Box')
    await editor.prepare([box])
    const good = await readFile(p.config, 'utf8')
    fail = true
    await expect(editor.syncIfPrepared(() => [box, computer('Other')])).rejects.toMatchObject({
      code: 'ssh_check_failed'
    })
    expect(await readFile(p.config, 'utf8')).toBe(good)
  })
})

describe('profiles', () => {
  it("keeps each profile's computers, aliases and pinned keys when another profile syncs", async () => {
    const { make, userConfig, paths: p } = await bed()
    const one = make('profile-one'),
      two = make('profile-two')
    const work = computer('Work box'),
      personal = computer('Personal box')
    const a = await one.prepare([work])
    const b = await two.prepare([personal])
    if (!a.ok || !b.ok) throw new Error('unreachable')
    await one.pinHostKey(work.node, KEY_A)
    await two.pinHostKey(personal.node, KEY_B)
    const aliasWork = a.status.computers[0]!.alias,
      aliasPersonal = b.status.computers[0]!.alias

    const config = await readFile(p.config, 'utf8')
    expect(config).toContain(`Host ${aliasWork}`)
    expect(config).toContain(`Host ${aliasPersonal}`)
    expect(config).toContain(`net ssh-proxy ${work.node} --profile profile-one`)
    expect(config).toContain(`net ssh-proxy ${personal.node} --profile profile-two`)
    // One line in the user's file serves every profile, and the second profile did not add another.
    expect(b.added).toBe(false)
    expect(await readFile(userConfig, 'utf8')).toBe('Include ~/.mousse/ssh/config\n')

    // Profile one loses its computer: profile two's alias and pinned key stay.
    await one.syncIfPrepared(() => [])
    const after = await readFile(p.config, 'utf8')
    expect(after).not.toContain(aliasWork)
    expect(after).toContain(`Host ${aliasPersonal}`)
    const pinned = await readFile(p.knownHosts, 'utf8')
    expect(pinned).not.toContain(aliasWork)
    expect(pinned).toContain(`${aliasPersonal} ${KEY_B.type} ${KEY_B.key}`)
    expect((await two.status()).computers.map((row) => row.alias)).toEqual([aliasPersonal])
    expect((await one.status()).computers).toEqual([])
  })

  it('never gives two profiles the same alias, also for the same computer', async () => {
    const { make } = await bed()
    const shared = computer('Box')
    const a = await make('one').prepare([shared])
    const b = await make('two').prepare([shared])
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.status.computers[0]!.alias).not.toBe(b.status.computers[0]!.alias)
  })

  it('changes one profile at a time when two run together', async () => {
    const { make, paths: p } = await bed()
    const profiles = ['p1', 'p2', 'p3', 'p4'].map((id) => make(id))
    const boxes = profiles.map((_, i) => computer(`Box ${i}`))
    await Promise.all(profiles.map((service, i) => service.prepare([boxes[i]!])))
    const config = await readFile(p.config, 'utf8')
    for (const box of boxes) expect(config).toContain(`ssh-proxy ${box.node} --profile`)
    expect((config.match(/^Host /gmu) ?? []).length).toBe(4)
  })

  it('replaces every pinned key of an alias, whatever its type, and nothing of another alias', async () => {
    const { editor, paths: p } = await bed()
    const box = computer('Box'),
      other = computer('Other')
    const prepared = await editor.prepare([box, other])
    if (!prepared.ok) throw new Error('unreachable')
    const alias = prepared.status.computers.find((row) => row.name === 'Box')!.alias
    const otherAlias = prepared.status.computers.find((row) => row.name === 'Other')!.alias
    await editor.pinHostKey(other.node, KEY_RSA)
    expect(await editor.pinHostKey(box.node, KEY_A)).toBe('added')
    expect(await editor.pinHostKey(box.node, KEY_A)).toBe('present')
    expect(await editor.pinHostKeys(box.node, [KEY_A, KEY_RSA])).toBe('replaced')
    expect(await editor.pinHostKeys(box.node, [KEY_A, KEY_RSA])).toBe('present')
    // The computer now vouches for one Ed25519 key only: the RSA key is no longer trusted.
    expect(await editor.pinHostKey(box.node, KEY_B)).toBe('replaced')
    const lines = (await readFile(p.knownHosts, 'utf8')).trim().split('\n').sort()
    expect(lines).toEqual(
      [`${alias} ${KEY_B.type} ${KEY_B.key}`, `${otherAlias} ${KEY_RSA.type} ${KEY_RSA.key}`].sort()
    )
  })

  it('refuses a computer it does not know and a key that is not a host key', async () => {
    const { editor } = await bed()
    const box = computer('Box')
    await editor.prepare([box])
    await expect(editor.pinHostKey(newId('node'), KEY_A)).rejects.toMatchObject({
      code: 'unknown_computer'
    })
    for (const key of [
      { type: 'ssh-ed25519', key: 'not base64!' },
      { type: 'ssh-ed25519\nHost *', key: KEY_A.key },
      { type: 'nonsense', key: KEY_A.key }
    ])
      await expect(editor.pinHostKey(box.node, key)).rejects.toMatchObject({ code: 'bad_value' })
    await expect(editor.pinHostKeys(box.node, [])).rejects.toMatchObject({ code: 'bad_value' })
  })
})

const hasSsh = !spawnSync('ssh', ['-V']).error
describe.skipIf(!hasSsh)('as the system ssh reads it', () => {
  const resolved = (config: string, alias: string) => {
    const run = spawnSync('ssh', ['-F', config, '-G', alias], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    return new Map(
      run.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(
          (line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)] as const
        )
    )
  }

  it('reads the rendered block as written', async () => {
    const { editor, paths: p } = await bed()
    const box = computer('Work box', 'John Doe')
    const result = await editor.prepare([box])
    if (!result.ok) throw new Error('unreachable')
    const alias = result.status.computers[0]!.alias
    const values = resolved(p.config, alias)
    expect(values.get('hostkeyalias')).toBe(alias)
    expect(values.get('user')).toBe('John Doe')
    expect(values.get('stricthostkeychecking')).toBe('true')
    expect(values.get('hostname')).toBe('127.0.0.1')
    expect(values.get('proxycommand')).toBe(proxyCommand(CLI, box.node, 'default'))
    expect(values.get('userknownhostsfile')?.replace(/\\/gu, '/')).toContain(
      '/.mousse/ssh/known_hosts'
    )
  })

  it('adds the line when the real ssh reads the scratch config, and the real file reads afterwards', async () => {
    const { editor, userConfig } = await bed({
      verify: systemSshVerifier(),
      mousseInsideHome: false
    })
    expect(await editor.prepare([computer('Box')])).toMatchObject({ ok: true, added: true })
    expect(resolved(userConfig, 'github.com').get('hostname')).toBe('github.com')
  })

  it('does not pass a config the real ssh cannot read', async () => {
    const { root } = await bed()
    const verdict = await systemSshVerifier()({
      config: join(root, 'does-not-exist-config'),
      hosts: ['mousse-check.invalid']
    })
    expect(verdict).toMatchObject({ ok: false, code: 'ssh_check_failed' })
    const bad = join(root, 'bad-config')
    await writeFile(bad, 'Host a\n  NoSuchOptionAtAll yes\n')
    expect((await systemSshVerifier()({ config: bad, hosts: ['a'] })).ok).toBe(false)
  })

  it('finds ssh clients without duplicates', () => {
    const found = findSshClients()
    expect(found.length).toBeGreaterThan(0)
    expect(new Set(found.map((row) => row.toLowerCase())).size).toBe(found.length)
  })

  it.skipIf(process.platform === 'win32')(
    "applies the aliases to every host, whatever the user's own blocks say further down",
    async () => {
      const { editor, userConfig, home } = await bed({
        mousseInsideHome: false,
        verify: systemSshVerifier()
      })
      await mkdir(join(home, '.ssh'))
      await writeFile(
        userConfig,
        'AddKeysToAgent yes\nHost *\n  User someone-else\n  Port 2222\n  ProxyCommand nc %h %p\n'
      )
      const box = computer('Work box', 'bob')
      const result = await editor.prepare([box])
      if (!result.ok) throw new Error(result.message)
      const alias = result.status.computers[0]!.alias
      const values = resolved(userConfig, alias)
      expect(values.get('user')).toBe('bob')
      expect(values.get('proxycommand')).toContain('net ssh-proxy')
      // The user's own hosts are untouched.
      expect(resolved(userConfig, 'elsewhere').get('user')).toBe('someone-else')
      expect(resolved(userConfig, 'elsewhere').get('port')).toBe('2222')
    }
  )
})

/** The Windows rule that made this a hard requirement: a loose ACL on an included file breaks every ssh. */
describe.skipIf(process.platform !== 'win32')('on Windows', () => {
  const win32Ssh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  const icacls = (...args: string[]) =>
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, {
      encoding: 'utf8'
    })

  it('takes inherited access entries off the Mousse folder before writing into it', async () => {
    const { mousseHome, editor, paths: p } = await bed({ mousseInsideHome: false })
    // The Mousse home carries an access entry for a group that is not the user, SYSTEM or Administrators.
    await mkdir(mousseHome, { recursive: true })
    expect(icacls(mousseHome, '/grant', '*S-1-1-0:(OI)(CI)M').status).toBe(0)
    expect(icacls(mousseHome).stdout).toMatch(/Everyone/u)

    const result = await editor.prepare([computer('Box')])
    expect(result.ok).toBe(true)
    for (const file of [p.dir, p.config, p.state, join(p.profiles, 'default.json')]) {
      const listing = icacls(file).stdout
      expect(listing, file).not.toMatch(/Everyone/u)
      expect(listing, file).toMatch(/NT AUTHORITY\\SYSTEM/u)
      // Only the user, SYSTEM and Administrators.
      expect((listing.match(/:\(/gu) ?? []).length, file).toBe(3)
    }
  })

  it.skipIf(!existsSync(win32Ssh))(
    'leaves Win32-OpenSSH able to read every host after the line is added',
    async () => {
      const { mousseHome, userConfig, home, make } = await bed({
        mousseInsideHome: false,
        verify: systemSshVerifier()
      })
      await mkdir(mousseHome, { recursive: true })
      expect(icacls(mousseHome, '/grant', '*S-1-1-0:(OI)(CI)M').status).toBe(0)
      await mkdir(join(home, '.ssh'))
      await writeFile(userConfig, 'Host a\n  User a\n')
      const result = await make().prepare([computer('Box')])
      expect(result).toMatchObject({ ok: true, added: true })
      for (const host of ['a', 'github.com', 'mousse-check.invalid']) {
        const run = spawnSync(win32Ssh, ['-F', userConfig, '-G', host], { encoding: 'utf8' })
        expect(run.status, run.stderr).toBe(0)
      }
    }
  )

  it.skipIf(!existsSync(win32Ssh))(
    'refuses to add the line, and says why, when Win32-OpenSSH cannot read the file',
    async () => {
      const {
        home,
        userConfig,
        paths: p,
        make
      } = await bed({
        mousseInsideHome: false,
        verify: systemSshVerifier()
      })
      const editor = make()
      const box = computer('Box')
      // Once the folder is private, make the config readable by Everyone again behind Mousse's back.
      await editor.prepare([box])
      await editor.disable()
      await mkdir(join(home, '.ssh'), { recursive: true })
      await writeFile(userConfig, 'Host a\n')
      expect(icacls(p.config, '/grant', '*S-1-1-0:M').status).toBe(0)
      const result = await editor.enable([box])
      expect(result).toMatchObject({ ok: false, code: 'ssh_check_failed' })
      expect(!result.ok && result.message).toMatch(/Bad (owner or )?permissions/iu)
      expect(await readFile(userConfig, 'utf8')).toBe('Host a\n')
    }
  )
})

describe('through the service', () => {
  async function service(withEditor: boolean, profile = 'default') {
    const { root, home, mousseHome, userConfig } = await bed()
    const profileDir = join(root, `profile ${profile}`)
    await mkdir(profileDir)
    const net = new NetService({
      profileDir,
      ...(withEditor ? { editorSsh: { home, mousseHome, cli: CLI, profile, verify: passes } } : {})
    })
    cleanup.push(() => net.shutdown())
    return { net, userConfig, home, profileDir, root, mousseHome }
  }

  it('lists the methods', () => {
    expect(NET_LOCAL_METHODS.filter((method) => method.startsWith('net.editor.ssh.'))).toEqual([
      'net.editor.ssh.status',
      'net.editor.ssh.prepare',
      'net.editor.ssh.enable',
      'net.editor.ssh.disable',
      'net.editor.ssh.ack'
    ])
  })

  it('reads and undoes while networking is off, and sets up only once Net is on', async () => {
    const { net, userConfig, home, profileDir } = await service(true)
    expect(await net.request('net.editor.ssh.status', {})).toMatchObject({
      available: true,
      enabled: true,
      included: false
    })
    await expect(
      Promise.resolve().then(() => net.request('net.editor.ssh.prepare', {}))
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(await net.request('net.editor.ssh.disable', {})).toMatchObject({ ok: true, removed: 0 })
    expect(existsSync(join(home, '.ssh'))).toBe(false)
    expect(existsSync(join(profileDir, 'net'))).toBe(false)

    await expect(
      Promise.resolve().then(() => net.request('net.editor.ssh.enable', {}))
    ).rejects.toMatchObject({ code: 'disabled' })
    await net.request('net.init', { name: 'this computer' })
    const result = await net.request('net.editor.ssh.enable', {})
    expect(result).toMatchObject({
      ok: true,
      added: true,
      status: { included: true, computers: [] }
    })
    expect(await readFile(userConfig, 'utf8')).toBe('Include ~/.mousse/ssh/config\n')
    expect(await net.request('net.editor.ssh.prepare', {})).toMatchObject({
      ok: true,
      added: false
    })
    expect(await net.request('net.editor.ssh.ack', {})).toMatchObject({ noticePending: false })
    expect(await net.request('net.editor.ssh.disable', {})).toMatchObject({ ok: true, removed: 1 })
    expect(await readFile(userConfig, 'utf8')).toBe('')
    expect(await net.request('net.editor.ssh.prepare', {})).toMatchObject({
      ok: false,
      code: 'off'
    })
  })

  it('does nothing when the build gives the service no home directory', async () => {
    const { net } = await service(false)
    expect(await net.request('net.editor.ssh.status', {})).toMatchObject({ available: false })
    expect(await net.request('net.editor.ssh.disable', {})).toMatchObject({
      ok: false,
      code: 'unavailable'
    })
  })

  it('lists the other computers only, and follows the device list as computers are added and revoked', async () => {
    const authority = await service(true)
    await authority.net.request('net.init', { name: 'authority', listen: true, port: 0 })
    await authority.net.request('net.protect', { passphrase: 'test-authority-protection' })
    const prepared = (await authority.net.request('net.editor.ssh.enable', {})) as {
      status: EditorSshStatus
    }
    // The authority itself is never listed.
    expect(prepared.status.computers).toEqual([])

    const joined = async (name: string) => {
      const follower = await service(false)
      const invite = (await authority.net.request('bridge.invite', {})) as { invite: string }
      const enrolled = (await follower.net.request('bridge.join', {
        invite: invite.invite,
        name
      })) as { node: string }
      return enrolled.node as NodeId
    }
    const laptop = await joined('Laptop')
    await vi.waitFor(async () => {
      const status = (await authority.net.request('net.editor.ssh.status', {})) as EditorSshStatus
      expect(status.computers.map((row) => row.node)).toEqual([laptop])
    })
    const config = await readFile(join(authority.mousseHome, 'ssh', 'config'), 'utf8')
    expect(config).toContain(`ssh-proxy ${laptop} --profile default`)

    // A phone is not listed: it has no folders to open.
    await authority.net.request('bridge.setKind', { node: laptop, kind: 'phone' })
    expect(
      ((await authority.net.request('net.editor.ssh.prepare', {})) as { status: EditorSshStatus })
        .status.computers
    ).toEqual([])
    await authority.net.request('bridge.setKind', { node: laptop, kind: 'computer' })
    expect(
      (
        (await authority.net.request('net.editor.ssh.prepare', {})) as { status: EditorSshStatus }
      ).status.computers.map((row) => row.node)
    ).toEqual([laptop])

    // A revoked computer loses its alias.
    await authority.net.request('bridge.revoke', { node: laptop })
    await vi.waitFor(async () => {
      const status = (await authority.net.request('net.editor.ssh.status', {})) as EditorSshStatus
      expect(status.computers).toEqual([])
    })
    expect(await readFile(join(authority.mousseHome, 'ssh', 'config'), 'utf8')).not.toContain(
      laptop
    )
  }, 30_000)

  it("writes Mousse's own file again when the service starts", async () => {
    const authority = await service(true)
    await authority.net.request('net.init', { name: 'authority' })
    await authority.net.request('net.editor.ssh.enable', {})
    const file = join(authority.mousseHome, 'ssh', 'config')
    await writeFile(file, '# stale\n')
    const restarted = new NetService({
      profileDir: authority.profileDir,
      editorSsh: {
        home: authority.home,
        mousseHome: authority.mousseHome,
        cli: '/Applications/Mousse.app/Contents/Resources/mousse-cli',
        verify: passes
      }
    })
    cleanup.push(() => restarted.shutdown())
    await restarted.start()
    await vi.waitFor(async () => expect(await readFile(file, 'utf8')).not.toContain('# stale'))
  })
})

describe('which daemon the ProxyCommand reaches', () => {
  const proxyLines = async (editor: Awaited<ReturnType<typeof bed>>['editor'], config: string) => {
    const result = await editor.prepare([computer('Work box', 'bob')])
    if (!result.ok) throw new Error(result.message)
    return readFile(config, 'utf8').then((text) =>
      text.split('\n').filter((line) => line.includes('ProxyCommand'))
    )
  }

  it('leaves --home out for the default Mousse home', async () => {
    const { editor, paths: p } = await bed()
    const lines = await proxyLines(editor, p.config)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('--home')
  })

  it('writes the Mousse home, quoted like the program, when it is not the default', async () => {
    const { editor, paths: p, mousseHome } = await bed({ mousseInsideHome: false })
    const lines = await proxyLines(editor, p.config)
    expect(lines).toHaveLength(1)
    const home = mousseHome.split(sep).join('/')
    // The home has a space in its path (the bed's folders do), so it is quoted.
    expect(lines[0]).toMatch(/ --profile default --home /u)
    expect(lines[0]!.endsWith(process.platform === 'win32' ? `"${home}"` : `'${home}'`)).toBe(true)
  })

  it('writes a home next to the home directory that is not ~/.mousse, and ignores a spelling of the default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse editor '))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home dir')
    await mkdir(home, { recursive: true })
    const make = (mousseHome: string) =>
      new EditorSshConfig({ home, mousseHome, cli: CLI, profile: 'default', verify: passes })
    const defaults = make(join(home, '.mousse', '..', '.mousse'))
    const text = await proxyLines(defaults, defaults.paths.config)
    expect(text[0]).not.toContain('--home')
    const other = make(join(home, '.mousse-dev'))
    expect((await proxyLines(other, other.paths.config))[0]).toContain('--home')
  })

  it('refuses a home that no shell can be told about, as it does a program path', () => {
    expect(() =>
      proxyCommand('/usr/bin/mousse-cli', newId('node'), 'p', 'linux', String.raw`C:\x`)
    ).toThrow()
    expect(() =>
      proxyCommand('C:/m/mousse-cli.cmd', newId('node'), 'p', 'win32', String.raw`C:\a$b`)
    ).toThrow()
  })
})
