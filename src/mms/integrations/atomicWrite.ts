import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
  await writeFile(tmp, data)
  try {
    await rename(tmp, path)
  } catch {
    await rm(path, { force: true }).catch(() => {})
    await rename(tmp, path)
  }
}
