/**
 * Greedy search for a Token-and-Duration Transducer (NeMo's TDT). For each encoder frame the joiner
 * scores the next token and, after the token scores, how many frames to move ahead. The prediction
 * network only advances when a real token is emitted. Pure, so the decoding rules are tested apart
 * from the ONNX models.
 */
export interface TdtSearch<Prediction> {
  /** Encoder frames to walk. */
  frames: number
  /** Id of the blank token; the token scores are `logits[0..blank]`. */
  blank: number
  /** The prediction after the start (blank) token. */
  start: () => Promise<Prediction>
  /** The prediction after emitting `token`, continuing from `previous`. */
  predict: (token: number, previous: Prediction) => Promise<Prediction>
  /** Token scores followed by one score per duration (0, 1, 2, ... frames). */
  joint: (frame: number, prediction: Prediction) => Promise<ArrayLike<number>>
  /** Tokens allowed on one frame before the search is pushed to the next one. */
  maxSymbolsPerFrame: number
}

function argmax(values: ArrayLike<number>, from: number, to: number): number {
  let best = from
  for (let index = from + 1; index < to; index += 1) if (values[index] > values[best]) best = index
  return best
}

/** Returns the emitted token ids in order. */
export async function greedyTdtSearch<Prediction>(search: TdtSearch<Prediction>): Promise<number[]> {
  const { frames, blank, maxSymbolsPerFrame } = search
  const tokens: number[] = []
  let prediction = await search.start()
  let emitted = 0
  for (let frame = 0; frame < frames; ) {
    const logits = await search.joint(frame, prediction)
    const token = argmax(logits, 0, blank + 1)
    let skip = argmax(logits, blank + 1, logits.length) - blank - 1
    if (token !== blank) {
      tokens.push(token)
      prediction = await search.predict(token, prediction)
      emitted += 1
    }
    // A blank must move on, and so must a frame that has emitted too many tokens.
    if (skip === 0 && (token === blank || emitted >= maxSymbolsPerFrame)) skip = 1
    if (skip > 0) emitted = 0
    frame += skip
  }
  return tokens
}

/** Joins SentencePiece pieces into text; `▁` starts a new word. */
export function detokenize(vocabulary: readonly string[], ids: readonly number[]): string {
  return ids
    .map((id) => vocabulary[id] ?? '')
    .join('')
    .replace(/▁/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reads sherpa-onnx `tokens.txt`: one `<piece> <id>` per line, ids in order. */
export function parseTokens(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.slice(0, line.lastIndexOf(' ')))
}
