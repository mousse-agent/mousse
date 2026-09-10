import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { MigrationValidationError, ProfilePathError } from '../../../shared/profiles/errors'
import { digestPath, digestsEqual } from './digest'

export function copyTreeAtomic(source: string, destination: string): void {
  if (!existsSync(source)) {
    throw new ProfilePathError('Migration source is missing', { source })
  }
  if (lstatSync(source).isSymbolicLink()) {
    throw new ProfilePathError('Refusing to copy a symlink tree', { source })
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    if (lstatSync(source).isFile()) {
      mkdirSync(dirname(temporary), { recursive: true, mode: 0o700 })
      cpSync(source, temporary)
    } else {
      mkdirSync(dirname(temporary), { recursive: true, mode: 0o700 })
      cpSync(source, temporary, { recursive: true, errorOnExist: true })
    }
    const sourceDigest = digestPath(source)
    const copiedDigest = digestPath(temporary)
    if (!digestsEqual(sourceDigest, copiedDigest)) {
      throw new MigrationValidationError('Copied tree hash does not match the source', {
        source,
        destination: temporary,
        sourceDigest,
        copiedDigest
      })
    }
    if (existsSync(destination)) {
      if (isEmptyDirectory(destination)) {
        rmSync(destination, { recursive: true, force: true })
      } else {
        const existing = digestPath(destination)
        if (digestsEqual(existing, sourceDigest)) {
          rmSync(temporary, { recursive: true, force: true })
          return
        }
        throw new MigrationValidationError('Destination already exists with a different hash', {
          source,
          destination,
          sourceDigest,
          existing
        })
      }
    }
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function copyFileIfPresent(source: string, destination: string): boolean {
  if (!existsSync(source)) return false
  if (lstatSync(source).isDirectory()) {
    copyTreeAtomic(source, destination)
    return true
  }
  copyTreeAtomic(source, destination)
  return true
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function isEmptyDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && readdirSync(path).length === 0
  } catch {
    return false
  }
}
