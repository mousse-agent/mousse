import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KokoroFrontEnd, KokoroTokenizer, MAX_TOKENS, kokoroStyle } from '../src/main/readAloud/kokoroText'
import { KOKORO_82M } from '../src/shared/readAloud'

// The model's own tokenizer files (onnx-community/Kokoro-82M-v1.0-ONNX at the pinned revision).
const fixtures = join(__dirname, 'fixtures', 'kokoro')
const tokenizerJson = readFileSync(join(fixtures, 'tokenizer.json'))
const tokenizerConfig = JSON.parse(readFileSync(join(fixtures, 'tokenizer_config.json'), 'utf8'))
// kokoro-js ships the same voice files as the model.
const voicesDir = join(dirname(createRequire(import.meta.url).resolve('kokoro-js')), '..', 'voices')

const readFile = async (path: string): Promise<Uint8Array> =>
  path === 'tokenizer.json' ? tokenizerJson : readFileSync(join(voicesDir, path.replace(/^voices\//, '')))

/** What kokoro-js hands its model for `text`, from a model that only records its inputs. */
async function kokoroJsInputs(texts: Array<[string, string]>): Promise<Array<{ inputIds: number[]; style: number[] }>> {
  const { PreTrainedTokenizer } = await import('@huggingface/transformers')
  const { KokoroTTS } = await import('kokoro-js')
  const captured: Array<{ inputIds: number[]; style: number[] }> = []
  const model = async (inputs: { input_ids: { data: BigInt64Array }; style: { data: Float32Array } }) => {
    captured.push({ inputIds: Array.from(inputs.input_ids.data, Number), style: Array.from(inputs.style.data) })
    return { waveform: { data: new Float32Array(1) } }
  }
  const tokenizer = new PreTrainedTokenizer(JSON.parse(tokenizerJson.toString('utf8')), tokenizerConfig)
  const tts = new KokoroTTS(model as never, tokenizer)
  for (const [text, voice] of texts) await tts.generate(text, { voice: voice as never })
  return captured
}

const CORPUS: Array<[string, string]> = [
  ['Sure, here is the plan.', 'af_heart'],
  ['When you stop a read, the engine that was still voicing the old text is shut down and replaced right away.', 'af_heart'],
  ['Dr. Smith met Mr. Jones and Mrs. Brown at 10:30, then again at 3:05 and 7:00.', 'am_michael'],
  ['It cost $5.50, or £1.01, versus $1 and $1,000,000 in 1999 and the 1980s.', 'af_bella'],
  ['Pi is roughly 3.14159; the range is 10-20 and the U.S. economy grew.', 'bf_emma'],
  ['"Quoted" text (with parentheses), an em dash — and an ellipsis… Yeah!', 'bm_george'],
  ['Kokoro reads ninety nine bottles; the CEO’s plan, etc. works.', 'af_heart'],
  ['Line one.\n\nLine two\twith a tab and  two spaces, and an emoji 🎉 that has no sound.', 'am_adam'],
  ['Hello', 'af_sky'],
  ['?!', 'af_heart'],
  // Longer than the model takes, so it is cut.
  [Array.from({ length: 40 }, (_, index) => `Sentence number ${index} keeps going for a while.`).join(' '), 'af_heart']
]

describe('Kokoro text front end', () => {
  it("gives the model exactly kokoro-js's token ids and style", async () => {
    const expected = await kokoroJsInputs(CORPUS)
    const frontEnd = new KokoroFrontEnd(KOKORO_82M, readFile)
    const actual = []
    for (const [text, voice] of CORPUS) {
      const inputs = await frontEnd.prepare(text, voice)
      actual.push({ inputIds: inputs.inputIds, style: Array.from(inputs.style) })
    }
    expect(actual).toEqual(expected)
    // The long one reached the limit.
    expect(actual.at(-1)!.inputIds).toHaveLength(MAX_TOKENS)
  }, 60_000)

  it("uses the model's default voice for a name it does not have", async () => {
    const frontEnd = new KokoroFrontEnd(KOKORO_82M, readFile)
    expect(await frontEnd.prepare('Hello there.', 'zz_nobody')).toEqual(await frontEnd.prepare('Hello there.', 'af_heart'))
  })

  it('reads the tokenizer once and keeps the last two voices', async () => {
    const reads: string[] = []
    const frontEnd = new KokoroFrontEnd(KOKORO_82M, async (path) => {
      reads.push(path)
      return readFile(path)
    })
    for (const voice of ['af_heart', 'af_heart', 'bf_emma', 'af_heart', 'am_adam', 'bf_emma']) await frontEnd.prepare('Hi.', voice)
    expect(reads).toEqual(['tokenizer.json', 'voices/af_heart.bin', 'voices/bf_emma.bin', 'voices/am_adam.bin', 'voices/bf_emma.bin'])
  })

  it('tries a file again after a failed read', async () => {
    let fail = true
    const frontEnd = new KokoroFrontEnd(KOKORO_82M, async (path) => {
      if (fail && path.startsWith('voices/')) throw new Error('No network')
      return readFile(path)
    })
    await expect(frontEnd.prepare('Hi.', 'af_bella')).rejects.toThrow('No network')
    fail = false
    expect((await frontEnd.prepare('Hi.', 'af_bella')).style).toHaveLength(256)
  })

  it('refuses a tokenizer of another shape and a damaged voice file', () => {
    const json = JSON.parse(tokenizerJson.toString('utf8'))
    expect(() => KokoroTokenizer.fromJson({ ...json, pre_tokenizer: { type: 'Whitespace' } })).toThrow('tokenizer')
    expect(() => KokoroTokenizer.fromJson({})).toThrow('tokenizer')
    expect(() => kokoroStyle(new Float32Array(100), 3)).toThrow('damaged')
  })
})
