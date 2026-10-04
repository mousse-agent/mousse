import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)
it.skipIf(process.platform === 'win32').each([
  ['readInviteSecret', 'Invite (input hidden): '],
  ['readPassphraseSecret', 'Passphrase (input hidden): ']
])(
  'restores actual POSIX terminal flags after external SIGINT during %s',
  async (reader, prompt) => {
    const directory = await mkdtemp(join(tmpdir(), 'mousse-net-cli-pty-'))
    try {
      const fixture = join(directory, 'prompt.mjs')
      await build({
        stdin: {
          contents: `import { ${reader}, netCliFailure } from './src/cli/commands/net';
      try { await ${reader}() } catch (error) { process.exitCode = netCliFailure(error).exitCode }`,
          resolveDir: process.cwd(),
          sourcefile: 'prompt-fixture.ts'
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        outfile: fixture,
        logLevel: 'silent'
      })
      const python = `
import json, os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
output = b''
deadline = time.monotonic() + 8
try:
    while sys.argv[3].encode() not in output:
        if child.poll() is not None: raise RuntimeError('Child exited before hidden prompt: ' + repr(output))
        if time.monotonic() > deadline: raise RuntimeError('Prompt deadline: ' + repr(output))
        if select.select([master], [], [], 0.1)[0]: output += os.read(master, 65536)
    hidden = termios.tcgetattr(slave)
    secret = b'mj1_c2VjcmV0'
    os.write(master, secret)
    if select.select([master], [], [], 0.1)[0]: output += os.read(master, 65536)
    os.kill(child.pid, signal.SIGINT)
    child.wait(timeout=8)
    after = termios.tcgetattr(slave)
    print(json.dumps({'code': child.returncode, 'restored': before == after, 'echoDisabled': not (hidden[3] & termios.ECHO), 'rawEnabled': not (hidden[3] & termios.ICANON), 'secretEchoed': secret in output}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
`
      const { stdout } = await run('python3', ['-c', python, process.execPath, fixture, prompt], {
        timeout: 18_000
      })
      expect(JSON.parse(stdout)).toEqual({
        code: 130,
        restored: true,
        echoDisabled: true,
        rawEnabled: true,
        secretEchoed: false
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
