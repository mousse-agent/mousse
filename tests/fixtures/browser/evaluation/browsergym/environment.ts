import { spawnSync } from 'node:child_process'
import { BROWSERGYM_EXTERNAL_RUN_COMMAND, BROWSERGYM_MISSING_ENVIRONMENT, BROWSERGYM_PYPI_VERSION } from './protocol'

export interface BrowserGymEnvironmentProbe {
  available: boolean
  python: string | null
  version: string | null
  missing: string[]
  externalRunCommand: string[]
}

export function probeBrowserGymPython(): BrowserGymEnvironmentProbe {
  const pythonCandidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  for (const bin of pythonCandidates) {
    const probe = spawnSync(bin, ['-c', 'import importlib.metadata as m; print(m.version("browsergym-core"))'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    })
    if (probe.status === 0 && probe.stdout.trim()) {
      const version = probe.stdout.trim()
      const pinned = version === BROWSERGYM_PYPI_VERSION
      return {
        available: pinned,
        python: bin,
        version,
        missing: pinned
          ? ['Official MiniWoB/WebArena/WorkArena servers are not provisioned; native protocol fixtures only']
          : [`Installed browsergym-core ${version} is not the pinned ${BROWSERGYM_PYPI_VERSION}`, ...BROWSERGYM_MISSING_ENVIRONMENT],
        externalRunCommand: BROWSERGYM_EXTERNAL_RUN_COMMAND
      }
    }
  }
  return {
    available: false,
    python: null,
    version: null,
    missing: BROWSERGYM_MISSING_ENVIRONMENT,
    externalRunCommand: BROWSERGYM_EXTERNAL_RUN_COMMAND
  }
}
