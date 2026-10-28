import { join } from 'node:path'
import { runProcess, type RunResult } from '../ssh/runner'

/**
 * Whether this computer's SSH server and its public host keys can be vouched for.
 *
 * A computer vouches for the host keys it reads from its SSH server's folder, and the other computer then
 * trusts that key without asking anyone. That is only sound if nothing but the real SSH server could have put
 * the files there and answers on the port. On macOS and Linux that holds (the port needs root on Linux, and
 * `/etc/ssh` belongs to root on both: an impostor on macOS cannot present the real key). On Windows it does
 * not by itself: any account can listen on port 22 when the SSH server does not, and when the OpenSSH Server is
 * not installed any account can make `C:\ProgramData\ssh` and write `ssh_host_*_key.pub` in it. So on Windows
 * the keys are vouched for only when
 *
 * - the `sshd` service is running, and its process is the only one that listens on port 22 here;
 * - the folder and each public key file are owned by SYSTEM, Administrators or TrustedInstaller, are not
 *   links, and no other account can write, delete or change their permissions.
 *
 * The permissions are read as security descriptors (SDDL), which name accounts by id, so the check does not
 * depend on the language of the system.
 */

export type HostTrust = { ok: true } | { ok: false; detail: string }

type Run = (
  file: string,
  args: string[]
) => Promise<Pick<RunResult, 'code' | 'stdout' | 'missing' | 'timedOut'>>

export interface HostTrustOptions {
  platform?: NodeJS.Platform
  /** The folders the public host keys are read from. */
  directories: readonly string[]
  /** Tests replace the program that reports the facts. */
  run?: Run
  /** The Windows folder (`C:\Windows`), for the full path of the program. */
  systemRoot?: string
}

/** Accounts that may own these files and may write them: SYSTEM, Administrators, TrustedInstaller. */
const TRUSTED_SIDS: ReadonlySet<string> = new Set([
  'SY',
  'BA',
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
])
/** The owner of a file and the creator-owner placeholder get what the owner gets; the owner is checked on its own. */
const OWNER_PLACEHOLDERS: ReadonlySet<string> = new Set(['CO', 'OW', 'S-1-3-0', 'S-1-3-4'])

/** What file access rights in SDDL stand for. */
const RIGHT_TOKENS: Readonly<Record<string, number>> = {
  GR: 0x80000000,
  GW: 0x40000000,
  GX: 0x20000000,
  GA: 0x10000000,
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x100116,
  FX: 0x1200a0,
  SD: 0x10000,
  RC: 0x20000,
  WD: 0x40000,
  WO: 0x80000
}
/** Write data, append, write EA, delete child, write attributes, delete, change permissions, take ownership, and the generic and maximum rights. */
const WRITE_MASK =
  0x2 |
  0x4 |
  0x10 |
  0x40 |
  0x100 |
  0x10000 |
  0x40000 |
  0x80000 |
  0x40000000 |
  0x10000000 |
  0x02000000
const REPARSE_POINT = 0x400

export interface Ace {
  type: string
  flags: string
  rights: string
  sid: string
}
export interface Sddl {
  owner?: string
  aces: Ace[]
}

/** The owner and the access entries of a security descriptor in SDDL form (`O:BAG:SYD:PAI(A;OICI;FA;;;SY)`). */
export function parseSddl(text: string): Sddl {
  const owner = /O:(S-[0-9-]+|[A-Z]{2})/u.exec(text)?.[1]
  const start = text.indexOf('D:')
  const end = text.indexOf('S:', start < 0 ? 0 : start)
  const dacl = start < 0 ? '' : text.slice(start + 2, end < 0 ? undefined : end)
  const aces: Ace[] = []
  for (const match of dacl.matchAll(/\(([^()]*)\)/gu)) {
    const [type = '', flags = '', rights = '', , , sid = ''] = match[1]!.split(';')
    aces.push({ type, flags, rights, sid })
  }
  return { ...(owner ? { owner } : {}), aces }
}

/** The bits of a rights field, or undefined for one this check does not know (which then counts as write). */
export function rightsMask(rights: string): number | undefined {
  if (/^0x[0-9a-f]+$/iu.test(rights)) return Number.parseInt(rights, 16)
  if (!rights || rights.length % 2 !== 0) return undefined
  let mask = 0
  for (let at = 0; at < rights.length; at += 2) {
    const bits = RIGHT_TOKENS[rights.slice(at, at + 2)]
    if (bits === undefined) return undefined
    mask |= bits
  }
  return mask >>> 0
}

/** Why a file or folder with this security descriptor cannot be trusted, or undefined if it can. */
export function untrustedBecause(sddl: string): string | undefined {
  const parsed = parseSddl(sddl)
  if (!parsed.owner) return 'its owner is not known'
  if (!TRUSTED_SIDS.has(parsed.owner))
    return 'it is owned by an account that is not SYSTEM or Administrators'
  for (const ace of parsed.aces) {
    // Allow entries only; a deny entry never gives anyone more.
    if (!['A', 'OA', 'XA', 'ZA'].includes(ace.type)) continue
    // Applies to what is inside, not to this one.
    if (ace.flags.includes('IO')) continue
    if (TRUSTED_SIDS.has(ace.sid) || OWNER_PLACEHOLDERS.has(ace.sid)) continue
    const mask = rightsMask(ace.rights)
    if (mask === undefined || (mask & WRITE_MASK) !== 0)
      return 'an account that is not SYSTEM or Administrators can change it'
  }
  return undefined
}

interface ReportedItem {
  path?: unknown
  attributes?: unknown
  sddl?: unknown
}
interface Report {
  service?: { state?: unknown; pid?: unknown } | null
  listeners?: unknown
  items?: unknown
}

const asArray = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : value === undefined || value === null ? [] : [value as T]
/** Addresses a connection to 127.0.0.1 or ::1 can end at. */
const LOOPBACK_REACHABLE: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

/** Decides from what the system reported (see `windowsScript`). Anything missing or odd is a no. */
export function judgeWindowsReport(output: string): HostTrust {
  let report: Report
  try {
    report = JSON.parse(output) as Report
  } catch {
    return { ok: false, detail: 'The system did not report on the SSH server.' }
  }
  if (!report || typeof report !== 'object')
    return { ok: false, detail: 'The system did not report on the SSH server.' }
  const pid = report.service?.pid
  if (!report.service || report.service.state !== 'Running' || typeof pid !== 'number' || pid <= 0)
    return { ok: false, detail: 'The sshd service is not running.' }
  const listeners = asArray<{ LocalAddress?: unknown; OwningProcess?: unknown }>(
    report.listeners
  ).filter(
    (row) => typeof row.LocalAddress === 'string' && LOOPBACK_REACHABLE.has(row.LocalAddress)
  )
  if (!listeners.length) return { ok: false, detail: 'Nothing listens on port 22.' }
  if (listeners.some((row) => row.OwningProcess !== pid))
    return { ok: false, detail: 'A program other than the sshd service listens on port 22.' }
  const items = asArray<ReportedItem>(report.items)
  if (!items.length) return { ok: false, detail: 'The SSH folder was not reported.' }
  for (const item of items) {
    if (typeof item.sddl !== 'string' || typeof item.attributes !== 'number')
      return { ok: false, detail: 'The permissions of the SSH folder could not be read.' }
    if ((item.attributes & REPARSE_POINT) !== 0)
      return { ok: false, detail: 'The SSH folder or a key in it is a link.' }
    const why = untrustedBecause(item.sddl)
    if (why)
      return { ok: false, detail: `The SSH folder or a key in it cannot be trusted: ${why}.` }
  }
  return { ok: true }
}

const quote = (value: string): string => `'${value.replace(/'/gu, "''")}'`

/** One PowerShell run that reports the service, the listeners on port 22 and the permissions, as JSON. */
export function windowsScript(directory: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = ${quote(directory)}`,
    '$svc = Get-CimInstance Win32_Service -Filter "Name=\'sshd\'"',
    '$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue | ForEach-Object { @{ LocalAddress = [string]$_.LocalAddress; OwningProcess = [int]$_.OwningProcess } })',
    "$files = @(Get-ChildItem -LiteralPath $dir -Force -File | Where-Object { $_.Name -match '^ssh_host_[A-Za-z0-9_]+_key\\.pub$' })",
    "$items = @(Get-Item -LiteralPath $dir -Force) + $files | ForEach-Object { @{ path = $_.FullName; attributes = [int]$_.Attributes; sddl = (Get-Acl -LiteralPath $_.FullName).GetSecurityDescriptorSddlForm('Owner,Access') } }",
    '$service = $null',
    'if ($svc) { $service = @{ state = [string]$svc.State; pid = [int]$svc.ProcessId } }',
    '@{ service = $service; listeners = @($listeners); items = @($items) } | ConvertTo-Json -Depth 5 -Compress'
  ].join('\n')
}

/**
 * Checks the SSH server and the folder of its host keys. Off Windows there is nothing to check (see above) and
 * the answer is yes. On Windows the answer is no whenever the facts cannot be read.
 */
export async function checkHostTrust(options: HostTrustOptions): Promise<HostTrust> {
  if ((options.platform ?? process.platform) !== 'win32') return { ok: true }
  const directory = options.directories[0]
  if (!directory) return { ok: false, detail: 'There is no SSH folder to check.' }
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run: Run =
    options.run ??
    ((file, args) => runProcess(file, args, { timeoutMs: 20_000, maxBytes: 256 * 1024 }))
  try {
    const result = await run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      windowsScript(directory)
    ])
    if (result.missing || result.timedOut || result.code !== 0)
      return { ok: false, detail: 'The system could not report on the SSH server.' }
    return judgeWindowsReport(result.stdout.trim())
  } catch {
    return { ok: false, detail: 'The system could not report on the SSH server.' }
  }
}
