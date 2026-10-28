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
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EDITOR_SSH_NOTICE,
  EditorSshConfig,
  editorSshPaths,
  includeSpellings,
  insertInclude,
  proxyCommand,
  removeInclude,
  renderConfig,
  type LiveComputer
} from '../../../src/mms/net/editor/sshConfig'
import { NetService } from '../../../src/mms/net/NetService'
import { newId, type NodeId } from '../../../src/shared/net'
import { NET_LOCAL_METHODS } from '../../../src/shared/net/local'
import { KEY_A, KEY_B, KEY_RSA } from '../ssh/bed'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** A program path with a space, as in `C:\Program Files` or `Application Support`. */
const CLI = join(tmpdir(), 'mousse app', 'mousse-cli').replace(/\\/gu, '/')

/** A temporary HOME and Mousse home, both with a space in the path. Nothing here is the real home. */
async function bed(options: { mousseInsideHome?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mousse editor '))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home dir')
  await mkdir(home)
  const mousseHome =
    options.mousseInsideHome === false ? join(root, 'mousse home') : join(home, '.mousse')
  const editor = new EditorSshConfig({ home, mousseHome, cli: CLI })
  return {
    root,
    home,
    mousseHome,
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
    const result = remove(text)
    expect(result).toEqual({ text: original, removed: 1 })
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

  it('refuses characters ssh would read as a token, a glob or an escape', () => {
    for (const home of ['/srv/100%', '/srv/${HOME}', '/srv/a"b', '/srv/a[1]', '/srv/a\\b'])
      expect(() => includeSpellings(paths('linux', '/home/me', home), 'linux')).toThrow(
        /cannot take/
      )
  })

  it('builds a ProxyCommand that survives spaces, quotes and percent signs', () => {
    const node = newId('node')
    expect(proxyCommand('/usr/local/bin/mousse-cli', node, 'linux')).toBe(
      `/usr/local/bin/mousse-cli net ssh-proxy ${node}`
    )
    expect(proxyCommand('/opt/Mousse App/mousse-cli', node, 'linux')).toBe(
      `'/opt/Mousse App/mousse-cli' net ssh-proxy ${node}`
    )
    expect(proxyCommand("/opt/it's/mousse-cli", node, 'linux')).toBe(
      `'/opt/it'"'"'s/mousse-cli' net ssh-proxy ${node}`
    )
    expect(proxyCommand('/opt/100%/mousse-cli', node, 'linux')).toBe(
      `/opt/100%%/mousse-cli net ssh-proxy ${node}`
    )
    expect(proxyCommand('C:\\Program Files\\Mousse\\mousse-cli.cmd', node, 'win32')).toBe(
      `"C:/Program Files/Mousse/mousse-cli.cmd" net ssh-proxy ${node}`
    )
    expect(() => proxyCommand('C:\\a$b\\mousse-cli.cmd', node, 'win32')).toThrow()
    expect(() => proxyCommand('/x/mousse-cli', 'nod_nope' as NodeId, 'linux')).toThrow()
  })

  it('renders one block per computer, the same way every time', () => {
    const a = computer('Work box', 'bob'),
      b = computer('Étude', 'John Doe')
    const rendered = [
      { node: a.node, alias: 'mousse-work-box-aaaaaa', name: a.name, user: a.user },
      { node: b.node, alias: 'mousse-etude-bbbbbb', name: b.name, user: b.user }
    ]
    const context = {
      knownHosts: '/home/me/.mousse/ssh/known_hosts',
      cli: '/opt/mousse-cli',
      platform: 'linux' as const
    }
    const text = renderConfig(rendered, context)
    expect(renderConfig([...rendered].reverse(), context)).toBe(text)
    expect(text).toContain('Host mousse-work-box-aaaaaa\n')
    expect(text).toContain('  User bob\n')
    expect(text).toContain('  User "John Doe"\n')
    expect(text).toContain(`  ProxyCommand /opt/mousse-cli net ssh-proxy ${a.node}\n`)
    expect(text).toContain('  HostKeyAlias mousse-work-box-aaaaaa\n')
    expect(text).toContain('  UserKnownHostsFile /home/me/.mousse/ssh/known_hosts\n')
    for (const setting of [
      'StrictHostKeyChecking yes',
      'Port 22',
      'ForwardAgent no',
      'ForwardX11 no',
      'ControlMaster no',
      'UpdateHostKeys no'
    ])
      expect(text).toContain(`  ${setting}\n`)
  })

  it('leaves the User line out when the name cannot be written safely', () => {
    const a = computer('Box')
    for (const user of ['-oProxyCommand=x', 'a"b', 'a\nb', 'a\\b', '', undefined]) {
      const text = renderConfig([{ node: a.node, alias: 'mousse-box-aaaaaa', name: 'Box', user }], {
        knownHosts: '/k',
        cli: 'mousse-cli',
        platform: 'linux'
      })
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
          user: undefined
        }
      ],
      { knownHosts: '/k', cli: 'mousse-cli', platform: 'linux' }
    )
    expect(text.split('\n').filter((line) => /^Host /u.test(line))).toEqual([
      'Host mousse-x-aaaaaa'
    ])
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
    if (process.platform !== 'win32') {
      expect((await stat(p.config)).mode & 0o777).toBe(0o600)
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

  it('keeps the file mode of an existing config', async () => {
    if (process.platform === 'win32') return
    const { editor, userConfig, home } = await bed()
    await mkdir(join(home, '.ssh'))
    await writeFile(userConfig, 'Host a\n')
    await chmod(userConfig, 0o640)
    await editor.prepare([computer('Box')])
    expect((await stat(userConfig)).mode & 0o777).toBe(0o640)
  })

  it('leaves no temporary files beside the config', async () => {
    const { editor, home, paths: p } = await bed()
    await editor.prepare([computer('Box')])
    await editor.disable()
    await editor.enable([computer('Box')])
    expect((await readdir(join(home, '.ssh'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect((await readdir(p.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
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
})

describe('pinned host keys', () => {
  it('pins a key under the alias, replaces a key of the same type and keeps other types', async () => {
    const { editor, paths: p } = await bed()
    const box = computer('Box')
    const prepared = await editor.prepare([box])
    if (!prepared.ok) throw new Error('unreachable')
    const alias = prepared.status.computers[0]!.alias
    expect(await editor.pinHostKey(box.node, KEY_A)).toBe('added')
    expect(await editor.pinHostKey(box.node, KEY_A)).toBe('present')
    expect(await editor.pinHostKey(box.node, KEY_RSA)).toBe('added')
    expect(await editor.pinHostKey(box.node, KEY_B)).toBe('replaced')
    const lines = (await readFile(p.knownHosts, 'utf8')).trim().split('\n')
    expect(lines.sort()).toEqual(
      [`${alias} ${KEY_B.type} ${KEY_B.key}`, `${alias} ${KEY_RSA.type} ${KEY_RSA.key}`].sort()
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
    expect(values.get('port')).toBe('22')
    expect(values.get('stricthostkeychecking')).toBe('true')
    expect(values.get('hostname')).toBe('127.0.0.1')
    expect(values.get('proxycommand')).toBe(proxyCommand(CLI, box.node))
    expect(values.get('userknownhostsfile')?.replace(/\\/gu, '/')).toContain('/ssh/known_hosts')
  })

  it.skipIf(process.platform === 'win32')(
    "applies the aliases to every host, whatever the user's own blocks say further down",
    async () => {
      const { editor, userConfig, home } = await bed({ mousseInsideHome: false })
      await mkdir(join(home, '.ssh'))
      await writeFile(
        userConfig,
        'AddKeysToAgent yes\nHost *\n  User someone-else\n  Port 2222\n  ProxyCommand nc %h %p\n'
      )
      const box = computer('Work box', 'bob')
      const result = await editor.prepare([box])
      if (!result.ok) throw new Error('unreachable')
      const alias = result.status.computers[0]!.alias
      const values = resolved(userConfig, alias)
      expect(values.get('user')).toBe('bob')
      expect(values.get('port')).toBe('22')
      expect(values.get('proxycommand')).toContain('net ssh-proxy')
      // The user's own hosts are untouched.
      expect(resolved(userConfig, 'elsewhere').get('user')).toBe('someone-else')
      expect(resolved(userConfig, 'elsewhere').get('port')).toBe('2222')
    }
  )
})

describe('through the service', () => {
  async function service(withEditor: boolean) {
    const { root, home, mousseHome, userConfig } = await bed()
    const profileDir = join(root, 'profile')
    await mkdir(profileDir)
    const net = new NetService({
      profileDir,
      ...(withEditor ? { editorSsh: { home, mousseHome, cli: CLI } } : {})
    })
    cleanup.push(() => net.shutdown())
    return { net, userConfig, home, profileDir }
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
})
