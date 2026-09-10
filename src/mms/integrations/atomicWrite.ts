import { existsSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
  const backup = join(dirname(path), `.${randomBytes(8).toString('hex')}.backup`)
  await writeFile(tmp, data)
  let backedUp = false
  try {
    await rename(tmp, path)
  } catch (firstError) {
    try {
      if (existsSync(path)) {
        await rename(path, backup)
        backedUp = true
      }
      await rename(tmp, path)
      if (backedUp) await rm(backup, { force: true }).catch(() => {})
    } catch (error) {
      if (backedUp && !existsSync(path)) await rename(backup, path).catch(() => {})
      throw error instanceof Error ? error : firstError
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
    if (backedUp && existsSync(backup) && !existsSync(path)) {
      await rename(backup, path).catch(() => {})
    }
  }
}
