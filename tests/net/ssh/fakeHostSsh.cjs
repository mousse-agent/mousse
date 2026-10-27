/*
 * A stand-in for `ssh` that is also the remote machine. It never reaches a real host: it keeps a
 * scripted machine in `$FAKE_SSH_DIR/host.json`, answers `ssh -G` from `config.json`, writes the host
 * key the way OpenSSH does for the retrieval options, checks host keys for strict runs, and "runs"
 * the remote scripts Mousse sends by reading their first line (`# mousse:<step>`) and applying the
 * step to the scripted machine. The login "shell" is strict: only `exec /bin/sh -c '<one word>'`
 * works, and a command string with a backslash is rejected the way fish would mangle it.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const dir = process.env.FAKE_SSH_DIR
const file = (name) => path.join(dir, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const state = read('host.json')
const save = () => fs.writeFileSync(file('host.json'), JSON.stringify(state, null, 2))
const args = process.argv.slice(2)
const append = (name, entry) => fs.appendFileSync(file(name), JSON.stringify(entry) + '\n')
const fail = (text, code = 255) => {
  process.stderr.write(text + '\n')
  process.exit(code)
}

if (args.includes('-G')) {
  append('config.log', args)
  process.stdout.write(read('config.json').join('\n') + '\n')
  process.exit(0)
}

const sep = args.indexOf('--')
const host = args[sep + 1]
const command = args[sep + 2]
const optionValue = (prefix) => {
  const found = args.find((value) => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}
const sshPort = args.includes('-p') ? args[args.indexOf('-p') + 1] : '22'
const lookupName = sshPort === '22' ? host : '[' + host + ']:' + sshPort
const hostKey = state.hostKey

// Phase 1: the retrieval writes the key it was offered into the temporary known_hosts file.
if (optionValue('StrictHostKeyChecking=') === 'accept-new') {
  append('calls.log', { kind: 'retrieve', args })
  if (state.unreachable) fail('ssh: connect to host ' + host + ' port ' + sshPort + ': Connection timed out')
  const files = [...(optionValue('UserKnownHostsFile=') || '').matchAll(/"([^"]*)"/g)].map((m) => m[1])
  const plain = args.includes('HashKnownHosts=no')
  let names = lookupName
  if (!plain) {
    const salt = crypto.randomBytes(20)
    names = '|1|' + salt.toString('base64') + '|' + crypto.createHmac('sha1', salt).update(lookupName).digest('base64')
  }
  if (args.includes('PubkeyAuthentication=no')) {
    fs.writeFileSync(files[0], names + ' ' + hostKey.type + ' ' + hostKey.key + '\n')
    fail('Permission denied (publickey).')
  }
  fail('unexpected retrieval')
}

// Strict runs: the host key must be in one of the known_hosts files this run names.
const names = [...(optionValue('UserKnownHostsFile=') || '').matchAll(/"([^"]*)"/g)].map((m) => m[1])
const known = names.some((name) => {
  try {
    return fs
      .readFileSync(name, 'utf8')
      .split('\n')
      .some((line) => {
        const [first, type, key] = line.split(' ')
        let matches = first === lookupName
        if (first && first.startsWith('|1|')) {
          const [, , salt, hash] = first.split('|')
          matches = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(lookupName).digest('base64') === hash
        }
        return matches && type === hostKey.type && key === hostKey.key
      })
  } catch {
    return false
  }
})
const globalKnown = (state.globalKnown || []).includes(lookupName)
if (!known && !globalKnown) fail('Host key verification failed.')
if (state.auth === 'denied') fail('me@box: Permission denied (publickey).')

if (args.includes('-W')) {
  append('calls.log', { kind: 'forward', args })
  if (state.forward === 'prohibited') fail('channel 0: open failed: administratively prohibited: open failed\nstdio forwarding failed')
  fail('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed')
}

// ---- the remote login shell
if (typeof command !== 'string' || !command.startsWith('exec /bin/sh -c ')) fail('bash: syntax error near unexpected token', 2)
if (command.includes('\\')) fail('fish: mangled command string', 2)
const word = command.slice('exec /bin/sh -c '.length)
const unquote = (text) => {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1)
      out += text.slice(i + 1, end)
      i = end + 1
    } else {
      out += c
      i++
    }
  }
  return out
}
const script = unquote(word)
// Tokens of one command line, the way sh would split it.
const words = (line) => {
  const out = []
  let current = ''
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1)
      current += line.slice(i + 1, end)
      started = true
      i = end
    } else if (/\s/.test(c)) {
      if (started) out.push(current)
      current = ''
      started = false
    } else {
      current += c
      started = true
    }
  }
  if (started) out.push(current)
  return out
}

let stdin = ''
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => run(Buffer.concat(chunks)))
process.stdin.on('error', () => run(Buffer.concat(chunks)))
let ran = false

function run(input) {
  if (ran) return
  ran = true
  stdin = input.toString('utf8')
  const step = /^# mousse:(\S+)/m.exec(script)?.[1] || 'unknown'
  const lines = script.split('\n').filter(Boolean)
  const cliLine = lines.find((line) => /^'[^']*mousse-cli'/.test(line.trim())) || ''
  const call = { kind: 'run', step, args, script, stdinBytes: input.length, stdin: step === 'join' ? '<invite>' : stdin.slice(0, 4000), cli: cliLine ? words(cliLine.replace(/^\s+/, '')) : [] }
  append('calls.log', call)
  const out = (text) => process.stdout.write(text)
  const launcherPath = state.home + '/.local/bin/mousse-cli'
  const sandboxOk = () => !!state.launcher && state.launcher.includes('ELECTRON_DISABLE_SANDBOX=1')
  const cliPath = () => (state.externalCli ? state.externalCli : state.launcher ? launcherPath : '')
  const requireCli = () => {
    // Every mousse-cli call must go through an absolute path; a bare name would not be on PATH.
    const used = call.cli[0]
    if (used && used !== cliPath() && !state.externalCli) fail('mousse-cli: command not found', 127)
    if (!state.externalCli && !sandboxOk()) fail('The SUID sandbox helper binary was not found', 1)
  }
  const launcherVersion = () => /\/cli\/([^/]+)\/squashfs-root/.exec(state.launcher || '')?.[1]
  const crash = state.crashOn
  const mutate = () => {
    if (crash && crash === step) {
      save()
      // The remote command finished but the client is told nothing: its connection dies.
      process.exit(255)
    }
    save()
  }
  if (state.hangOn === step) {
    setInterval(() => {}, 1000)
    return
  }
  switch (step) {
    case 'probe': {
      const t = state.tools || []
      out('@@uname\n' + state.os + '\n')
      out('@@home\n' + state.home + '\n')
      out('@@user\n' + state.user + '\n')
      out('@@launcher\n' + (state.launcher || '') + '\n')
      out('@@launcherx\n' + (state.launcher ? 'yes' : '') + '\n')
      out('@@path\n' + (state.pathCli || '') + '\n')
      out('@@app\n\n')
      out('@@cli\n' + cliPath() + '\n')
      out('@@version\n' + (cliPath() ? 'mousse-cli ' + (state.cliVersion || '0.1.0') : '') + '\n')
      out('@@service\n' + (cliPath() ? JSON.stringify({ running: !!state.running, version: state.cliVersion, startup: { installed: !!state.serviceInstalled } }) : '') + '\n')
      if (state.running) out('@@net\n' + JSON.stringify(state.enrolled ? { self: { node: state.node } } : {}) + '\n')
      out('@@tools\n' + t.join('\n') + '\n')
      out('@@unit\n' + (state.unitExists || state.serviceInstalled ? 'yes' : '') + '\n')
      out('@@df\n/dev/sda1 100 100 ' + (state.freeKb ?? 9000000) + ' 1% /\n')
      out('@@linger\n' + (state.linger ? 'Linger=' + state.linger : '') + '\n')
      out('@@end\n')
      return process.exit(0)
    }
    case 'install-fetch':
      if (state.noGithub) fail('curl: (6) Could not resolve host: github.com', 21)
      if (!script.includes("--proto '=https'") && !script.includes('--proto "=https"') && !script.includes('=https')) fail('not https', 1)
      state.downloaded = true
      mutate()
      return process.exit(0)
    case 'install-upload':
      state.downloaded = true
      state.uploadedBytes = input.length
      mutate()
      return process.exit(0)
    case 'install-verify':
      if (!state.downloaded) fail('no such file', 1)
      state.checksumLine = stdin
      if (state.badChecksum) fail('mousse-cli.AppImage: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match', 1)
      state.extracted = true
      mutate()
      return process.exit(0)
    case 'install-launcher':
      state.launcher = stdin
      mutate()
      return process.exit(0)
    case 'reconcile-install':
      if (state.launcher && state.extracted && script.includes('mousse-managed')) {
        const marker = /mousse-managed ([A-Za-z0-9_-]+)/.exec(state.launcher)?.[1]
        if (marker && script.includes(marker)) out('ready\n')
      }
      return process.exit(0)
    case 'service-install':
      requireCli()
      if (!call.cli.includes('--headless')) fail('missing --headless', 1)
      state.serviceInstalled = true
      state.running = !state.serviceStopped
      state.unitUsedEnv = sandboxOk()
      mutate()
      return process.exit(0)
    case 'service-status':
      requireCli()
      out(JSON.stringify({ running: !!state.running, version: launcherVersion() || state.cliVersion, startup: { installed: !!state.serviceInstalled } }) + '\n')
      return process.exit(0)
    case 'service-start':
      state.running = true
      mutate()
      return process.exit(0)
    case 'service-uninstall':
      requireCli()
      state.serviceInstalled = false
      state.running = false
      mutate()
      out('{"installed":false}\n')
      return process.exit(0)
    case 'service-restart':
      state.running = !(state.brokenVersions || []).includes(launcherVersion())
      mutate()
      return process.exit(0)
    case 'linger-show':
      out('Linger=' + (state.linger || 'no') + '\n')
      return process.exit(0)
    case 'linger-enable':
      if (state.lingerFails) fail('Failed to enable linger: Interactive authentication required.', 1)
      state.linger = 'yes'
      mutate()
      return process.exit(0)
    case 'net-status':
      requireCli()
      out(JSON.stringify(state.enrolled ? { self: { node: state.node } } : {}) + '\n')
      return process.exit(0)
    case 'join': {
      requireCli()
      if (state.joinFails) fail(state.joinFails, 1)
      const name = call.cli[call.cli.indexOf('--name') + 1]
      const via = call.cli[call.cli.indexOf('--via') + 1]
      if (!args.includes('ExitOnForwardFailure=yes') || !args.includes('-R')) fail('no reverse forward', 1)
      if (args.includes('ClearAllForwardings=yes')) fail('forwardings were cleared', 1)
      if (!stdin.startsWith('mj1_')) fail('no invitation on stdin', 1)
      state.joinedAs = name
      state.joinInvite = stdin.trim()
      state.joinedVia = via
      state.enrolled = true
      state.node = state.nextNode
      mutate()
      if (state.dropJoinReply) process.exit(255)
      out(JSON.stringify({ user: 'usr_x', node: state.node, authority: 'nod_auth' }) + '\n')
      return process.exit(0)
    }
    case 'transports':
      requireCli()
      out(JSON.stringify({ manifests: [], saved: state.transports || [] }) + '\n')
      return process.exit(0)
    case 'addon-configure': {
      requireCli()
      const settings = JSON.parse(stdin)
      const disable = call.script.includes('--disable')
      state.transports = (state.transports || []).filter((row) => row.id !== 'ssh')
      state.transports.push({ id: 'ssh', enabled: !disable, settings })
      state.settingsViaFile = /--settings-file "\$f"/.test(script) && /mktemp/.test(script)
      mutate()
      return process.exit(0)
    }
    case 'routes': {
      requireCli()
      const row = (state.transports || []).find((item) => item.id === 'ssh' && item.enabled)
      out(JSON.stringify({ signed: { payload: 'x', sig: 'y' }, routes: row ? [{ transport: 'ssh', address: 'ssh://' + row.settings.endpoint + '/127.0.0.1:' + row.settings.port, priority: 40 }] : [] }) + '\n')
      return process.exit(0)
    }
    case 'undo-launcher': {
      if (!state.launcher) return process.exit(0)
      const marker = /(# mousse-managed [A-Za-z0-9_-]+)/.exec(script)?.[1]
      const owned = marker && state.launcher.includes(marker.replace(/^# /, '# '))
      if (!owned) fail('changed', 3)
      delete state.launcher
      mutate()
      return process.exit(0)
    }
    case 'undo-install':
      state.extracted = false
      state.removedInstall = true
      mutate()
      return process.exit(0)
    case 'list-installs':
      out((state.installs || []).join('\n') + '\n')
      return process.exit(0)
    default:
      fail('unknown step ' + step, 1)
  }
}
