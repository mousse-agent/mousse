import { describe, expect, it } from 'vitest'
import { LOCAL_STT_MODELS, PARAKEET_TDT_110M, findLocalSttModel } from '../src/shared/dictation'
import { detokenize, greedyTdtSearch, parseTokens } from '../src/renderer/dictation/tdtSearch'

const BLANK = 3

/** Token scores for ids 0..3 (3 is blank) followed by duration scores for 0..2 frames. */
function logits(token: number, duration: number): number[] {
  const scores = [0, 0, 0, 0, 0, 0, 0]
  scores[token] = 1
  scores[BLANK + 1 + duration] = 1
  return scores
}

describe('greedyTdtSearch', () => {
  it('emits tokens, skips frames by the predicted duration and advances the prediction on tokens only', async () => {
    // frame 0: token 0, stay; frame 0: token 1, skip 2; frame 2: blank, skip 1; frame 3: token 2, skip 1.
    const script = new Map<string, number[]>([
      ['0:start', logits(0, 0)],
      ['0:0', logits(1, 2)],
      ['2:1', logits(BLANK, 1)],
      ['3:1', logits(2, 1)]
    ])
    const joints: string[] = []
    const tokens = await greedyTdtSearch<string>({
      frames: 4,
      blank: BLANK,
      maxSymbolsPerFrame: 10,
      start: async () => 'start',
      predict: async (token) => String(token),
      joint: async (frame, prediction) => {
        joints.push(`${frame}:${prediction}`)
        return script.get(`${frame}:${prediction}`)!
      }
    })
    expect(tokens).toEqual([0, 1, 2])
    expect(joints).toEqual(['0:start', '0:0', '2:1', '3:1'])
  })

  it('moves on after too many tokens on one frame', async () => {
    const tokens = await greedyTdtSearch<number>({
      frames: 2,
      blank: BLANK,
      maxSymbolsPerFrame: 2,
      start: async () => 0,
      predict: async (_token, previous) => previous + 1,
      joint: async () => logits(1, 0)
    })
    expect(tokens).toEqual([1, 1, 1, 1])
  })

  it('treats a blank with no duration as one frame', async () => {
    let calls = 0
    const tokens = await greedyTdtSearch<null>({
      frames: 3,
      blank: BLANK,
      maxSymbolsPerFrame: 10,
      start: async () => null,
      predict: async () => null,
      joint: async () => {
        calls += 1
        return logits(BLANK, 0)
      }
    })
    expect(tokens).toEqual([])
    expect(calls).toBe(3)
  })
})

describe('Parakeet tokens', () => {
  it('reads sherpa-onnx tokens.txt and joins word pieces', () => {
    const vocabulary = parseTokens('<unk> 0\n▁hel 1\nlo 2\n▁world 3\n, 4\n<blk> 5\n')
    expect(vocabulary).toEqual(['<unk>', '▁hel', 'lo', '▁world', ',', '<blk>'])
    expect(detokenize(vocabulary, [1, 2, 4, 3])).toBe('hello, world')
  })
})

describe('Parakeet TDT 110M manifest', () => {
  it('is listed with its three models and vocabulary in the verified files', () => {
    expect(LOCAL_STT_MODELS).toContain(PARAKEET_TDT_110M)
    expect(findLocalSttModel('parakeet-tdt-110m')).toBe(PARAKEET_TDT_110M)
    const paths = PARAKEET_TDT_110M.files.map((file) => file.path)
    for (const path of [PARAKEET_TDT_110M.encoder, PARAKEET_TDT_110M.decoder, PARAKEET_TDT_110M.joiner, PARAKEET_TDT_110M.tokens]) {
      expect(paths).toContain(path)
    }
    for (const file of PARAKEET_TDT_110M.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
