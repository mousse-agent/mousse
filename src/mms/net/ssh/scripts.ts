import { HEADLESS_DISPLAY_SWITCHES } from '../../../shared/headlessSwitches'
import { q } from './shellQuote'

/**
 * Every script Mousse runs on a remote machine. Each is passed to `remoteCommand`, so only POSIX
 * `sh` parses it, and every value that is not a constant is quoted with `q()`. Documents and
 * secrets (the invitation, add-on settings, the checksum line, a launcher) arrive on stdin. The
 * text has no backslash (see `shellQuote.ts`). The first line names the step for the process list
 * and the journal.
 */

export const RELEASE_REPOSITORY = 'mousse-agent/mousse'
export const LAUNCHER_MARKER = '# mousse-managed'
export const LAUNCHER_RELATIVE = '.local/bin/mousse-cli'
export const INSTALL_RELATIVE = '.local/share/mousse/cli'
export const UNIT_RELATIVE = '.config/systemd/user/mousse-mms.service'
const SECTION = '@@'

/** Absolute paths come from the probe's `$HOME`; anything with unusual characters is refused. */
export const PLAIN_PATH = /^\/[A-Za-z0-9._/@+-]{1,400}$/u
export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/u

export function assetName(version: string): string {
  return `mousse-cli-${version}-linux-x86_64.AppImage`
}
export function assetUrl(version: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${assetName(version)}`
}
export function checksumsUrl(version: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/SHA256SUMS-${version}.txt`
}

export function launcherPath(home: string): string {
  return `${home}/${LAUNCHER_RELATIVE}`
}
export function installDirectory(home: string, version: string): string {
  return `${home}/${INSTALL_RELATIVE}/${version}`
}
export function unitPath(home: string): string {
  return `${home}/${UNIT_RELATIVE}`
}

/** The managed launcher: a two-line wrapper that carries the sandbox opt-out for every launch. */
export function launcherContent(manifestId: string, installDir: string): string {
  return [
    '#!/bin/sh',
    `${LAUNCHER_MARKER} ${manifestId}`,
    'export ELECTRON_DISABLE_SANDBOX=1',
    // A server has no display; Electron reads these switches before any Mousse code runs.
    'if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then',
    `  set -- "$@" ${HEADLESS_DISPLAY_SWITCHES.join(' ')}`,
    'fi',
    `exec "${installDir}/squashfs-root/mousse-cli" "$@"`,
    ''
  ].join('\n')
}

/** What a Mousse launcher carries: the manifest id after the marker. */
export function launcherOwner(content: string): string | undefined {
  const match = new RegExp(`^${LAUNCHER_MARKER} ([A-Za-z0-9_-]+)$`, 'mu').exec(content)
  return match?.[1]
}

/**
 * Shared libraries the packaged Electron CLI links against (what `ldd` reports on a bare Ubuntu
 * server), with the Debian and Ubuntu package that provides each. A server image has none of the
 * GTK, NSS or audio libraries, and without them the CLI cannot even print its version.
 */
export const ELECTRON_LIBRARIES: ReadonlyArray<{ soname: string; package: string }> = [
  { soname: 'libnspr4.so', package: 'libnspr4' },
  { soname: 'libnss3.so', package: 'libnss3' },
  { soname: 'libnssutil3.so', package: 'libnss3' },
  { soname: 'libsmime3.so', package: 'libnss3' },
  { soname: 'libatk-1.0.so.0', package: 'libatk1.0-0' },
  { soname: 'libatk-bridge-2.0.so.0', package: 'libatk-bridge2.0-0' },
  { soname: 'libatspi.so.0', package: 'libatspi2.0-0' },
  { soname: 'libcups.so.2', package: 'libcups2' },
  { soname: 'libcairo.so.2', package: 'libcairo2' },
  { soname: 'libgtk-3.so.0', package: 'libgtk-3-0' },
  { soname: 'libpango-1.0.so.0', package: 'libpango-1.0-0' },
  { soname: 'libX11.so.6', package: 'libx11-6' },
  { soname: 'libXcomposite.so.1', package: 'libxcomposite1' },
  { soname: 'libXdamage.so.1', package: 'libxdamage1' },
  { soname: 'libXext.so.6', package: 'libxext6' },
  { soname: 'libXfixes.so.3', package: 'libxfixes3' },
  { soname: 'libXrandr.so.2', package: 'libxrandr2' },
  { soname: 'libgbm.so.1', package: 'libgbm1' },
  { soname: 'libxcb.so.1', package: 'libxcb1' },
  { soname: 'libxkbcommon.so.0', package: 'libxkbcommon0' },
  { soname: 'libasound.so.2', package: 'libasound2' }
]

/** Debian and Ubuntu renamed these when 64-bit time_t arrived: Debian 13 and Ubuntu 24.04. */
const T64_PACKAGES = new Set([
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libatspi2.0-0',
  'libcups2',
  'libgtk-3-0',
  'libasound2'
])
/** `ID VERSION_ID` from the machine's /etc/os-release, e.g. `ubuntu 24.04`. */
export function usesT64Names(release: string | undefined): boolean {
  const [id = '', version = ''] = (release ?? '').trim().split(/\s+/u)
  const major = Number(version.split('.')[0])
  return (id === 'ubuntu' && major >= 24) || (id === 'debian' && major >= 13)
}

/** What to run on the machine for the libraries that are missing (Debian and Ubuntu names). */
export function librariesRemedy(missing: string[], release?: string): string {
  const t64 = usesT64Names(release)
  const packages = [
    ...new Set(
      missing.flatMap((soname) =>
        ELECTRON_LIBRARIES.filter((lib) => lib.soname === soname).map((lib) =>
          t64 && T64_PACKAGES.has(lib.package) ? `${lib.package}t64` : lib.package
        )
      )
    )
  ]
  const list = missing.join(', ')
  return packages.length
    ? `Install the libraries Electron needs (missing: ${list}). On Debian or Ubuntu: sudo apt-get install -y ${packages.join(' ')}. Elsewhere, install the packages that provide them.`
    : `Install the libraries Electron needs (missing: ${list}).`
}

/** Read-only facts about the machine in one round trip; nothing here changes it. */
export function probeScript(): string {
  const L = '"$HOME/.local/bin/mousse-cli"'
  return [
    '# mousse:probe',
    `echo '${SECTION}uname'; uname -sm 2>&1`,
    `echo '${SECTION}home'; echo "$HOME"`,
    `echo '${SECTION}user'; id -un`,
    `echo '${SECTION}launcher'; head -c 256 ${L} 2>/dev/null`,
    `echo; echo '${SECTION}launcherx'; if test -x ${L}; then echo yes; fi`,
    `echo '${SECTION}path'; command -v mousse-cli 2>/dev/null`,
    `echo '${SECTION}app'; if test -x /Applications/Mousse.app/Contents/Resources/mousse-cli; then echo yes; fi`,
    `cli=''`,
    `case "$(head -c 256 ${L} 2>/dev/null)" in *'${LAUNCHER_MARKER}'*) cli=${L};; esac`,
    `if test -z "$cli"; then p=$(command -v mousse-cli 2>/dev/null); if test -n "$p"; then cli="$p"; fi; fi`,
    `if test -z "$cli" && test -x ${L}; then cli=${L}; fi`,
    `if test -z "$cli" && test -x /Applications/Mousse.app/Contents/Resources/mousse-cli; then cli=/Applications/Mousse.app/Contents/Resources/mousse-cli; fi`,
    `echo '${SECTION}cli'; echo "$cli"`,
    `echo '${SECTION}version'; if test -n "$cli"; then "$cli" --version 2>&1 | head -n 1; fi`,
    `echo '${SECTION}service'`,
    `st=''; if test -n "$cli"; then st=$("$cli" service status --json 2>/dev/null); fi`,
    `echo "$st"`,
    // `net status` would start a daemon that is not running; only ask a running one.
    `case "$st" in *'"running":true'*|*'"running": true'*) echo '${SECTION}net'; "$cli" net status --json 2>/dev/null;; esac`,
    `echo '${SECTION}tools'; for t in curl wget sha256sum shasum systemctl loginctl; do if command -v "$t" >/dev/null 2>&1; then echo "$t"; fi; done`,
    `echo '${SECTION}unit'; if test -e "$HOME/.config/systemd/user/mousse-mms.service"; then echo yes; fi`,
    `echo '${SECTION}df'; df -Pk "$HOME" 2>/dev/null | tail -n 1`,
    `echo '${SECTION}linger'; if command -v loginctl >/dev/null 2>&1; then loginctl show-user "$(id -un)" -p Linger 2>/dev/null; fi`,
    `echo '${SECTION}release'; (. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID")`,
    // The packaged app keeps its network keys in the OS keyring and never falls back to plain text.
    `echo '${SECTION}keyring'`,
    `if command -v busctl >/dev/null 2>&1; then if busctl --user list --no-pager 2>/dev/null | grep -q org.freedesktop.secrets; then echo running; elif busctl --user list --activatable --no-pager 2>/dev/null | grep -q org.freedesktop.secrets; then echo activatable; else echo none; fi; else echo nobusctl; fi`,
    `echo '${SECTION}libs'`,
    `ld=$(command -v ldconfig 2>/dev/null); if test -z "$ld" && test -x /sbin/ldconfig; then ld=/sbin/ldconfig; fi`,
    `if test -z "$ld"; then echo noldconfig; else cache=$("$ld" -p 2>/dev/null); for l in ${ELECTRON_LIBRARIES.map((lib) => lib.soname).join(' ')}; do case "$cache" in *"$l"*) ;; *) echo "missing:$l";; esac; done; fi`,
    `echo '${SECTION}end'`,
    'true',
    ''
  ].join('\n')
}

export function parseSections(output: string): Map<string, string> {
  const sections = new Map<string, string>()
  let name: string | undefined,
    lines: string[] = []
  const flush = () => {
    if (name !== undefined) sections.set(name, lines.join('\n').trim())
  }
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith(SECTION)) {
      flush()
      name = line.slice(SECTION.length).trim()
      lines = []
    } else lines.push(line)
  }
  flush()
  return sections
}

/** Step: download the release asset on the host (the fallback is an upload). Exit 21: it could not. */
export function fetchScript(input: { directory: string; asset: string; url: string }): string {
  return [
    '# mousse:install-fetch',
    'set -eu',
    `mkdir -p ${q(input.directory)}`,
    `cd ${q(input.directory)}`,
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fL --proto '=https' --retry 2 --connect-timeout 20 --max-time 900 -o ${q(input.asset)} ${q(input.url)} || exit 21`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget -q -O ${q(input.asset)} ${q(input.url)} || exit 21`,
    'else',
    '  exit 21',
    'fi',
    ''
  ].join('\n')
}

/** Step: the file arrives on stdin when the host cannot reach GitHub. */
export function uploadScript(input: { directory: string; asset: string }): string {
  return [
    '# mousse:install-upload',
    'set -eu',
    `mkdir -p ${q(input.directory)}`,
    `cd ${q(input.directory)}`,
    `cat > ${q(input.asset)}`,
    ''
  ].join('\n')
}

/** Step: the published checksum line arrives on stdin; the asset is extracted only if it matches. */
export function verifyExtractScript(input: { directory: string; asset: string }): string {
  return [
    '# mousse:install-verify',
    'set -eu',
    `cd ${q(input.directory)}`,
    'cat > SHA256SUMS.line',
    'if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS.line; else shasum -a 256 -c SHA256SUMS.line; fi',
    `chmod +x ${q(input.asset)}`,
    `${q(`./${input.asset}`)} --appimage-extract >/dev/null`,
    ''
  ].join('\n')
}

/** Step: the launcher text arrives on stdin and replaces the file in one rename. */
export function writeLauncherScript(path: string): string {
  return [
    '# mousse:install-launcher',
    'set -eu',
    `f=${q(path)}`,
    'mkdir -p "$(dirname "$f")"',
    't="$f.part.$$"',
    'cat > "$t"',
    'chmod 755 "$t"',
    'mv -f "$t" "$f"',
    ''
  ].join('\n')
}

/** Read-only: is this record's launcher in place with its install directory? Prints `ready`. */
export function reconcileInstallScript(input: {
  launcher: string
  manifestId: string
  directory: string
}): string {
  return [
    '# mousse:reconcile-install',
    `f=${q(input.launcher)}`,
    `case "$(head -c 256 "$f" 2>/dev/null)" in`,
    `  *${q(`${LAUNCHER_MARKER} ${input.manifestId}`)}*) if test -x ${q(`${input.directory}/squashfs-root/mousse-cli`)}; then echo ready; fi;;`,
    'esac',
    ''
  ].join('\n')
}

/** Read-only: the version directories under the install root. */
export function listInstallsScript(root: string): string {
  return ['# mousse:list-installs', `ls -1 ${q(root)} 2>/dev/null || true`, ''].join('\n')
}

/** Read-only: the libraries the unpacked CLI cannot find, one name per line. */
export function missingLibrariesScript(directory: string): string {
  return [
    '# mousse:check-libs',
    `cd ${q(`${directory}/squashfs-root`)}`,
    `(. /etc/os-release 2>/dev/null && echo "release=$ID $VERSION_ID")`,
    `if command -v ldd >/dev/null 2>&1; then ldd ./mousse-cli 2>/dev/null | awk '/not found/ {print $1}'; fi`,
    ''
  ].join('\n')
}

export function cliScript(step: string, cli: string, args: string[]): string {
  return [`# mousse:${step}`, `${q(cli)} ${args.map(q).join(' ')}`, ''].join('\n')
}

/** The invitation arrives on stdin, never as an argument or a file. */
export function joinScript(input: { cli: string; name: string; via: string }): string {
  return cliScript('join', input.cli, [
    'bridge',
    'join',
    '--json',
    '--name',
    input.name,
    '--via',
    input.via
  ])
}

/** The settings document arrives on stdin and goes through a private temporary file. */
export function configureAddonScript(input: { cli: string; disable?: boolean }): string {
  return [
    '# mousse:addon-configure',
    'set -eu',
    'umask 077',
    'f=$(mktemp)',
    `trap 'rm -f "$f"' EXIT`,
    'cat > "$f"',
    `${q(input.cli)} net transport configure ssh --settings-file "$f"${input.disable ? ' --disable' : ''}`,
    ''
  ].join('\n')
}

export function lingerShowScript(user: string): string {
  return ['# mousse:linger-show', `loginctl show-user ${q(user)} -p Linger`, ''].join('\n')
}
export function lingerDisableScript(user: string): string {
  return ['# mousse:linger-disable', `loginctl disable-linger ${q(user)}`, ''].join('\n')
}
/** Prints a small file (a launcher or a unit) so this computer can compare it with what it wrote. */
export function catFileScript(path: string): string {
  return ['# mousse:cat-file', `f=${q(path)}`, 'if test -f "$f"; then cat "$f"; fi', ''].join('\n')
}
export function lingerEnableScript(user: string): string {
  return ['# mousse:linger-enable', `loginctl enable-linger ${q(user)}`, ''].join('\n')
}

/** Removes a launcher only while it still carries this record's marker; exit 3 means it changed. */
export function removeLauncherScript(path: string, manifestId: string): string {
  return [
    '# mousse:undo-launcher',
    `f=${q(path)}`,
    'if test ! -e "$f"; then exit 0; fi',
    `case "$(head -c 256 "$f" 2>/dev/null)" in`,
    `  *${q(`${LAUNCHER_MARKER} ${manifestId}`)}*) rm -f "$f";;`,
    '  *) echo changed; exit 3;;',
    'esac',
    ''
  ].join('\n')
}

/** Removes an install directory; the path was checked against `installDirectory()`'s shape first. */
export function removeInstallScript(directory: string): string {
  // The install root and the `mousse` data folder above it go too, but only while empty (`rmdir`),
  // so the machine ends up as it was without touching anything else there.
  const root = directory.slice(0, directory.lastIndexOf('/'))
  const parent = root.slice(0, root.lastIndexOf('/'))
  return [
    '# mousse:undo-install',
    `rm -rf -- ${q(directory)}`,
    `rmdir -- ${q(root)} 2>/dev/null || true`,
    `rmdir -- ${q(parent)} 2>/dev/null || true`,
    ''
  ].join('\n')
}

/** A removed unit keeps its `failed` state in the user manager until it is reset. */
export function resetFailedScript(): string {
  return [
    '# mousse:service-reset',
    'systemctl --user reset-failed mousse-mms 2>/dev/null || true',
    ''
  ].join('\n')
}

export function startServiceScript(unit: 'systemd' | 'launchd'): string {
  return unit === 'systemd'
    ? ['# mousse:service-start', 'systemctl --user start mousse-mms', ''].join('\n')
    : [
        '# mousse:service-start',
        'launchctl kickstart -k "gui/$(id -u)/com.ryspa.mousse.mms"',
        ''
      ].join('\n')
}

export function restartServiceScript(): string {
  return ['# mousse:service-restart', 'systemctl --user restart mousse-mms', ''].join('\n')
}
