import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalModelManager, defaultLocalModelsRoot } from '../src/main/localModels/LocalModelManager'
import { localModelFileUrl } from '../src/shared/localModels'
import type { LocalSttModel, LocalSttModelStatus } from '../src/shared/dictation'

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const CONFIG = new TextEncoder().encode('{"stt":true}')
const ENCODER = new Uint8Array(3000).map((_, index) => index % 199)

const model: LocalSttModel = {
  id: 'moonshine-base',
  label: 'Fake STT',
  description: 'test',
  parameters: '1M',
  license: 'MIT',
  homepage: 'https://example.test',
  repo: 'org/fake-stt',
  revision: 'rev1',
  dtype: { encoder_model: 'q8' },
  sampleRate: 16000,
  maxSegmentSeconds: 30,
  files: [
    { path: 'config.json', size: CONFIG.byteLength, sha256: sha(CONFIG) },
    { path: 'onnx/encoder_model_quantized.onnx', size: ENCODER.byteLength, sha256: sha(ENCODER) }
  ]
}

const bodies: Record<string, Uint8Array> = { 'config.json': CONFIG, 'onnx/encoder_model_quantized.onnx': ENCODER }
const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = String(input)
  for (const file of model.files) if (url === localModelFileUrl(model, file.path)) return new Response(bodies[file.path])
  return new Response('missing', { status: 404 })
}) as typeof fetch

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('LocalModelManager with a speech-to-text manifest', () => {
  it('downloads, serves allowlisted files, and deletes', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mousse-dictation-models-'))
    roots.push(rootDir)
    const events: LocalSttModelStatus[] = []
    const manager = new LocalModelManager({ rootDir, models: [model], fetchImpl, onStatus: (status) => events.push(status), progressIntervalMs: 0 })
    expect((await manager.list())[0]).toEqual({ modelId: 'moonshine-base', state: { status: 'not-downloaded' } })

    expect(await manager.download('moonshine-base')).toEqual({ modelId: 'moonshine-base', state: { status: 'downloaded' } })
    expect(events.at(-1)?.state).toEqual({ status: 'downloaded' })
    expect(Array.from(await manager.readFile('moonshine-base', 'onnx/encoder_model_quantized.onnx'))).toEqual(Array.from(ENCODER))
    await expect(manager.readFile('moonshine-base', '../config.json')).rejects.toThrow(/no file named/)

    expect((await manager.delete('moonshine-base')).state).toEqual({ status: 'not-downloaded' })
    await expect(manager.readFile('moonshine-base', 'config.json')).rejects.toThrow(/not downloaded/)
  })

  it('keeps speech-to-text and text-to-speech weights in separate folders', () => {
    expect(defaultLocalModelsRoot('stt')).toMatch(/models[\\/]stt$/)
    expect(defaultLocalModelsRoot('tts')).toMatch(/models[\\/]tts$/)
  })
})
