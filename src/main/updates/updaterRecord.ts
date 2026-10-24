import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UpdateChannel } from '../../shared/updates'

/** What the updater keeps between launches, in Electron's userData directory. */
export interface UpdaterRecord {
  /** Set only when the user picked a channel; otherwise the build's own channel applies. */
  channel?: UpdateChannel
  /** Written just before the installer runs, so the next launch can tell whether it applied. */
  install?: { from: string; to: string; at: number }
}

export interface UpdaterRecordStore {
  read(): UpdaterRecord
  write(record: UpdaterRecord): void
}

function isChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'nightly'
}

/** A small JSON file, replaced atomically. A missing or unreadable file reads as empty. */
export function updaterRecordFile(path: string): UpdaterRecordStore {
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const install = raw.install as UpdaterRecord['install'] | undefined
        return {
          ...(isChannel(raw.channel) ? { channel: raw.channel } : {}),
          ...(install && typeof install.from === 'string' && typeof install.to === 'string' && typeof install.at === 'number'
            ? { install: { from: install.from, to: install.to, at: install.at } }
            : {})
        }
      } catch {
        return {}
      }
    },
    write(record) {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
      renameSync(temp, path)
    }
  }
}
