import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { extractArchive } from '../../mms/harness/agents/archive'
import { downloadArtifact } from '../../mms/harness/agents/install'
import type { GitSetup } from '../../shared/gitSetup'

const run = promisify(execFile)
const release = 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1'
const assets = {
  x64: {
    name: 'MinGit-2.56.1-64-bit.zip',
    sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
  },
  arm64: {
    name: 'MinGit-2.56.1-arm64.zip',
    sha256: '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c'
  }
}

async function gitRuns(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await run(executable, ['--version'], {
      // Never probe from the project folder. The executable lookup uses the app's environment.
      cwd: dirname(process.execPath),
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
      windowsHide: true,
      timeout: 10_000,
      signal
    })
    if (!stdout.startsWith('git version ')) throw new Error('Git did not report its version.')
    return true
  } catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Preserve Windows' case-insensitive Path without leaving a second spelling for Node to pick. */
export function withWindowsGitPath(env: NodeJS.ProcessEnv, cmdDir: string | undefined): NodeJS.ProcessEnv {
  if (!cmdDir) return env
  const result = { ...env }
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === 'path').sort()
  const key = pathKeys[0] ?? 'Path'
  for (const duplicate of pathKeys.slice(1)) delete result[duplicate]
  const current = result[key]
  result[key] = current ? `${cmdDir};${current}` : cmdDir
  return result
}

/** Finds Git for a Windows desktop daemon, installing the official MinGit archive on demand. */
export async function ensureWindowsGit(options: {
  homeDir: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  onSetup: (state: Extract<GitSetup, { phase: 'downloading' | 'installing' }>) => void
  platform?: NodeJS.Platform
  arch?: string
}): Promise<string | undefined> {
  const { homeDir, env, signal, onSetup, platform = process.platform, arch = process.arch } = options
  if (platform !== 'win32' || await gitRuns('git', env, signal)) return undefined
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Install Git for Windows to use Mousse on this computer.')

  const asset = assets[arch]
  const root = join(homeDir, 'prerequisites', 'git')
  const destination = join(root, asset.name.slice(0, -4))
  const cmdDir = join(destination, 'cmd')
  if (await gitRuns(join(cmdDir, 'git.exe'), env, signal)) return cmdDir

  onSetup({ phase: 'downloading' })
  await mkdir(root, { recursive: true })
  const staging = await mkdtemp(join(root, '.setup-'))
  try {
    const archive = join(staging, asset.name)
    const downloaded = await downloadArtifact(`${release}/${asset.name}`, archive, {
      label: 'Git for Windows',
      maxBytes: 80 * 1024 * 1024,
      signal
    })
    if (downloaded.sha256 !== asset.sha256) throw new Error('The Git download did not match its official checksum.')

    onSetup({ phase: 'installing' })
    const extracted = join(staging, 'git')
    await extractArchive(archive, extracted, {
      format: 'zip',
      maxBytes: 256 * 1024 * 1024,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    })
    if (!await gitRuns(join(extracted, 'cmd', 'git.exe'), env, signal)) throw new Error('The Git download did not contain Git.')
    signal.throwIfAborted()
    try {
      await rename(extracted, destination)
    } catch (error) {
      // Another Mousse process can finish while this one is downloading. A complete copy wins.
      if (!await gitRuns(join(cmdDir, 'git.exe'), env, signal)) throw error
    }
    return cmdDir
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
