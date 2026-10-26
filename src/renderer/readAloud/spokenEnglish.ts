/**
 * Writes numbers, currency, times and similar symbols as English words, for models that read
 * letters and need digits spelled out. A port of the expansion steps of KittenTTS's
 * `TextPreprocessor` (KittenML/KittenTTS `kittentts/preprocess.py`, Apache-2.0), in the same order.
 * Left out: lowercasing, contraction expansion and URL/e-mail/HTML removal, which change how the
 * text sounds or would eat comparisons like `a < b`; read aloud already strips markup and links.
 * Two changes: a thousands group must be `,ddd`, so the comma in `1, 2` stays a comma, and
 * `twenty` becomes `twentieth` rather than `twentyth`.
 */

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion']
const ORDINAL_EXCEPTIONS: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth', six: 'sixth', seven: 'seventh',
  eight: 'eighth', nine: 'ninth', twelve: 'twelfth'
}
const CURRENCY: Record<string, string> = { $: 'dollar', '€': 'euro', '£': 'pound', '¥': 'yen', '₹': 'rupee', '₩': 'won', '₿': 'bitcoin' }
const SCALE_WORDS: Record<string, string> = { K: 'thousand', M: 'million', B: 'billion', T: 'trillion' }
const UNITS: Record<string, string> = {
  km: 'kilometers', kg: 'kilograms', mg: 'milligrams', ml: 'milliliters', gb: 'gigabytes', mb: 'megabytes', kb: 'kilobytes',
  tb: 'terabytes', hz: 'hertz', khz: 'kilohertz', mhz: 'megahertz', ghz: 'gigahertz', mph: 'miles per hour',
  kph: 'kilometers per hour', ms: 'milliseconds', ns: 'nanoseconds', 'µs': 'microseconds', '°c': 'degrees Celsius',
  'c°': 'degrees Celsius', '°f': 'degrees Fahrenheit', 'f°': 'degrees Fahrenheit'
}
const DECADES = ['hundreds', 'tens', 'twenties', 'thirties', 'forties', 'fifties', 'sixties', 'seventies', 'eighties', 'nineties']
const DIGIT_WORDS = ['zero', ...ONES.slice(1, 10)]

/** An integer with optional thousands groups: `1200`, `1,200`, `7,900,000,000`. */
const INTEGER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`
const NUMBER = `${INTEGER}(?:\\.\\d+)?`

function threeDigits(n: number): string {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`)
  if (rest < 20) {
    if (rest) parts.push(ONES[rest])
  } else {
    const tens = TENS[Math.floor(rest / 10)]
    const ones = ONES[rest % 10]
    parts.push(ones ? `${tens}-${ones}` : tens)
  }
  return parts.join(' ')
}

/** `1200` is "twelve hundred", `1000` "one thousand", `-42` "negative forty-two". Beyond a trillion digits are read one by one. */
export function numberToWords(value: number): string {
  let n = Math.trunc(value)
  if (n === 0) return 'zero'
  if (n < 0) return `negative ${numberToWords(-n)}`
  if (n >= 1e15) return Array.from(String(BigInt(n)), (digit) => DIGIT_WORDS[Number(digit)]).join(' ')
  if (n >= 100 && n <= 9999 && n % 100 === 0 && n % 1000 !== 0 && n / 100 < 20) return `${ONES[n / 100]} hundred`
  const parts: string[] = []
  for (const scale of SCALES) {
    const chunk = n % 1000
    if (chunk) parts.push(scale ? `${threeDigits(chunk)} ${scale}` : threeDigits(chunk))
    n = Math.floor(n / 1000)
    if (n === 0) break
  }
  return parts.reverse().join(' ')
}

/** A decimal string read digit by digit after the point: `3.10` is "three point one zero". */
export function decimalToWords(text: string): string {
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fraction] = unsigned.split('.')
  const words = fraction === undefined
    ? numberToWords(Number(whole))
    : `${whole ? numberToWords(Number(whole)) : 'zero'} point ${Array.from(fraction, (digit) => DIGIT_WORDS[Number(digit)]).join(' ')}`
  return negative ? `negative ${words}` : words
}

/** `5` is "fifth", `21` "twenty-first", `100` "one hundredth". */
export function ordinalWords(n: number): string {
  const words = numberToWords(n)
  const hyphen = words.lastIndexOf('-')
  const space = words.lastIndexOf(' ')
  const cut = hyphen > space ? hyphen : space
  const prefix = cut >= 0 ? words.slice(0, cut + 1) : ''
  const last = words.slice(cut + 1)
  let ordinal = ORDINAL_EXCEPTIONS[last]
  if (!ordinal) {
    if (last.endsWith('y')) ordinal = `${last.slice(0, -1)}ieth`
    else if (last.endsWith('t')) ordinal = `${last}h`
    else if (last.endsWith('e')) ordinal = `${last.slice(0, -1)}th`
    else ordinal = `${last}th`
  }
  return prefix + ordinal
}

const plain = (raw: string): string => raw.replace(/,/g, '')
const words = (raw: string): string => {
  const text = plain(raw)
  return text.includes('.') ? decimalToWords(text) : numberToWords(Number(text))
}
const digitsOf = (text: string): string => Array.from(text, (digit) => DIGIT_WORDS[Number(digit)]).join(' ')

function expandCurrency(text: string): string {
  return text.replace(new RegExp(String.raw`([$€£¥₹₩₿])\s*(${NUMBER})\s*([KMBT])?(?![a-zA-Z\d])`, 'g'), (_m, symbol: string, amount: string, suffix?: string) => {
    const raw = plain(amount)
    const unit = CURRENCY[symbol] ?? ''
    if (suffix) return `${words(raw)} ${SCALE_WORDS[suffix]} ${unit}${unit ? 's' : ''}`.trim()
    if (raw.includes('.')) {
      const [whole, fraction] = raw.split('.')
      const cents = Number(fraction.slice(0, 2).padEnd(2, '0'))
      let result = unit ? `${numberToWords(Number(whole))} ${unit}s` : numberToWords(Number(whole))
      if (cents) result += ` and ${numberToWords(cents)} cent${cents !== 1 ? 's' : ''}`
      return result
    }
    const value = Number(raw)
    return unit ? `${numberToWords(value)} ${unit}${value !== 1 ? 's' : ''}` : numberToWords(value)
  })
}

function expandTime(text: string): string {
  return text.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi, (_m, h: string, m: string, _s: string | undefined, suffix?: string) => {
    const hour = numberToWords(Number(h))
    const minutes = Number(m)
    const tail = suffix ? ` ${suffix.toLowerCase()}` : ''
    if (minutes === 0) return suffix ? `${hour}${tail}` : `${hour} hundred${tail}`
    return minutes < 10 ? `${hour} oh ${numberToWords(minutes)}${tail}` : `${hour} ${numberToWords(minutes)}${tail}`
  })
}

function expandFractions(text: string): string {
  return text.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (match, n: string, d: string) => {
    const numerator = Number(n)
    const denominator = Number(d)
    if (denominator === 0) return match
    let word: string
    if (denominator === 2) word = numerator === 1 ? 'half' : 'halves'
    else if (denominator === 4) word = numerator === 1 ? 'quarter' : 'quarters'
    else word = ordinalWords(denominator) + (numerator !== 1 ? 's' : '')
    return `${numberToWords(numerator)} ${word}`
  })
}

function expandDecades(text: string): string {
  return text.replace(/\b(\d{1,3})0s\b/g, (_m, base: string) => {
    const value = Number(base)
    const decade = DECADES[value % 10]
    return value < 10 ? decade : `${numberToWords(Math.floor(value / 10))} ${decade}`
  })
}

function expandPhoneNumbers(text: string): string {
  const join = (...groups: string[]): string => groups.map(digitsOf).join(' ')
  return text
    .replace(/(?<!\d-)(?<!\d)\b(\d{1,2})-(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, (_m, ...g: string[]) => join(g[0], g[1], g[2], g[3]))
    .replace(/(?<!\d-)(?<!\d)\b(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, (_m, ...g: string[]) => join(g[0], g[1], g[2]))
    .replace(/(?<!\d-)\b(\d{3})-(\d{4})\b(?!-\d)/g, (_m, ...g: string[]) => join(g[0], g[1]))
}

/** Spells out numbers and symbols so a model that reads letters can say them. */
export function spokenEnglish(input: string): string {
  let text = input.normalize('NFC')
  // Addresses before leading decimals (their dots precede digits), then bare `.5` becomes `0.5`.
  text = text.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (_m, ...g: string[]) => g.slice(0, 4).map(digitsOf).join(' dot '))
  text = text.replace(/(?<!\d)-\.(\d)/g, '-0.$1').replace(/(?<!\d)\.(\d)/g, '0.$1')
  text = expandCurrency(text)
  text = text.replace(new RegExp(String.raw`(-?${NUMBER})\s*%`, 'g'), (_m, n: string) => `${words(n)} percent`)
  text = text.replace(/(?<![a-zA-Z\d])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![a-zA-Z\d])/g, (_m, coefficient: string, exponent: string) => {
    const power = Number(exponent)
    return `${words(coefficient)} times ten to the ${power < 0 ? 'negative ' : ''}${numberToWords(Math.abs(power))}`
  })
  text = expandTime(text)
  text = text.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) => ordinalWords(Number(n)))
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*(km|kg|mg|ml|gb|mb|kb|tb|hz|khz|mhz|ghz|mph|kph|°[cCfF]|[cCfF]°|ms|ns|µs)\b/gi,
    (_m, n: string, unit: string) => `${words(String(Number(n)))} ${UNITS[unit.toLowerCase()] ?? unit}`
  )
  text = text.replace(/(?<![a-zA-Z])(\d+(?:\.\d+)?)\s*([KMBT])(?![a-zA-Z\d])/g, (_m, n: string, suffix: string) => `${words(n)} ${SCALE_WORDS[suffix]}`)
  text = expandFractions(text)
  text = expandDecades(text)
  text = expandPhoneNumbers(text)
  text = text.replace(/(?<!\w)(\d+)-(\d+)(?!\w)/g, (_m, lo: string, hi: string) => `${numberToWords(Number(lo))} to ${numberToWords(Number(hi))}`)
  text = text.replace(/\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g, '$1 $2')
  text = text.replace(new RegExp(String.raw`(?<![a-zA-Z])-?${NUMBER}`, 'g'), (match) => words(match))
  return text.replace(/\s+/g, ' ').trim()
}
