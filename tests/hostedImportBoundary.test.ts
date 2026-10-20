import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const src = join(root, 'src')
const hosted = join(src, 'mms', 'net', 'plus') + sep
/** The only places outside the Mousse ID folder that may name it. */
const allowed = new Set(['src/mms/MmsProfileServices.ts'])

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) yield path
  }
}

const specifiers = (text: string): string[] =>
  [
    ...text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  ].map((match) => match[1])

it('keeps Mousse ID code out of core: only its folder and the composition root import it', () => {
  const offenders: string[] = []
  for (const file of sources(src)) {
    if (file.startsWith(hosted)) continue
    const name = relative(root, file).split(sep).join('/')
    if (allowed.has(name)) continue
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      if (target + sep === hosted || target.startsWith(hosted)) offenders.push(`${name} -> ${specifier}`)
    }
  }
  expect(offenders).toEqual([])
})

it('finds the composition root import, so the scan is not vacuous', () => {
  const text = readFileSync(join(src, 'mms', 'MmsProfileServices.ts'), 'utf8')
  expect(specifiers(text)).toContain('./net/plus')
})
