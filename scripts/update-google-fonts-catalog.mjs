#!/usr/bin/env node
// Regenerates src/shared/googleFontsCatalog.json: the Google Fonts families the
// font settings offer (sans serif, serif and monospace), most popular first.
// Each row is [family, category, upright weights]; category is s, r or m.
// Usage: node scripts/update-google-fonts-catalog.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CATEGORY = { 'Sans Serif': 's', Serif: 'r', Monospace: 'm' }
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared', 'googleFontsCatalog.json')

const response = await fetch('https://fonts.google.com/metadata/fonts')
if (!response.ok) throw new Error(`Google Fonts metadata: HTTP ${response.status}`)
const text = (await response.text()).replace(/^\)\]\}'\s*/, '')
const { familyMetadataList } = JSON.parse(text)

const rows = familyMetadataList
  .filter((family) => CATEGORY[family.category] && family.isOpenSource !== false && !family.isBrandFont)
  .sort((a, b) => a.popularity - b.popularity)
  .map((family) => {
    const weights = Object.keys(family.fonts)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((a, b) => a - b)
    return [family.family, CATEGORY[family.category], weights]
  })
  .filter((row) => row[2].length > 0)

writeFileSync(out, `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`)
console.log(`Wrote ${rows.length} families to ${out}`)
