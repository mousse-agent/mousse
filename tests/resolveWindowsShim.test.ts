import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsShim, shimTarget } from '../src/mms/providers/resolveWindowsShim'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function prefix(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-shim-'))
  dirs.push(dir)
  return dir
}
function file(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}
/** A stand-in Windows program: the resolver only checks for the `MZ` header. */
const program = (path: string) => file(path, 'MZ')

/** The `.cmd` npm (cmd-shim) writes for a JavaScript bin. */
const npmJsCmd = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`
/** The `.cmd` npm writes for a native bin (Claude Code 2.x ships `bin/claude.exe`). */
const npmExeCmd = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
"%dp0%\\${target}"   %*\r
`
/** The extensionless shell shim npm writes beside the `.cmd`. */
const npmSh = (target: string) => `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${target}" "$@"
else
  exec node  "$basedir/${target}" "$@"
fi
`
const win = { platform: 'win32' as const, arch: 'x64' as const, env: {} }

/** A global npm prefix with `@openai/codex` 0.16x: a JS launcher plus a per-platform native package. */
function codexInstall(root: string): { shim: string; exe: string } {
  const pkg = join(root, 'node_modules', '@openai', 'codex')
  file(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
  file(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      bin: { codex: 'bin/codex.js' },
      optionalDependencies: {
        '@openai/codex-linux-x64': 'npm:@openai/codex@0.163.0-linux-x64',
        '@openai/codex-win32-arm64': 'npm:@openai/codex@0.163.0-win32-arm64',
        '@openai/codex-win32-x64': 'npm:@openai/codex@0.163.0-win32-x64'
      }
    })
  )
  const native = join(pkg, 'node_modules', '@openai', 'codex-win32-x64')
  file(join(native, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.163.0-win32-x64' }))
  const exe = program(join(native, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'))
  const shim = file(join(root, 'codex.cmd'), npmJsCmd('node_modules\\@openai\\codex\\bin\\codex.js'))
  file(join(root, 'codex'), npmSh('node_modules/@openai/codex/bin/codex.js'))
  return { shim, exe }
}

describe('Windows shim resolution', () => {
  it('finds the shim target, skipping the node runtime it may name', () => {
    expect(shimTarget(npmJsCmd('node_modules\\@openai\\codex\\bin\\codex.js'))).toBe('node_modules\\@openai\\codex\\bin\\codex.js')
    expect(shimTarget(npmExeCmd('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'))).toBe(
      'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
    )
    expect(shimTarget(npmSh('node_modules/x/cli.js'))).toBe('node_modules/x/cli.js')
    // pnpm writes `%~dp0\` paths.
    expect(shimTarget('@SETLOCAL\r\n"%~dp0\\..\\pkg\\cli.js" %*\r\n')).toBe('..\\pkg\\cli.js')
    expect(shimTarget('@echo off\r\nC:\\tools\\real.exe %*\r\n')).toBeUndefined()
  })

  it('resolves npm codex.cmd (and its shell shim) to the native codex.exe in the platform package', () => {
    const root = prefix()
    const { shim, exe } = codexInstall(root)
    expect(resolveWindowsShim(shim, win)).toEqual({ path: exe, command: exe, args: [] })
    expect(resolveWindowsShim(join(root, 'codex'), win)).toEqual({ path: exe, command: exe, args: [] })
  })

  it('finds the older vendor layout inside the package itself', () => {
    const root = prefix()
    const pkg = join(root, 'node_modules', '@openai', 'codex')
    file(join(pkg, 'bin', 'codex.js'))
    file(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    const exe = program(join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'))
    const shim = file(join(root, 'codex.cmd'), npmJsCmd('node_modules\\@openai\\codex\\bin\\codex.js'))
    expect(resolveWindowsShim(shim, win)?.command).toBe(exe)
  })

  it('resolves a shim that targets a native executable directly', () => {
    const root = prefix()
    const exe = program(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
    const shim = file(join(root, 'claude.cmd'), npmExeCmd('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'))
    expect(resolveWindowsShim(shim, win)).toEqual({ path: exe, command: exe, args: [] })
  })

  it('looks past a placeholder .exe left when the install script did not run', () => {
    const root = prefix()
    const pkg = join(root, 'node_modules', '@anthropic-ai', 'claude-code')
    file(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', optionalDependencies: { '@anthropic-ai/claude-code-win32-x64': '2.1.308' } }))
    file(join(pkg, 'bin', 'claude.exe'), 'echo "Error: claude native binary not installed." >&2\n')
    const shim = file(join(root, 'claude.cmd'), npmExeCmd('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'))
    expect(resolveWindowsShim(shim, win)).toBeUndefined()

    const native = join(pkg, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64')
    file(join(native, 'package.json'), '{}')
    const exe = program(join(native, 'claude.exe'))
    expect(resolveWindowsShim(shim, win)).toEqual({ path: exe, command: exe, args: [] })
  })

  it('runs a JavaScript-only CLI as node plus its entry script', () => {
    const root = prefix()
    const pkg = join(root, 'node_modules', '@anthropic-ai', 'claude-code')
    file(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }))
    const script = file(join(pkg, 'cli.js'))
    const shim = file(join(root, 'claude.cmd'), npmJsCmd('node_modules\\@anthropic-ai\\claude-code\\cli.js'))
    // No node.exe beside the shim or on PATH: nothing can run the script.
    expect(resolveWindowsShim(shim, win)).toBeUndefined()

    const pathNode = file(join(root, 'nodejs', 'node.exe'))
    expect(resolveWindowsShim(shim, { ...win, env: { Path: join(root, 'nodejs') } })).toEqual({
      path: script,
      command: pathNode,
      args: [script]
    })
    // The shim prefers the node.exe beside it, as npm's shim does.
    const beside = file(join(root, 'node.exe'))
    expect(resolveWindowsShim(shim, { ...win, env: { Path: join(root, 'nodejs') } })).toEqual({
      path: script,
      command: beside,
      args: [script]
    })
  })

  it('returns nothing for a script shim it cannot read or whose target is missing', () => {
    const root = prefix()
    expect(resolveWindowsShim(file(join(root, 'tool.cmd'), '@echo off\r\nC:\\tools\\real.exe %*\r\n'), win)).toBeUndefined()
    expect(resolveWindowsShim(file(join(root, 'gone.bat'), npmJsCmd('node_modules\\gone\\cli.js')), win)).toBeUndefined()
    expect(resolveWindowsShim(join(root, 'missing.cmd'), win)).toBeUndefined()
    // A target that is neither a program nor JavaScript (a shell script run by bash, say).
    file(join(root, 'node_modules', 'x', 'run.sh'))
    expect(resolveWindowsShim(file(join(root, 'x.cmd'), npmJsCmd('node_modules\\x\\run.sh')), win)).toBeUndefined()
  })

  it('starts programs and unrecognised extensionless files as they are', () => {
    const root = prefix()
    const exe = file(join(root, 'codex.exe'))
    expect(resolveWindowsShim(exe, win)).toEqual({ path: exe, command: exe, args: [] })
    const plain = file(join(root, 'tool'), '#!/bin/sh\nexit 0\n')
    expect(resolveWindowsShim(plain, win)).toEqual({ path: plain, command: plain, args: [] })
  })

  it('passes every path through unchanged on other platforms', () => {
    const root = prefix()
    const { shim } = codexInstall(root)
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveWindowsShim(shim, { platform })).toEqual({ path: shim, command: shim, args: [] })
      expect(resolveWindowsShim(join(root, 'codex'), { platform })).toEqual({
        path: join(root, 'codex'),
        command: join(root, 'codex'),
        args: []
      })
    }
  })
})
