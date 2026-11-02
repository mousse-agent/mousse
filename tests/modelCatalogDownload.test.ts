/**
 * The model catalog downloaded between releases: a fake GitHub and a throwaway Ed25519 key passed as
 * `keys`; nothing reaches the network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_MODEL_CATALOG_BYTES,
  MODEL_CATALOG_CHECK_INTERVAL_MS,
  MODEL_CATALOG_SIGNATURE_URL,
  MODEL_CATALOG_URL,
  ModelCatalogDownload
} from '../src/mms/models/catalogDownload'
import { bundledModelCatalog, modelCatalog, onModelCatalogChange, readModelCatalog, setDownloadedModelCatalog } from '../src/mms/models/modelCatalog'

function keyPair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }
}

const signer = keyPair()
const KEYS = [signer.publicKey]
const BUNDLED = bundledModelCatalog().revision

function catalogBytes(revision: number, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(`${JSON.stringify({
    format: 1,
    revision,
    models: [{ id: 'ember-new', name: 'Claude Ember 10', short: 'Ember 10', maker: 'anthropic', released: '2031-05-01', routes: { claude: { id: 'ember-new' } } }],
    ...extra
  })}\n`)
}

const signed = (bytes: Buffer, key: KeyObject = signer.privateKey) => sign(null, bytes, key)

/** A fresh answer each time it is asked for, or a failure to connect. */
type Answer = (() => Response) | Error
const reply = (body: BodyInit | null, init?: ResponseInit): Answer => () => new Response(body, init)
/** A fake GitHub: each address answers as `answers` says, everything else is a 404. */
function github(answers: Record<string, Answer>) {
  return vi.fn(async (input: string | URL | Request) => {
    const answer = answers[String(input)]
    if (answer instanceof Error) throw answer
    return answer ? answer() : new Response('Not Found', { status: 404 })
  })
}

/** Both files published: the catalog answered through GitHub's asset redirect, as GitHub does. */
function published(bytes: Buffer, signature: Uint8Array = signed(bytes)): Record<string, Answer> {
  const asset = 'https://release-assets.githubusercontent.com/models-1.json'
  return {
    [MODEL_CATALOG_URL]: reply(null, { status: 302, headers: { location: asset } }),
    [asset]: reply(bytes),
    [MODEL_CATALOG_SIGNATURE_URL]: reply(signature)
  }
}

const homes: string[] = []
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-model-catalog-download-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  setDownloadedModelCatalog(undefined)
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function download(dir: string, fetch: ReturnType<typeof github>, options: { now?: () => number; keys?: readonly string[] } = {}) {
  const log = vi.fn()
  const service = new ModelCatalogDownload(dir, { fetch: fetch as unknown as typeof globalThis.fetch, keys: KEYS, log, ...options })
  return { service, log }
}

describe('model catalog downloads', () => {
  it('uses a signed copy with a higher revision, caches it, and tells subscribers', async () => {
    const dir = home()
    const bytes = catalogBytes(BUNDLED + 1)
    const fetch = github(published(bytes))
    const changed = vi.fn(() => readModelCatalog().revision)
    const stop = onModelCatalogChange(changed)
    try {
      const { service } = download(dir, fetch)
      await expect(service.refresh()).resolves.toBe(true)
    } finally {
      stop()
    }
    expect(changed.mock.results.map((call) => call.value)).toEqual([BUNDLED + 1])
    expect(modelCatalog().models.map((model) => model.id)).toEqual(['ember-new'])
    expect(readFileSync(join(dir, 'model-catalog.json'))).toEqual(bytes)
    expect(readFileSync(join(dir, 'model-catalog.json.sig'))).toEqual(signed(bytes))
    // The next start uses the cached copy before asking GitHub again.
    setDownloadedModelCatalog(undefined)
    expect(readModelCatalog().revision).toBe(BUNDLED)
    download(dir, github({})).service.loadCache()
    expect(readModelCatalog().revision).toBe(BUNDLED + 1)
  })

  it('ignores a copy whose revision is not higher than the catalog in use, the bundled one winning a tie', async () => {
    for (const revision of [BUNDLED, BUNDLED - 1]) {
      const dir = home()
      const changed = vi.fn()
      const stop = onModelCatalogChange(changed)
      const { service, log } = download(dir, github(published(catalogBytes(revision))))
      await expect(service.refresh()).resolves.toBe(false)
      stop()
      expect(changed).not.toHaveBeenCalled()
      expect(readModelCatalog()).toBe(bundledModelCatalog())
      expect(existsSync(join(dir, 'model-catalog.json'))).toBe(false)
      expect(log).not.toHaveBeenCalled()
    }
    // Nor one at or below a downloaded copy already in use.
    const dir = home()
    await download(dir, github(published(catalogBytes(BUNDLED + 3)))).service.refresh()
    const { service } = download(home(), github(published(catalogBytes(BUNDLED + 2))))
    await expect(service.refresh()).resolves.toBe(false)
    expect(readModelCatalog().revision).toBe(BUNDLED + 3)
  })

  it('rejects a copy whose signature does not check: another key, changed bytes, or none published', async () => {
    const bytes = catalogBytes(BUNDLED + 1)
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 3] ^= 1
    const cases: Record<string, Answer>[] = [
      published(bytes, signed(bytes, keyPair().privateKey)),
      { ...published(bytes), [MODEL_CATALOG_SIGNATURE_URL]: reply(signed(tampered)) },
      { ...published(bytes), [MODEL_CATALOG_SIGNATURE_URL]: reply('Not Found', { status: 404 }) }
    ]
    for (const answers of cases) {
      const dir = home()
      const { service, log } = download(dir, github(answers))
      await expect(service.refresh()).resolves.toBe(false)
      expect(readModelCatalog()).toBe(bundledModelCatalog())
      expect(existsSync(join(dir, 'model-catalog.json'))).toBe(false)
      expect(log).toHaveBeenCalledOnce()
    }
  })

  it('never fetches or uses a copy when the build has no key, and says so once', async () => {
    const dir = home()
    // A cache that would verify with the test key is there all the same.
    const bytes = catalogBytes(BUNDLED + 1)
    writeFileSync(join(dir, 'model-catalog.json'), bytes)
    writeFileSync(join(dir, 'model-catalog.json.sig'), signed(bytes))
    const fetch = github(published(bytes))
    const { service, log } = download(dir, fetch, { keys: [] })
    service.loadCache()
    await expect(service.refresh({ force: true })).resolves.toBe(false)
    await service.refresh()
    expect(fetch).not.toHaveBeenCalled()
    expect(readModelCatalog()).toBe(bundledModelCatalog())
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatch(/no key/)
  })

  it('rejects a copy over the size cap, declared or streamed', async () => {
    const big = Buffer.concat([catalogBytes(BUNDLED + 1), Buffer.alloc(MAX_MODEL_CATALOG_BYTES, ' ')])
    const streamed = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(big))
        controller.close()
      }
    }))
    for (const answer of [reply(big, { headers: { 'content-length': String(big.length) } }), streamed]) {
      const { service, log } = download(home(), github({ [MODEL_CATALOG_URL]: answer, [MODEL_CATALOG_SIGNATURE_URL]: reply(signed(big)) }))
      await expect(service.refresh()).resolves.toBe(false)
      expect(readModelCatalog()).toBe(bundledModelCatalog())
      expect(log.mock.calls[0]![0]).toMatch(/larger than 262144 bytes/)
    }
  })

  it('rejects a signed copy of an unknown format, or one that is not a catalog', async () => {
    for (const bytes of [catalogBytes(BUNDLED + 1, { format: 2 }), Buffer.from('{"format":1,')]) {
      const { service, log } = download(home(), github(published(bytes)))
      await expect(service.refresh()).resolves.toBe(false)
      expect(readModelCatalog()).toBe(bundledModelCatalog())
      expect(log).toHaveBeenCalledOnce()
    }
  })

  it('does not follow a redirect to a host outside GitHub\'s asset hosts', async () => {
    const bytes = catalogBytes(BUNDLED + 1)
    const fetch = github({
      ...published(bytes),
      [MODEL_CATALOG_URL]: reply(null, { status: 302, headers: { location: 'https://evil.example/models-1.json' } }),
      'https://evil.example/models-1.json': reply(bytes)
    })
    const { service, log } = download(home(), fetch)
    await expect(service.refresh()).resolves.toBe(false)
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([MODEL_CATALOG_URL])
    expect(readModelCatalog()).toBe(bundledModelCatalog())
    expect(log.mock.calls[0]![0]).toMatch(/evil\.example/)
  })

  it('is quiet when nothing is published', async () => {
    const fetch = github({})
    const { service, log } = download(home(), fetch)
    await expect(service.refresh()).resolves.toBe(false)
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([MODEL_CATALOG_URL])
    expect(log).not.toHaveBeenCalled()
  })

  it('ignores a cache that is corrupt or no longer verifies, and keeps the bundled copy', () => {
    const bytes = catalogBytes(BUNDLED + 1)
    const cases: Array<[Buffer | string, Uint8Array]> = [
      // Changed after it was saved.
      [Buffer.concat([bytes, Buffer.from(' ')]), signed(bytes)],
      // Signed, but not a catalog.
      ['{"format":1,', signed(Buffer.from('{"format":1,'))],
      // A cut-off signature.
      [bytes, signed(bytes).subarray(0, 10)]
    ]
    for (const [json, signature] of cases) {
      const dir = home()
      writeFileSync(join(dir, 'model-catalog.json'), json)
      writeFileSync(join(dir, 'model-catalog.json.sig'), signature)
      const { service, log } = download(dir, github({}))
      service.loadCache()
      expect(readModelCatalog()).toBe(bundledModelCatalog())
      expect(log).toHaveBeenCalledOnce()
    }
    // No cache at all is nothing to say.
    const { service, log } = download(home(), github({}))
    service.loadCache()
    expect(log).not.toHaveBeenCalled()
  })

  it('asks GitHub at most every 6 hours, across restarts, but retries a network failure on the next call', async () => {
    const dir = home()
    let now = 1_000_000
    const offline = github({ [MODEL_CATALOG_URL]: new TypeError('fetch failed') })
    await download(dir, offline, { now: () => now }).service.refresh()
    expect(offline).toHaveBeenCalledOnce()
    // A network failure is no answer: the next call asks again.
    const fetch = github({})
    const first = download(dir, fetch, { now: () => now })
    await first.service.refresh()
    expect(fetch).toHaveBeenCalledOnce()
    now += MODEL_CATALOG_CHECK_INTERVAL_MS - 1
    await first.service.refresh()
    // A restart keeps the time of the last answer.
    await download(dir, fetch, { now: () => now }).service.refresh()
    expect(fetch).toHaveBeenCalledOnce()
    now += 1
    await first.service.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
