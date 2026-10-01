import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_METADATA_MAX_BYTES,
  FileArtifactStore
} from '../src/mms/execution/ArtifactStore'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function ownedRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `mousse-artifact-${label}-`))
  roots.push(root)
  return root
}

function artifactPaths(profileRoot: string, id: string) {
  const dir = join(profileRoot, 'artifacts', id)
  return { dir, meta: join(dir, 'meta.json'), blob: join(dir, 'blob') }
}

async function put(store: FileArtifactStore, runId: string | undefined = 'run-a', text = 'owned bytes') {
  return store.put({
    profileId: 'profile-a',
    ...(runId === undefined ? {} : { runId }),
    bytes: new TextEncoder().encode(text),
    mediaType: 'text/plain',
    displayName: 'owned.txt'
  })
}

describe('profile-owned file artifacts', () => {
  it('checks profile and exact expected run before touching blob bytes', async () => {
    const root = ownedRoot('ownership')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const ref = await put(store)
    rmSync(artifactPaths(root, ref.id).blob)

    await expect(store.get(ref.id, 'profile-b', { runId: 'run-a' })).rejects.toThrow('profile mismatch')
    await expect(store.get(ref.id, 'profile-a', { runId: 'run-b' })).rejects.toThrow('run mismatch')
    await expect(store.get(ref.id, 'profile-a', {})).rejects.toThrow('run mismatch')
    await expect(store.get(ref.id, 'profile-a', { runId: 'run-a' })).rejects.toThrow(/ENOENT|not found/i)
  })

  it('supports unowned browser-session artifacts while preserving legacy workflow reads', async () => {
    const root = ownedRoot('optional-run')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const workflow = await put(store, 'workflow-run')
    const session = await store.put({
      profileId: 'profile-a',
      bytes: new TextEncoder().encode('browser capture'),
      mediaType: 'image/png',
      displayName: 'capture.png'
    })

    await expect(store.get(workflow.id, 'profile-a')).resolves.toMatchObject({ ref: { runId: 'workflow-run' } })
    await expect(store.get(session.id, 'profile-a', {})).resolves.toMatchObject({ ref: { id: session.id } })
    await expect(store.get(session.id, 'profile-a', { runId: 'workflow-run' })).rejects.toThrow('run mismatch')
  })

  it('rejects malformed, oversized, and inconsistent metadata before blob allocation', async () => {
    const root = ownedRoot('metadata')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const malformed = await put(store)
    writeFileSync(artifactPaths(root, malformed.id).meta, '{')
    await expect(store.get(malformed.id, 'profile-a')).rejects.toThrow('Invalid artifact metadata')

    const oversized = await put(store)
    writeFileSync(artifactPaths(root, oversized.id).meta, Buffer.alloc(ARTIFACT_METADATA_MAX_BYTES + 1, 0x20))
    await expect(store.get(oversized.id, 'profile-a')).rejects.toThrow(`exceeds ${ARTIFACT_METADATA_MAX_BYTES} bytes`)

    const inconsistent = await put(store)
    const paths = artifactPaths(root, inconsistent.id)
    const metadata = JSON.parse(readFileSync(paths.meta, 'utf8'))
    metadata.byteLength = Number.MAX_SAFE_INTEGER
    writeFileSync(paths.meta, JSON.stringify(metadata))
    rmSync(paths.blob)
    await expect(store.get(inconsistent.id, 'profile-a')).rejects.toThrow('Invalid artifact byteLength')
  })

  it('enforces caller byte bounds from metadata before opening the blob', async () => {
    const root = ownedRoot('read-bound')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const ref = await put(store, 'run-a', 'sixteen-byte-msg')
    rmSync(artifactPaths(root, ref.id).blob)

    await expect(store.get(ref.id, 'profile-a', { runId: 'run-a', maxBytes: 8 })).rejects.toThrow('exceeds 8 bytes')
    await expect(store.get(ref.id, 'profile-a', { runId: 'run-a', maxBytes: -1 })).rejects.toThrow('Invalid artifact read limit')
  })

  it('rejects the store write bound before hashing or creating a record', async () => {
    const root = ownedRoot('write-bound')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const oversized = new Uint8Array(0)
    Object.defineProperty(oversized, 'byteLength', { value: ARTIFACT_MAX_BYTES + 1 })
    await expect(store.put({
      profileId: 'profile-a',
      runId: 'run-a',
      bytes: oversized,
      mediaType: 'application/octet-stream',
      displayName: 'too-large.bin'
    })).rejects.toThrow(`exceeds ${ARTIFACT_MAX_BYTES} bytes`)
    expect(readdirSync(join(root, 'artifacts'))).toEqual([])
  })

  it('retains root identity and refuses artifact-root and record-directory junction substitution', async () => {
    const root = ownedRoot('junctions')
    const outside = ownedRoot('outside')
    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const ref = await put(store)
    const artifactRoot = join(root, 'artifacts')
    const retained = join(root, 'artifacts-retained')
    renameSync(artifactRoot, retained)
    symlinkSync(outside, artifactRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.get(ref.id, 'profile-a')).rejects.toThrow(/Artifact root (is not|changed)/)

    rmSync(artifactRoot)
    mkdirSync(artifactRoot)
    await expect(store.get(ref.id, 'profile-a')).rejects.toThrow('Artifact root changed after initialization')
    rmdirSync(artifactRoot)
    renameSync(retained, artifactRoot)
    const second = new FileArtifactStore({ profileId: 'profile-a', profileRoot: root })
    const secondRef = await put(second)
    const record = artifactPaths(root, secondRef.id).dir
    const recordRetained = `${record}-retained`
    renameSync(record, recordRetained)
    mkdirSync(join(outside, 'record'))
    symlinkSync(join(outside, 'record'), record, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(second.get(secondRef.id, 'profile-a')).rejects.toThrow('record directory must be a regular directory')
  })

  it('rejects profile-root links at construction and blob links at read time', async () => {
    const actual = ownedRoot('actual-profile')
    const holder = ownedRoot('linked-profile-holder')
    const linked = join(holder, 'profile-link')
    symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new FileArtifactStore({ profileId: 'profile-a', profileRoot: linked })).toThrow('profile root must be a regular directory')

    const store = new FileArtifactStore({ profileId: 'profile-a', profileRoot: actual })
    const ref = await put(store)
    const paths = artifactPaths(actual, ref.id)
    const outsideBlob = join(holder, 'outside-blob')
    writeFileSync(outsideBlob, readFileSync(paths.blob))
    rmSync(paths.blob)
    try {
      symlinkSync(outsideBlob, paths.blob, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    await expect(store.get(ref.id, 'profile-a')).rejects.toThrow('blob must be a regular file')
  })
})
