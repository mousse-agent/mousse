import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import { isInsidePath } from './pathGuard'

/** Where on a computer the user's credentials and personal settings live. */
export interface FolderRuleEnvironment {
  home: string
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
}

export interface SensitiveFolder {
  path: string
  /** What the folder holds, in words a person on another computer is told. */
  holds: string
}

export function currentFolderEnvironment(): FolderRuleEnvironment {
  return { home: homedir(), platform: process.platform, env: process.env }
}

/**
 * The folders another computer may not register as a project, and so may not run threads in: the credentials
 * and personal settings the user's own tools keep on this computer. Registering one gives every thread
 * there the folder's files to read and change.
 *
 * The list is defined here, in one table, as three groups:
 * - the user's own credential and settings folders (SSH, GnuPG, cloud and container tools, the GitHub CLI),
 *   under the home folder and where the tools' own environment variables move them;
 * - the operating system's keychains and credential stores, and the folders browsers keep sign-ins in;
 * - for the caller that checks, the Mousse data folders, which hold this computer's keys and every profile.
 *
 * A request is refused when the folder is one of these, lies inside one, or contains one (so the home
 * folder, the folders above it and a drive root are refused too). The caller compares real paths.
 */
export function sensitiveFolders(environment: FolderRuleEnvironment = currentFolderEnvironment()): SensitiveFolder[] {
  const { home, platform, env } = environment
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const at = (base: string | undefined, ...parts: string[]): string | undefined =>
    base ? path.join(base, ...parts) : undefined
  const config = env.XDG_CONFIG_HOME ?? at(home, '.config')
  // A tool's folder is where its environment variable says, and also its default: the variable may be set for
  // one program only, while the default is still where an earlier run left the files.
  const list: Array<[string | undefined, string]> = [
    [at(home, '.ssh'), 'SSH keys'],
    [env.GNUPGHOME, 'GnuPG keys'],
    [at(home, '.gnupg'), 'GnuPG keys'],
    [at(home, '.aws'), 'AWS credentials'],
    [at(home, '.azure'), 'Azure credentials'],
    [at(home, '.kube'), 'Kubernetes credentials'],
    [env.DOCKER_CONFIG, 'Docker credentials'],
    [at(home, '.docker'), 'Docker credentials'],
    [at(home, '.password-store'), 'a password store'],
    [env.GH_CONFIG_DIR, 'GitHub CLI sign-in'],
    [at(config, 'gh'), 'GitHub CLI sign-in'],
    [env.CLOUDSDK_CONFIG, 'Google Cloud credentials'],
    [at(config, 'gcloud'), 'Google Cloud credentials'],
    // Coding agents keep their sign-ins (refresh tokens) in the user's home folder.
    [env.CODEX_HOME, 'Codex sign-in'],
    [at(home, '.codex'), 'Codex sign-in'],
    [env.CLAUDE_CONFIG_DIR, 'Claude Code sign-in'],
    [at(home, '.claude'), 'Claude Code sign-in'],
    [at(home, '.gemini'), 'Gemini CLI sign-in'],
    [at(home, '.cursor'), 'Cursor sign-in and settings'],
    [at(config, 'github-copilot'), 'GitHub Copilot sign-in'],
    // Package, build and secrets tools.
    [at(home, '.cargo'), 'Cargo registry tokens'],
    [at(home, '.m2'), 'Maven credentials'],
    [at(home, '.gradle'), 'Gradle credentials'],
    [at(home, '.terraform.d'), 'Terraform credentials'],
    [at(config, 'sops', 'age'), 'age keys'],
    [at(config, 'op'), '1Password CLI sign-in'],
    [at(home, '.pki', 'nssdb'), 'the certificate and key database']
  ]
  if (platform === 'darwin') {
    const library = at(home, 'Library')
    const support = at(library, 'Application Support')
    list.push(
      [at(library, 'Keychains'), 'the keychain'],
      ['/Library/Keychains', 'the keychain'],
      ['/System/Library/Keychains', 'the keychain'],
      [at(support, 'Google', 'Chrome'), 'browser sign-ins'],
      [at(support, 'Chromium'), 'browser sign-ins'],
      [at(support, 'Microsoft Edge'), 'browser sign-ins'],
      [at(support, 'BraveSoftware'), 'browser sign-ins'],
      [at(support, 'Vivaldi'), 'browser sign-ins'],
      [at(support, 'Arc'), 'browser sign-ins'],
      [at(support, 'com.operasoftware.Opera'), 'browser sign-ins'],
      [at(support, 'Firefox'), 'browser sign-ins'],
      [at(library, 'Safari'), 'browser sign-ins']
    )
  } else if (windows) {
    const roaming = env.APPDATA ?? at(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? at(home, 'AppData', 'Local')
    list.push(
      [at(roaming, 'gnupg'), 'GnuPG keys'],
      [at(roaming, 'Microsoft', 'Credentials'), 'Windows saved credentials'],
      [at(local, 'Microsoft', 'Credentials'), 'Windows saved credentials'],
      [at(roaming, 'Microsoft', 'Protect'), 'Windows encryption keys'],
      [at(roaming, 'Microsoft', 'Crypto'), 'Windows private keys'],
      [at(roaming, 'Microsoft', 'SystemCertificates'), 'Windows certificates'],
      [at(roaming, 'Microsoft', 'Vault'), 'the Windows credential vault'],
      [at(local, 'Microsoft', 'Vault'), 'the Windows credential vault'],
      [at(roaming, 'GitHub CLI'), 'GitHub CLI sign-in'],
      [at(roaming, 'gcloud'), 'Google Cloud credentials'],
      [at(local, 'Google', 'Chrome', 'User Data'), 'browser sign-ins'],
      [at(local, 'Chromium'), 'browser sign-ins'],
      [at(local, 'Microsoft', 'Edge', 'User Data'), 'browser sign-ins'],
      [at(local, 'BraveSoftware'), 'browser sign-ins'],
      [at(local, 'Vivaldi'), 'browser sign-ins'],
      [at(roaming, 'Opera Software'), 'browser sign-ins'],
      [at(roaming, 'Mozilla'), 'browser sign-ins'],
      [at(local, 'Mozilla'), 'browser sign-ins']
    )
  } else {
    const data = env.XDG_DATA_HOME ?? at(home, '.local', 'share')
    list.push(
      [at(data, 'keyrings'), 'the keyring'],
      [at(home, '.gnome2', 'keyrings'), 'the keyring'],
      [at(data, 'kwalletd'), 'the keyring'],
      [at(config, 'google-chrome'), 'browser sign-ins'],
      [at(config, 'chromium'), 'browser sign-ins'],
      [at(config, 'microsoft-edge'), 'browser sign-ins'],
      [at(config, 'BraveSoftware'), 'browser sign-ins'],
      [at(config, 'vivaldi'), 'browser sign-ins'],
      [at(config, 'opera'), 'browser sign-ins'],
      [at(home, '.mozilla'), 'browser sign-ins'],
      [at(home, 'snap', 'firefox', 'common', '.mozilla'), 'browser sign-ins'],
      [at(home, 'snap', 'chromium', 'common'), 'browser sign-ins'],
      ...['org.mozilla.firefox', 'com.google.Chrome', 'org.chromium.Chromium', 'com.brave.Browser', 'com.microsoft.Edge', 'com.vivaldi.Vivaldi'].map(
        (app): [string | undefined, string] => [at(home, '.var', 'app', app), 'browser sign-ins']
      )
    )
  }
  return list.flatMap(([folder, holds]) => (folder ? [{ path: path.resolve(folder), holds }] : []))
}

/** The real path of a folder that may not exist: the real path of the deepest folder that does, and the rest as it is. */
function realOrSpelled(folder: string): string {
  const rest: string[] = []
  let current = resolve(folder)
  for (;;) {
    try {
      return rest.length ? join(realpathSync.native(current), ...rest) : realpathSync.native(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(folder)
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * What a folder is, if it is one another computer may not register: a folder in `sensitiveFolders`, a folder
 * inside one, or a folder that contains one (the home folder itself, the folders above it, a drive root).
 * `folders` are the spellings of the folder to check (as given, and its real path), so a link, a junction,
 * a short name or a different case cannot get around the table.
 */
export function sensitiveFolderHolding(
  folders: readonly string[],
  environment: FolderRuleEnvironment = currentFolderEnvironment()
): string | undefined {
  for (const entry of resolvedFolders(environment))
    if (
      entry.paths.some((protectedFolder) =>
        folders.some((folder) => isInsidePath(folder, protectedFolder) || isInsidePath(protectedFolder, folder))
      )
    )
      return entry.holds
  return undefined
}

/**
 * What a path inside the folders of the table holds, if it is one. For reading and changing files in a project
 * that is already registered: a project that is the home folder, or has a link to `~/.aws`, does not open what
 * `projects.open` would refuse. Only the direction "inside" counts here, since the project itself is the
 * owner's own choice.
 */
export function sensitiveFolderContaining(
  path: string,
  environment: FolderRuleEnvironment = currentFolderEnvironment()
): string | undefined {
  for (const entry of resolvedFolders(environment))
    if (entry.paths.some((protectedFolder) => isInsidePath(path, protectedFolder))) return entry.holds
  return undefined
}

interface ResolvedFolder {
  holds: string
  /** As spelled, and as it really is: a link or short name may stand in either place. */
  paths: string[]
}

const RESOLVED_FOR_MS = 30_000
let resolved: { key: string; at: number; folders: ResolvedFolder[] } | undefined

/** Forgets the looked-up real paths (for a test that changes the folders under it). */
export function forgetResolvedSensitiveFolders(): void {
  resolved = undefined
}

/** The table with every folder's real path looked up, kept for a short time because it costs a lookup per entry. */
function resolvedFolders(environment: FolderRuleEnvironment): ResolvedFolder[] {
  const entries = sensitiveFolders(environment)
  const key = entries.map((entry) => entry.path).join('\0')
  if (resolved && resolved.key === key && Date.now() - resolved.at < RESOLVED_FOR_MS) return resolved.folders
  const folders = entries.map((entry) => ({
    holds: entry.holds,
    paths: [...new Set([entry.path, realOrSpelled(entry.path)])]
  }))
  resolved = { key, at: Date.now(), folders }
  return folders
}
