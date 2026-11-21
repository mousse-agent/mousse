/**
 * What a check run listens on, as the OS reports it: every TCP listener and bound UDP socket of this process and
 * the processes it started (the helpers, the test SSH servers, the CLI stand-ins). A check on one computer listens
 * on loopback only (agent rules: on Windows anything else raises a firewall prompt on the owner's desktop), so
 * `offLoopbackBinds` must stay empty. Windows reads `netstat -ano`, macOS `lsof`, Linux `ss`.
 */
import { spawnSync } from 'node:child_process'

export interface Bind {
  pid: number
  proto: 'tcp' | 'udp'
  /** The local address, without brackets: `0.0.0.0`, `::`, `192.168.1.5`, `*`. */
  address: string
  port: number
}

/** `host:port`, `[v6]:port` or `*:port` → its parts. */
function endpoint(text: string): { address: string; port: number } | undefined {
  const at = text.lastIndexOf(':')
  if (at < 0) return undefined
  const port = Number(text.slice(at + 1))
  if (!Number.isInteger(port)) return undefined
  return { address: text.slice(0, at).replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port }
}

/** `netstat -ano`: TCP lines in LISTENING, and every UDP line. */
export function parseNetstat(text: string): Bind[] {
  const out: Bind[] = []
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    const proto = cols[0]?.toUpperCase()
    if (proto === 'TCP' && cols[3] === 'LISTENING') {
      const local = endpoint(cols[1]!)
      if (local) out.push({ pid: Number(cols[4]), proto: 'tcp', ...local })
    } else if (proto === 'UDP' && cols.length >= 4) {
      const local = endpoint(cols[1]!)
      if (local) out.push({ pid: Number(cols[cols.length - 1]), proto: 'udp', ...local })
    }
  }
  return out
}

/** `lsof -nP -i`: TCP lines in LISTEN, and UDP lines that are not connected (`->`). */
export function parseLsof(text: string): Bind[] {
  const out: Bind[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const pid = Number(cols[1])
    const node = cols[7]
    const name = cols[8]!
    if (name.includes('->')) continue
    if (node === 'TCP' && cols[9] === '(LISTEN)') {
      const local = endpoint(name)
      if (local) out.push({ pid, proto: 'tcp', ...local })
    } else if (node === 'UDP') {
      const local = endpoint(name)
      if (local) out.push({ pid, proto: 'udp', ...local })
    }
  }
  return out
}

/** `ss -Hlntup`: listening TCP and bound UDP, each with its `pid=`. */
export function parseSs(text: string): Bind[] {
  const out: Bind[] = []
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const proto = cols[0] === 'tcp' ? 'tcp' : cols[0] === 'udp' ? 'udp' : undefined
    const local = proto && endpoint(cols[4]!)
    if (!proto || !local) continue
    for (const match of line.matchAll(/pid=(\d+)/g)) out.push({ pid: Number(match[1]), proto, ...local })
  }
  return out
}

/** Loopback only: 127.0.0.0/8, ::1 and an IPv4-mapped loopback. Any address, `*` and every other address are not. */
export function isLoopback(address: string): boolean {
  const plain = address.replace(/^::ffff:/i, '')
  return /^127\.\d+\.\d+\.\d+$/.test(plain) || plain === '::1' || plain === 'localhost'
}

/** This process and every process under it, from `pid ppid` pairs. */
export function descendants(root: number, pairs: Array<[number, number]>): Set<number> {
  const found = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, parent] of pairs)
      if (found.has(parent) && !found.has(pid)) {
        found.add(pid)
        grew = true
      }
  }
  return found
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || (result.status !== 0 && !result.stdout))
    throw new Error(`${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`)
  return result.stdout
}

function processPairs(): Array<[number, number]> {
  const text =
    process.platform === 'win32'
      ? run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
        ])
      : run('ps', ['-A', '-o', 'pid=', '-o', 'ppid='])
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols): cols is [number, number] => cols.length === 2 && cols.every(Number.isInteger))
}

function allBinds(): Bind[] {
  if (process.platform === 'win32') return parseNetstat(run('netstat', ['-ano']))
  if (process.platform === 'darwin') return parseLsof(run('lsof', ['-nP', '-i']))
  return parseSs(run('ss', ['-Hlntup']))
}

/** What this process and its children listen on outside loopback, as the OS says now. */
export function offLoopbackBinds(): Bind[] {
  const mine = descendants(process.pid, processPairs())
  return allBinds().filter((bind) => mine.has(bind.pid) && !isLoopback(bind.address))
}
