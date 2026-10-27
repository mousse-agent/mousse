import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * known_hosts reading for the host key prompt. Mousse reads these files itself rather than asking
 * `ssh-keygen -F`: it needs no process, and it finds hashed entries (`HashKnownHosts yes` on
 * Debian and Ubuntu) by hashing the name the way OpenSSH does. Mousse's own file is plain text it
 * writes itself; the user's and the system files are only ever read.
 */

export interface KnownHostsLine {
  marker?: '@revoked' | '@cert-authority'
  /** The first field: a comma list of names or patterns, or `|1|salt|hash`. */
  names: string
  type: string
  key: string
  raw: string
}

export type HostKeyState = 'unknown' | 'trusted' | 'changed' | 'revoked'

export interface HostKeyJudgement {
  state: HostKeyState
  /** The deciding file held a different key of the same type. */
  changed?: { previousFingerprint: string; file: string }
  /** Files that hold an old key of this type but did not decide; ssh accepts the host anyway. */
  stale?: Array<{ file: string; previousFingerprint: string }>
  /** Key types the host is known by when it is unknown by this one. */
  knownByOtherTypes?: string[]
}

export function parseKnownHosts(text: string): KnownHostsLine[] {
  const lines: KnownHostsLine[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s+/u)
    let marker: KnownHostsLine['marker']
    if (fields[0] === '@revoked' || fields[0] === '@cert-authority')
      marker = fields.shift() as never
    const [names, type, key] = fields
    if (!names || !type || !key) continue
    lines.push({ ...(marker ? { marker } : {}), names, type, key, raw: trimmed })
  }
  return lines
}

/** `SHA256:` plus the unpadded base64 digest of the key blob, as OpenSSH prints it. */
export function keyFingerprint(key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/u, '')}`
}

function globMatches(pattern: string, name: string): boolean {
  const expression = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replace(/\*/gu, '.*')
      .replace(/\?/gu, '.')}$`,
    'iu'
  )
  return expression.test(name)
}

/** Whether a line applies to `name` (`host` or `[host]:port`). Negated patterns win. */
export function lineMatchesName(line: KnownHostsLine, name: string): boolean {
  if (line.marker === '@cert-authority') return false
  if (line.names.startsWith('|1|')) {
    const [, , salt, hash] = line.names.split('|')
    if (!salt || !hash) return false
    try {
      return createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash
    } catch {
      return false
    }
  }
  let positive = false
  for (const pattern of line.names.split(',')) {
    if (pattern.startsWith('!')) {
      if (globMatches(pattern.slice(1), name)) return false
    } else if (globMatches(pattern, name)) positive = true
  }
  return positive
}

async function readLines(file: string): Promise<KnownHostsLine[]> {
  try {
    return parseKnownHosts(await readFile(file, 'utf8'))
  } catch {
    // A missing or unreadable file is the normal state and counts as no match.
    return []
  }
}

export interface KnownHostsFiles {
  /** Mousse's own file. */
  mousse: string
  user: string
  global: string[]
}

/** The key as a host offers it. */
export interface OfferedKey {
  name: string
  type: string
  key: string
}

/**
 * Whether the offered key is already trusted. The Mousse file decides when it holds a key of this
 * type for the host (it is the record of what the person confirmed here); otherwise the user's and
 * the system files decide. `@revoked` always wins, as it does in terminal ssh.
 */
export async function judgeHostKey(
  offered: OfferedKey,
  files: KnownHostsFiles
): Promise<HostKeyJudgement> {
  const lookup = async (file: string) =>
    (await readLines(file)).filter((line) => lineMatchesName(line, offered.name))
  const mousse = await lookup(files.mousse)
  const others = await Promise.all(
    [files.user, ...files.global].map(async (file) => ({ file, lines: await lookup(file) }))
  )
  const all = [{ file: files.mousse, lines: mousse }, ...others]
  if (all.some(({ lines }) => lines.some((l) => l.marker === '@revoked' && l.key === offered.key)))
    return { state: 'revoked' }
  const sameType = (lines: KnownHostsLine[]) =>
    lines.filter((line) => !line.marker && line.type === offered.type)
  const equal = (lines: KnownHostsLine[]) => lines.some((line) => line.key === offered.key)
  const stale = (except?: string) =>
    others
      .filter(({ file }) => file !== except)
      .flatMap(({ file, lines }) =>
        sameType(lines)
          .filter((line) => line.key !== offered.key)
          .map((line) => ({ file, previousFingerprint: keyFingerprint(line.key) }))
      )
  const mousseSame = sameType(mousse)
  if (mousseSame.length) {
    if (equal(mousseSame)) {
      const extra = stale()
      return { state: 'trusted', ...(extra.length ? { stale: extra } : {}) }
    }
    return {
      state: 'changed',
      changed: { previousFingerprint: keyFingerprint(mousseSame[0]!.key), file: files.mousse }
    }
  }
  const sameOthers = others.map(({ file, lines }) => ({ file, lines: sameType(lines) }))
  if (sameOthers.some(({ lines }) => equal(lines))) {
    const extra = stale()
    return { state: 'trusted', ...(extra.length ? { stale: extra } : {}) }
  }
  const differing = sameOthers.find(({ lines }) => lines.length)
  if (differing)
    return {
      state: 'changed',
      changed: {
        previousFingerprint: keyFingerprint(differing.lines[0]!.key),
        file: differing.file
      }
    }
  const types = [
    ...new Set(all.flatMap(({ lines }) => lines.filter((l) => !l.marker).map((line) => line.type)))
  ]
  return { state: 'unknown', ...(types.length ? { knownByOtherTypes: types } : {}) }
}

export function knownHostsLine(offered: OfferedKey): string {
  return `${offered.name} ${offered.type} ${offered.key}`
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Adds the key to Mousse's file. With `replace` it first drops only the lines for this host whose
 * key type equals the new key's type; other algorithms, other hosts and marker lines stay. No
 * `ssh-keygen -R`: it removes every key for the name and leaves a backup with default permissions.
 */
export async function writeTrustedKey(
  file: string,
  offered: OfferedKey,
  replace: boolean
): Promise<'added' | 'present' | 'replaced'> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // New file.
  }
  const existing = text.split(/\r?\n/u).filter((line) => line.length)
  const wanted = knownHostsLine(offered)
  if (existing.some((line) => line.trim() === wanted)) return 'present'
  const kept: string[] = []
  let removed = false
  for (const line of existing) {
    const [parsed] = parseKnownHosts(line)
    if (
      replace &&
      parsed &&
      !parsed.marker &&
      parsed.type === offered.type &&
      lineMatchesName(parsed, offered.name)
    ) {
      removed = true
      const rest = parsed.names
        .split(',')
        .filter((name) => name !== offered.name && !name.startsWith('!'))
      if (rest.length && !parsed.names.startsWith('|1|'))
        kept.push(`${rest.join(',')} ${parsed.type} ${parsed.key}`)
      continue
    }
    kept.push(line)
  }
  await writeAtomic(file, [...kept, wanted].join('\n') + '\n')
  return removed ? 'replaced' : 'added'
}

/** Removes the lines for one host name from Mousse's file. */
export async function removeTrustedName(file: string, name: string): Promise<void> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return
  }
  const kept = text.split(/\r?\n/u).filter((line) => {
    if (!line.length) return false
    const [parsed] = parseKnownHosts(line)
    return !(parsed && !parsed.marker && parsed.names === name)
  })
  await writeAtomic(file, kept.length ? kept.join('\n') + '\n' : '')
}
