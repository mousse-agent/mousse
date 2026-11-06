// Bake mouse strips for the mockups: node bake.mjs <port> <mice.html> <jobs.json> <outDir>
// Reuses the live page's shader and Mouse class, steps time at a fixed rate with seeded randomness, and writes
// <outDir>/<id>.webp (a horizontal strip of frames) and <outDir>/faces.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [port, live, jobsFile, out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const src = readFileSync(live, 'utf8')
const shader = src.match(/<script id="fs" type="x-shader">([\s\S]*?)<\/script>/)[1]
const js = src.match(/<script>\n([\s\S]*?)const cv = \$\('gl'\)/)[1]
const compile = src.match(/(function compile \(\) \{[\s\S]*?\n\})/)[1]
const html = `<!doctype html><html><body><script id="fs" type="x-shader">${shader}</script><script>
let seed = 7; Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
${js}
const cv = document.createElement('canvas'), gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
${compile}
const U = compile()
// Loop lengths per feeling, matched to each feeling's own rhythm so the strip repeats cleanly.
const CYCLE = { idle: [6, 10], working: [3.8, 12], waiting: [3, 12], blocked: [4.5, 12], sleeping: [3.93, 8], happy: [3, 12] }
window.__bake = ({ colour, acc, state, px, view, still }) => {
  seed = 7; cv.width = cv.height = px
  const feel = ${JSON.stringify({ idle: 'idle', working: 'working', waiting: 'waiting', blocked: 'blocked', paused: 'sleeping', done: 'happy' })}[state] ?? state
  const m = new Mouse(document.createElement('div')); m.t0 = 3; m.set(feel, -2)
  const [secs, fps] = CYCLE[feel], n = still ? 1 : Math.round(secs * fps), head = view === 'head'
  for (let t = -2; t < 0; t += 1 / fps) m.frame(t, 1 / fps)
  const strip = document.createElement('canvas'); strip.width = px * n; strip.height = px
  const sx = strip.getContext('2d')
  const ak = ACC_COL[acc] || ['#000000', 0]
  for (let i = 0; i < n; i++) {
    const t = still ? 0.6 : i / fps, o = m.frame(t, 1 / fps)
    gl.viewport(0, 0, px, px); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform2f(U.uRes, px, px); gl.uniform2f(U.uOrg, 0, 0); gl.uniform3fv(U.uCol, hexRGB(COLOURS[colour]))
    gl.uniform4f(U.uB, o.hop, o.sq, o.roll, o.tail); gl.uniform4f(U.uH, o.yaw, o.pitch, o.hroll, o.earL); gl.uniform4f(U.uH2, o.earR, o.armL, o.armR, o.laptop)
    gl.uniform4f(U.uE, o.open, o.closed, o.arc, o.worried); gl.uniform4f(U.uE2, o.lookX, o.lookY, o.es, o.sweat)
    gl.uniform4f(U.uV, head ? 0.8 : 0.32, head ? 1.45 : 2.1, 2, px < 120 ? 1 : 0); gl.uniform1f(U.uAcc, acc); gl.uniform4f(U.uAC, ...hexRGB(ak[0]), ak[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    sx.drawImage(cv, i * px, 0)
    if (feel === 'sleeping') { const u = (t % 2.6) / 2.6; sx.globalAlpha = Math.sin(Math.PI * u) * 0.95; sx.fillStyle = '#cbbfff'; sx.font = \`700 \${Math.round(px * 0.16)}px sans-serif\`; sx.fillText('z', i * px + px * (0.78 + 0.05 * u), px * (0.24 - 0.08 * u)); sx.globalAlpha = 1 }
  }
  return { frames: n, secs: still ? 0 : n / fps, data: strip.toDataURL('image/png') }
}
window.__colours = COLOURS; window.__accs = ACCS
window.__ready = true
</script></body></html>`
writeFileSync('/tmp/mice-bake.html', html)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0; const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result?.value }
await send('Page.navigate', { url: 'file:///tmp/mice-bake.html' })
for (let i = 0; i < 60 && !(await ev('!!window.__ready').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 250))

const index = { colours: await ev('window.__colours'), accs: await ev('window.__accs'), faces: {} }
for (const job of JSON.parse(readFileSync(jobsFile, 'utf8'))) {
  const r = await ev(`window.__bake(${JSON.stringify(job)})`)
  const png = `/tmp/mice-bake-${job.id}.png`
  writeFileSync(png, Buffer.from(r.data.split(',')[1], 'base64'))
  execFileSync('magick', [png, '-quality', job.still ? '86' : '80', '-define', 'webp:alpha-quality=85', '-define', 'webp:method=6', `${out}/${job.id}.webp`])
  execFileSync('rm', ['-f', png])
  index.faces[job.id] = { frames: r.frames, secs: r.secs, px: job.px, look: { colour: job.colour, acc: job.acc }, state: job.state }
}
writeFileSync(`${out}/faces.json`, JSON.stringify(index, null, 1))
console.log('baked', Object.keys(index.faces).length)
ws.close()
