import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_RUNTIME_LABELS, type LocalRuntimeKind, type LocalServerRow } from '../../../shared/localServers'
import type { LocalFetch } from './http'
import { identifyServer, readServer } from './servers'

/**
 * Detection, run only when the person opens Add provider → Local models, on the computer the page shows: never at
 * start, never on a timer, never across the network. It asks the default ports of the nine runtimes on loopback,
 * recognises each answer by its endpoints, and looks for the installed apps that are not serving now.
 */

/** Ports to ask, each once: llama.cpp (9931 now, 8080 before), Ollama, LM Studio, Unsloth Studio, vLLM, Jan, KoboldCpp. 8080 is also LocalAI's and MLX's. */
export const LOCAL_PROBE_PORTS: readonly number[] = [9931, 8080, 11434, 1234, 8888, 8000, 1337, 5001]

/** How long one port may take to answer during detection. */
const PROBE_TIMEOUT_MS = 800

export interface DetectOptions {
  signal?: AbortSignal
  fetchImpl?: LocalFetch
  /** Hosts to ask (IPv4 loopback, then IPv6); a test seam. */
  hosts?: readonly string[]
  ports?: readonly number[]
  /** Whether an app is installed though not serving (`installedApps`); a test seam. */
  installed?: () => LocalRuntimeKind[]
}

/** The apps whose install Mousse can see on this computer, for a `Not running` row. Nothing is started. */
export function installedApps(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): LocalRuntimeKind[] {
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const candidates: Partial<Record<LocalRuntimeKind, string[]>> =
    platform === 'win32'
      ? {
          ollama: [join(local, 'Programs', 'Ollama', 'ollama.exe')],
          lmstudio: [join(local, 'Programs', 'LM Studio', 'LM Studio.exe'), join(home, '.lmstudio', 'bin', 'lms.exe')],
          unsloth: [join(home, '.unsloth', 'studio', 'bin', 'unsloth.exe'), join(home, '.unsloth', 'studio')],
          jan: [join(local, 'Programs', 'jan', 'Jan.exe'), join(local, 'Programs', 'Jan', 'Jan.exe')]
        }
      : platform === 'darwin'
        ? {
            ollama: ['/Applications/Ollama.app', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'],
            lmstudio: ['/Applications/LM Studio.app', join(home, '.lmstudio', 'bin', 'lms')],
            unsloth: [join(home, '.unsloth', 'studio')],
            jan: ['/Applications/Jan.app']
          }
        : {
            ollama: ['/usr/local/bin/ollama', '/usr/bin/ollama'],
            lmstudio: [join(home, '.lmstudio', 'bin', 'lms')],
            unsloth: [join(home, '.unsloth', 'studio')]
          }
  return (Object.entries(candidates) as Array<[LocalRuntimeKind, string[]]>).filter(([, paths]) => paths.some((path) => existsSync(path))).map(([kind]) => kind)
}

/**
 * Every server answering on a probed port, one row each, then a `Not running` row for each installed app that none
 * of them is. Rows of servers that are already connected say so (`connected`).
 */
export async function detectLocalServers(options: DetectOptions & { connected?: (root: string) => string | undefined } = {}): Promise<LocalServerRow[]> {
  const hosts = options.hosts ?? ['127.0.0.1', '[::1]']
  const ports = options.ports ?? LOCAL_PROBE_PORTS
  const read = { timeoutMs: PROBE_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }
  const rows = await Promise.all(ports.map(async (port): Promise<LocalServerRow | undefined> => {
    for (const host of hosts) {
      const root = `http://${host}:${port}`
      const identified = await identifyServer(root, read).catch(() => undefined)
      if (!identified) continue
      if (!identified.ok && identified.problem === 'not_a_model_server') break
      const kind = identified.kind ?? 'openai'
      const base = { kind, label: LOCAL_RUNTIME_LABELS[kind], baseUrl: `${root}/v1` }
      const providerId = options.connected?.(root)
      if (providerId) return { ...base, state: 'connected', providerId }
      if (!identified.ok) return { ...base, state: 'needs_key' }
      const models = await readServer(root, kind, read).catch(() => undefined)
      if (models && !models.ok && models.problem === 'needs_key') return { ...base, state: 'needs_key' }
      return { ...base, state: 'running', count: models?.ok ? models.models.length : 0 }
    }
    return undefined
  }))
  const found = rows.filter((row): row is LocalServerRow => row !== undefined)
  const serving = new Set(found.map((row) => row.kind))
  const idle = (options.installed ?? installedApps)().filter((kind) => !serving.has(kind))
  return [...found, ...idle.map((kind): LocalServerRow => ({ kind, label: LOCAL_RUNTIME_LABELS[kind], state: 'not_running' }))]
}
