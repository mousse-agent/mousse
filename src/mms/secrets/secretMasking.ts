import { MIN_SECRET_VALUE_LENGTH, secretMask } from '../../shared/secretRequests'

/** The forms a value can take in text: as typed, inside JSON, base64 (padded or not), URL-encoded and hex. Longest first. */
export function secretForms(value: string): string[] {
  const forms = new Set<string>([value])
  forms.add(JSON.stringify(value).slice(1, -1))
  const base64 = Buffer.from(value, 'utf8').toString('base64')
  forms.add(base64)
  forms.add(base64.replace(/=+$/, ''))
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_')
  forms.add(base64url)
  forms.add(base64url.replace(/=+$/, ''))
  forms.add(encodeURIComponent(value))
  forms.add(encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()))
  forms.add(Buffer.from(value, 'utf8').toString('hex'))
  forms.add(Buffer.from(value, 'utf8').toString('hex').toUpperCase())
  return [...forms]
    .filter((form) => form.length >= MIN_SECRET_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length)
}

export type SecretMasker = (text: string) => string

/** The shortest line of a multiline secret masked on its own; shorter lines (a PEM's last row, `-----`) are too common. */
export const MIN_SECRET_LINE_LENGTH = 8

/** `text` as it reads inside a JSON string. */
const jsonEscaped = (text: string): string => JSON.stringify(text).slice(1, -1)

/**
 * Each substantial line of a multiline secret (a private key, a service account file): a file-reading tool that numbers
 * its lines splits the whole value, so each line is masked on its own as well. A line with quotes or backslashes (a JSON
 * key file) reads differently once it is inside a JSON string, and again inside one nested in another (a tool result
 * saved in a provider's history), so those forms are masked too.
 */
function secretLines(value: string): string[] {
  const lines = value.split(/\r?\n/)
  if (lines.length < 2) return []
  const out = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length < MIN_SECRET_LINE_LENGTH) continue
    const once = jsonEscaped(line)
    out.add(line).add(once).add(jsonEscaped(once))
  }
  return [...out]
}

/** Match character by character: encoders may escape any subset, not just the whole value.
 * Unicode escape tokens cover UTF-16 surrogate pairs too. Include two enclosing JSON strings for stored tool history, plus the container used by maskedCopy’s quick check.
 */
function jsonEchoPatterns(value: string): RegExp[] {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [0, 1, 2, 3].map(
    (depth) =>
      new RegExp(
        Array.from(value)
          .map((char) => {
            // Each JSON layer is consistent across the value. Tokens have distinct prefixes, including for
            // backslashes, so near-matching responses cannot trigger exponential regex backtracking.
            const forms = new Set([jsonEscaped(char)])
            if (!/[\"\\\x00-\x1f]/.test(char)) forms.add(char)
            if (char === '/') forms.add('\\/')
            let layers = forms
            for (let n = 0; n < depth; n++) {
              layers = new Set([...layers].flatMap(form => {
                const outer = jsonEscaped(form)
                return [outer, outer.replaceAll('/', '\\/')]
              }))
            }
            const alternatives = [...layers].map(literal)
            alternatives.push(
              char
                .split('')
                .map((unit) => {
                  const hex = unit
                    .charCodeAt(0)
                    .toString(16)
                    .padStart(4, '0')
                    .replace(/[a-f]/g, (h) => `[${h}${h.toUpperCase()}]`)
                  return literal('\\'.repeat(2 ** depth) + 'u') + hex
                })
                .join('')
            )
            return `(?:${alternatives.join('|')})`
          })
          .join(''),
        'g'
      )
  )
}

/** Percent escapes may cover any subset of bytes, including unreserved characters such as ~. */
function percentEchoPattern(value: string): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(Array.from(value).map(char => {
    const encoded = [...Buffer.from(char)].map(byte => '%' + byte.toString(16).padStart(2, '0').replace(/[a-f]/g, h => `[${h}${h.toUpperCase()}]`)).join('')
    return `(?:${literal(char)}|${encoded})`
  }).join(''), 'g')
}

/** A function that replaces every form of the given secrets in a text with `[secret NAME hidden]`; undefined when there is none. */
export function secretMasker(
  secrets: ReadonlyArray<{ name: string; value: string }>
): SecretMasker | undefined {
  const pairs = secrets.flatMap(({ name, value }) =>
    [...secretForms(value), ...secretLines(value)].map((form) => ({ form, mask: secretMask(name) }))
  )
  if (pairs.length === 0) return undefined
  pairs.sort((a, b) => b.form.length - a.form.length)
  const echoes = secrets.flatMap(({ name, value }) =>
    [value, ...secretLines(value)]
      .filter((form) => form.length >= MIN_SECRET_VALUE_LENGTH)
      .flatMap((form) =>
        [...jsonEchoPatterns(form), percentEchoPattern(form)].map((pattern) => ({ pattern, mask: secretMask(name) }))
      )
  )
  return (text) => {
    let out = text
    for (const { pattern, mask } of echoes) out = out.replace(pattern, () => mask)
    for (const { form, mask } of pairs) {
      if (out.includes(form)) out = out.split(form).join(mask)
    }
    return out
  }
}

/**
 * Masks every string inside `value` in place (objects and arrays keep their identity, so code that holds a part of a
 * message keeps writing to the same part). Returns whether anything changed. Strings at the top level cannot change in
 * place: use the masker on them directly.
 */
export function maskInPlace(value: unknown, mask: SecretMasker, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 64) return false
  let changed = false
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index]
      if (typeof item === 'string') {
        const next = mask(item)
        if (next !== item) {
          value[index] = next
          changed = true
        }
      } else if (maskInPlace(item, mask, depth + 1)) changed = true
    }
    return changed
  }
  if (Object.isFrozen(value)) return false
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const item = record[key]
    if (typeof item === 'string') {
      const next = mask(item)
      if (next !== item) {
        record[key] = next
        changed = true
      }
    } else if (maskInPlace(item, mask, depth + 1)) changed = true
  }
  return changed
}

/** A masked copy of any JSON value (for data that must not be changed in place, such as a provider's native history). */
export function maskedCopy<T>(value: T, mask: SecretMasker): T {
  if (value === undefined || value === null) return value
  const text = JSON.stringify(value)
  if (text === undefined) return value
  // Cheap check on the whole text first; a match copies the value and masks it string by string, so JSON punctuation
  // inside a value can never change the copy's shape.
  if (mask(text) === text) return value
  const copy = JSON.parse(text) as T
  maskInPlace(copy, mask)
  return copy
}

/**
 * A command's output masked for the thread: every form of its secrets, and the value of every `Authorization` header or
 * field, which can hold a secret in a form no list of encodings covers (HTTP Basic is base64 of `user:password`).
 */
export function maskCommandOutput(text: string, mask: SecretMasker): string {
  return mask(text).replace(
    /((?:^|[\s"'{,])(?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:basic|bearer|token|digest)\s+)?[^"'\r\n,}]+/gim,
    (_match, head: string, scheme?: string) => `${head}${scheme ?? ''}[hidden]`
  )
}
