import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../../data/AtomicFs'

/**
 * The agent host id OpenAI asks for at every sign-in (`ext_agent_host_id`). One per installation,
 * shared by its profiles: the docs count profiles on one machine as one host. It is random, never
 * derived from user data, and survives sign-out and instance deletion.
 */

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface HostFile {
  version: 1
  hostId: string
}

export function chatgptHostIdPath(installationHome: string): string {
  return join(installationHome, 'harness', 'chatgpt-host.json')
}

function readHostId(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostFile>
    return parsed.version === 1 && typeof parsed.hostId === 'string' && HOST_ID.test(parsed.hostId) ? parsed.hostId : null
  } catch {
    return null
  }
}

/**
 * The installation's host id, created on first use. The file is written in full under a temporary
 * name and then linked into place, so a second process either wins or reads the first one's id.
 */
export function ensureChatGptHostId(installationHome: string): string {
  const path = chatgptHostIdPath(installationHome)
  const existing = readHostId(path)
  if (existing) return existing
  mkdirSync(dirname(path), { recursive: true })
  const content = `${JSON.stringify({ version: 1, hostId: `urn:uuid:${randomUUID().toLowerCase()}` } satisfies HostFile, null, 2)}\n`
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    try {
      linkSync(temporary, path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        const winner = readHostId(path)
        if (winner) return winner
        // An unreadable file holds no id worth keeping: replace it.
        atomicWriteFileSync(path, content, { mode: 0o600 })
      } else {
        // Filesystems without hard links: a rename can only race another first run.
        const winner = readHostId(path)
        if (winner) return winner
        renameSync(temporary, path)
      }
    }
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed or already gone */ }
  }
  const saved = readHostId(path)
  if (!saved) throw new Error('The ChatGPT host id could not be saved.')
  return saved
}
