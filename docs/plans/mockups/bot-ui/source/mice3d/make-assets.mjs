// Turn baked mouse strips into the mockups' face assets: node make-assets.mjs <facesDir> <outDir>
// Writes bot-faces3d.css (one class per strip, frames played with steps()) and bot-faces3d.js (window.__botFaces).
import { readFileSync, writeFileSync } from 'node:fs'
const [dir, out] = process.argv.slice(2)
const index = JSON.parse(readFileSync(`${dir}/faces.json`, 'utf8'))
let css = `/* Bot faces: baked frames of the live 3D mice. Each feeling is a loop. */
.bf3 { display: block; flex-shrink: 0; background-repeat: no-repeat; background-position: 0 0; }
@keyframes bf3-play { from { background-position-x: 0%; } to { background-position-x: 100%; } }
@media (prefers-reduced-motion: reduce) { .bf3 { animation: none !important; } }
`
const meta = {}
for (const [id, f] of Object.entries(index.faces)) {
  const data = readFileSync(`${dir}/${id}.webp`).toString('base64')
  const anim = f.frames > 1 ? `animation: bf3-play ${f.secs.toFixed(2)}s steps(${f.frames}, jump-none) infinite; ` : ''
  css += `.bf3-${id} { background-image: url(data:image/webp;base64,${data}); background-size: ${f.frames * 100}% 100%; ${anim}}\n`
  meta[id] = { frames: f.frames, secs: f.secs, look: f.look, state: f.state }
}
writeFileSync(`${out}/bot-faces3d.css`, css)
writeFileSync(`${out}/bot-faces3d.js`, `// Bot faces for the mockups: face(id) places a baked strip (bot-faces3d.css) at a size, with its own phase.
(() => {
  const meta = ${JSON.stringify(meta)}
  const colours = ${JSON.stringify(index.colours)}
  const accs = ${JSON.stringify(index.accs)}
  let n = 0
  const face = (id, { size = 34, cls = '' } = {}) => {
    if (!meta[id]) throw new Error('no face ' + id)
    const delay = meta[id].frames > 1 ? \`;animation-delay:-\${((n++ * 0.731) % meta[id].secs).toFixed(2)}s\` : ''
    return \`<i class="bf3 bf3-\${id}\${cls ? ' ' + cls : ''}" style="width:\${size}px;height:\${size}px\${delay}" aria-hidden="true"></i>\`
  }
  window.__botFaces = { face, meta, colours, accs }
  return 'faces3d'
})()
`)
console.log('css', Math.round(css.length / 1024), 'KB,', Object.keys(meta).length, 'faces')
