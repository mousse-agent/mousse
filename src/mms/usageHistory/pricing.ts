/**
 * List prices for estimating what logged usage cost, in dollars per million tokens. A model that
 * matches no row stays unpriced: its tokens count, its cost is left out.
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  /** Writing the prompt cache (five-minute lifetime). */
  cacheWrite: number
}

const anthropic = (input: number, output: number, cacheRead = input / 10): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: input * 1.25 })
const openai = (input: number, output: number, cacheRead = input / 10): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: input })

/** First match wins, so more specific patterns come first. */
const PRICES: ReadonlyArray<readonly [RegExp, ModelPrice]> = [
  [/fable-5-2|fable-5\.2/, anthropic(8, 40, 0.2)],
  [/fable|mythos/, anthropic(10, 50)],
  [/opus-5-5|opus-5\.5/, anthropic(4, 20, 0.2)],
  [/opus/, anthropic(5, 25)],
  [/sonnet-5-5|sonnet-5\.5/, anthropic(2, 10, 0.1)],
  [/sonnet-5/, anthropic(2, 10)],
  [/sonnet/, anthropic(3, 15)],
  [/haiku-5/, anthropic(0.1, 0.5)],
  [/haiku/, anthropic(1, 5)],
  [/gpt-[56][.\d]*-?(codex-)?mini/, openai(0.25, 2)],
  [/gpt-[56]|codex/, openai(1.25, 10)],
  [/grok/, openai(3, 15, 0.75)]
]

const cache = new Map<string, ModelPrice | null>()

export function priceFor(model: string): ModelPrice | null {
  const key = model.toLowerCase()
  let price = cache.get(key)
  if (price === undefined) {
    price = PRICES.find(([pattern]) => pattern.test(key))?.[1] ?? null
    cache.set(key, price)
  }
  return price
}

export function costOf(price: ModelPrice, input: number, cacheRead: number, cacheWrite: number, output: number): number {
  return (input * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + output * price.output) / 1e6
}
