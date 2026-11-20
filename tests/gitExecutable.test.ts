import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tryGit, tryGitAsync } from '../src/mms/actions/git'
import { findGitOnPath, gitEnvFor, gitFile, gitProgramSettled, resetGitProgram, resolveGitProgram, withLauncherEnvironment, type GitLocatorDeps } from '../src/mms/git/gitExecutable'
import { guardedSimpleGit } from '../src/mms/git/repoPrograms'

const ROOT = 'C:\\Program Files\\Git'
const LAUNCHER = `${ROOT}\\cmd\\git.exe`
const REAL = `${ROOT}\\mingw64\\bin\\git.exe`
/** How Git for Windows prints its exec path: forward slashes. */
const EXEC_PATH = 'C:/Program Files/Git/mingw64/libexec/git-core'

function machine(files: string[], path: string, execPaths: Record<string, string | undefined>, platform: NodeJS.Platform = 'win32'): GitLocatorDeps {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return { platform, path, isFile: (file) => present.has(file.toLowerCase()), execPath: async (file) => execPaths[file] }
}

describe('which Git Mousse starts', () => {
  // Every layout Git can be installed in that Mousse must tell apart. Only the first runs the real executable.
  const rows: Array<{ name: string; deps: GitLocatorDeps; runs: string; root?: string }> = [
    { name: 'standard install, both report its exec path', deps: machine([LAUNCHER, REAL], `C:\\Windows\\System32;${ROOT}\\cmd`, { [LAUNCHER]: EXEC_PATH, [REAL]: EXEC_PATH }), runs: REAL, root: ROOT },
    { name: 'standard install, exec path in another spelling', deps: machine([LAUNCHER, REAL], `${ROOT}\\cmd\\`, { [LAUNCHER]: 'c:\\program files\\git\\mingw64\\libexec\\git-core\\', [REAL]: EXEC_PATH }), runs: REAL, root: ROOT },
    { name: 'launcher runs another install', deps: machine([LAUNCHER, REAL], `${ROOT}\\cmd`, { [LAUNCHER]: 'D:/Other/mingw64/libexec/git-core', [REAL]: EXEC_PATH }), runs: LAUNCHER },
    { name: 'sibling does not run', deps: machine([LAUNCHER, REAL], `${ROOT}\\cmd`, { [LAUNCHER]: EXEC_PATH, [REAL]: undefined }), runs: LAUNCHER },
    { name: 'sibling reports another install', deps: machine([LAUNCHER, REAL], `${ROOT}\\cmd`, { [LAUNCHER]: EXEC_PATH, [REAL]: 'D:/Other/mingw64/libexec/git-core' }), runs: LAUNCHER },
    { name: 'no sibling', deps: machine([LAUNCHER], `${ROOT}\\cmd`, { [LAUNCHER]: EXEC_PATH }), runs: LAUNCHER },
    { name: 'scoop shim', deps: machine(['C:\\Users\\u\\scoop\\shims\\git.exe'], 'C:\\Users\\u\\scoop\\shims', {}), runs: 'C:\\Users\\u\\scoop\\shims\\git.exe' },
    { name: 'portable Git with bin on PATH', deps: machine(['D:\\PortableGit\\bin\\git.exe', 'D:\\PortableGit\\mingw64\\bin\\git.exe'], 'D:\\PortableGit\\bin', {}), runs: 'D:\\PortableGit\\bin\\git.exe' },
    { name: 'real executable itself on PATH', deps: machine([REAL], `${ROOT}\\mingw64\\bin`, {}), runs: REAL },
    { name: 'relative PATH entry with a git.exe is passed over', deps: machine(['.\\git.exe', 'tools\\git.exe', LAUNCHER, REAL], `.;tools;"${ROOT}\\cmd"`, { [LAUNCHER]: EXEC_PATH, [REAL]: EXEC_PATH }), runs: REAL, root: ROOT },
    { name: 'no Git on PATH', deps: machine([], 'C:\\Windows\\System32', {}), runs: 'git' },
    { name: 'macOS', deps: machine([LAUNCHER, REAL], `${ROOT}\\cmd`, { [LAUNCHER]: EXEC_PATH, [REAL]: EXEC_PATH }, 'darwin'), runs: 'git' },
    { name: 'Linux', deps: machine(['/usr/bin/git'], '/usr/bin', {}, 'linux'), runs: 'git' }
  ]
  it.each(rows)('$name', async ({ deps, runs, root }) => {
    const resolved = await resolveGitProgram(deps)
    expect(resolved.file).toBe(runs)
    // Only the real executable found through the launcher gets the launcher's environment.
    expect(resolved.root).toBe(root)
  })

  it('takes git.com before git.exe in the same folder, as Windows does', () => {
    expect(findGitOnPath('C:\\Tools', (file) => file === 'C:\\Tools\\git.com' || file === 'C:\\Tools\\git.exe')).toBe('C:\\Tools\\git.com')
  })
})

describe('the environment the real executable gets', () => {
  const exists = (folders: string[]) => (path: string) => folders.includes(path)

  it('adds what the launcher adds when the caller set none of it', () => {
    const env = { Path: 'C:\\Windows\\System32', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', USERPROFILE: 'C:\\Users\\profile' }
    const out = withLauncherEnvironment(env, ROOT, exists(['C:\\Users\\u']))
    expect(out.MSYSTEM).toBe('MINGW64')
    expect(out.PLINK_PROTOCOL).toBe('ssh')
    expect(out.HOME).toBe('C:\\Users\\u')
    expect(out.Path).toBe(`${ROOT}\\mingw64\\bin;${ROOT}\\usr\\bin;C:\\Users\\u\\bin;C:\\Windows\\System32`)
    // One PATH, under the caller's spelling of the name.
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path'])
    // The caller's object is left as it was.
    expect(env).toEqual({ Path: 'C:\\Windows\\System32', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', USERPROFILE: 'C:\\Users\\profile' })
  })

  it('takes USERPROFILE for HOME when HOMEDRIVE and HOMEPATH name no folder', () => {
    const out = withLauncherEnvironment({ PATH: 'C:\\x', HOMEDRIVE: 'C:', HOMEPATH: '\\Gone', USERPROFILE: 'C:\\Users\\profile' }, ROOT, exists([]))
    expect(out.HOME).toBe('C:\\Users\\profile')
    expect(out.PATH).toBe(`${ROOT}\\mingw64\\bin;${ROOT}\\usr\\bin;C:\\Users\\profile\\bin;C:\\x`)
  })

  it('keeps every value the caller set', () => {
    const out = withLauncherEnvironment({ path: 'C:\\mine', msystem: 'MSYS', Plink_Protocol: 'plink', Home: 'D:\\home', GIT_DIR: 'D:\\repo\\.git' }, ROOT, exists(['C:\\Users\\u']))
    expect(out).toEqual({
      path: `${ROOT}\\mingw64\\bin;${ROOT}\\usr\\bin;D:\\home\\bin;C:\\mine`,
      msystem: 'MSYS',
      Plink_Protocol: 'plink',
      Home: 'D:\\home',
      GIT_DIR: 'D:\\repo\\.git'
    })
  })

  it('leaves the environment alone off Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      resetGitProgram()
      const env = { PATH: '/usr/bin' }
      expect(gitFile()).toBe('git')
      expect(gitEnvFor(env)).toBe(env)
      expect(gitEnvFor(undefined)).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      resetGitProgram()
    }
  })
})

/** This computer's Git for Windows, when it has the standard layout. */
const installed = (() => {
  if (process.platform !== 'win32') return undefined
  const found = findGitOnPath(process.env.PATH, (file) => existsSync(file))
  if (!found) return undefined
  // A shell started from Git for Windows has `mingw64\bin` on PATH; the daemon has only `cmd`.
  const dir = win32.dirname(found)
  const root = win32.basename(dir).toLowerCase() === 'cmd' ? win32.dirname(dir) : win32.dirname(win32.dirname(dir))
  const launcher = win32.join(root, 'cmd', 'git.exe')
  const real = win32.join(root, 'mingw64', 'bin', 'git.exe')
  return existsSync(launcher) && existsSync(real) ? { launcher, root, real } : undefined
})()

// Real Git processes on a busy computer: the first ones can take seconds each.
describe.skipIf(!installed)('Git for Windows through the real executable', { timeout: 60_000 }, () => {
  const roots: string[] = []
  const path = process.env.PATH
  beforeEach(() => {
    process.env.PATH = daemonEnv().PATH
    resetGitProgram()
  })
  afterEach(() => {
    process.env.PATH = path
    resetGitProgram()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  function scratch(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-executable-')))
    roots.push(root)
    return root
  }
  /** The environment the daemon starts with: only the launcher's folder on PATH, nothing Git for Windows sets. */
  function daemonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(PATH|HOME|MSYSTEM|PLINK_PROTOCOL|MINGW_PREFIX|EXEPATH|SHELL|TERM|GIT_.*)$/i.test(key)) env[key] = value
    }
    env.PATH = `${installed!.root}\\cmd;${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
    return env
  }
  async function realGit(): Promise<void> {
    resetGitProgram()
    await gitProgramSettled()
    expect(gitFile().toLowerCase()).toBe(installed!.real.toLowerCase())
  }
  const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => spawnSync(file, args, { cwd, env, encoding: 'utf8', windowsHide: true })

  it('reads the same configuration, from the same files, as the launcher', async () => {
    await realGit()
    const repo = scratch()
    execFileSync(installed!.launcher, ['init', '-q'], { cwd: repo, env: daemonEnv() })
    execFileSync(installed!.launcher, ['config', 'mousse.marker', 'here'], { cwd: repo, env: daemonEnv() })
    const viaLauncher = run(installed!.launcher, ['config', '--list', '--show-origin'], repo, daemonEnv())
    const viaReal = run(gitFile(), ['config', '--list', '--show-origin'], repo, gitEnvFor(daemonEnv()))
    expect(viaLauncher.status).toBe(0)
    expect(viaReal.stdout).toBe(viaLauncher.stdout)
    expect(viaReal.stdout).toContain('mousse.marker=here')
    expect(viaReal.stdout).toContain('etc/gitconfig')
  })

  it('runs a command through sh, and a helper from mingw64\\bin', async () => {
    await realGit()
    const repo = scratch()
    const viaSh = run(gitFile(), ['-c', 'alias.shell-check=!echo "sh $0"', 'shell-check'], repo, gitEnvFor(daemonEnv()))
    expect(viaSh.stdout.trim()).toMatch(/^sh /)
    const helper = run(gitFile(), ['lfs', 'version'], repo, gitEnvFor(daemonEnv()))
    expect(helper.stdout).toMatch(/^git-lfs\//)
  })

  it('never runs a git.exe planted in the working folder', async () => {
    const repo = scratch()
    execFileSync(installed!.launcher, ['init', '-q'], { cwd: repo, env: daemonEnv() })
    // Any program other than Git: it prints this computer's name, not `.git`.
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(repo, 'git.exe'))
    // Before the check settles Mousse runs the launcher, after it the real executable: neither is the planted one.
    resetGitProgram()
    expect(tryGit(repo, ['rev-parse', '--git-dir']).stdout).toBe('.git')
    await gitProgramSettled()
    expect(gitFile().toLowerCase()).toBe(installed!.real.toLowerCase())
    expect(tryGit(repo, ['rev-parse', '--git-dir']).stdout).toBe('.git')
    expect((await tryGitAsync(repo, ['rev-parse', '--git-dir'])).stdout).toBe('.git')
  })

  it("starts the real executable for Mousse's own commands, their checks, and simple-git", async () => {
    await realGit()
    const repo = scratch()
    execFileSync(installed!.launcher, ['init', '-q'], { cwd: repo, env: daemonEnv() })
    const trace = join(scratch(), 'trace.json')
    process.env.GIT_TRACE2_EVENT = trace
    try {
      expect(tryGit(repo, ['rev-parse', '--git-dir']).ok).toBe(true)
      expect((await tryGitAsync(repo, ['rev-parse', '--git-dir'])).ok).toBe(true)
      await guardedSimpleGit(repo).raw(['rev-parse', '--git-dir'])
    } finally {
      delete process.env.GIT_TRACE2_EVENT
    }
    // Each Git Mousse started (not one Git started by another) names the program it was started as: the launcher starts
    // `git.exe` by name, Mousse the real executable by its path.
    const started = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; sid: string; argv?: string[] })
      .filter((event) => event.event === 'start' && !event.sid.includes('/'))
    expect(started.length).toBeGreaterThanOrEqual(3)
    expect(new Set(started.map((event) => event.argv![0]!.toLowerCase()))).toEqual(new Set([installed!.real.toLowerCase()]))
  })
})
