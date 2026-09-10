import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OrbAppearanceEditor } from '../../../src/renderer/components/orb/OrbAppearanceEditor'
import { LiquidGlassOrb } from '../../../src/renderer/components/orb/LiquidGlassOrb'
import { DEFAULT_ORB_APPEARANCE, ORB_PALETTES, normalizeOrbAppearance, type OrbAppearance } from '../../../src/renderer/components/orb/orbAppearance'

const style = document.createElement('style')
style.textContent = `
  * { box-sizing: border-box; } body { margin: 0; background: #101216; color: #eff0f6; font-family: 'Segoe UI', sans-serif; --bg-secondary: #1a1d24; --border: #ffffff14; --text-primary: #eff0f6; --text-secondary: #9298a5; --accent: #b5c9fa; }
  button, input, textarea { font: inherit; }
  header { height: 66px; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); font-size: 13px; }
  header span { color: #9298a5; margin-right: 24px; } header strong { font-weight: 500; } header button { border: 1px solid var(--border); background: #1f242f; color: #e1e8fa; border-radius: 7px; padding: 7px 14px; font-size: 12px; }
  main { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 66px); } .settings { padding: 38px 44px; border-left: 1px solid var(--border); overflow-y: auto; } .settings h1 { margin: 0 0 9px; font-size: 23px; font-weight: 500; letter-spacing: -.04em; } .settings p { color: #9298a5; font-size: 12px; line-height: 1.8; margin-bottom: 30px; }
  .field { display: grid; gap: 10px; font-size: 12px; margin: 22px 0; } .field input, textarea { border: 1px solid var(--border); background: #16191f; color: #dae0eb; border-radius: 8px; padding: 12px; width: 100%; outline: none; } textarea { height: 160px; resize: vertical; line-height: 1.7; font-size: 12px; } .field small { color: #9298a5; } .section-label { font-size: 10px; color: #9298a5; text-transform: uppercase; letter-spacing: .13em; margin: 32px 0 18px; } .row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 15px 0; border-bottom: 1px solid var(--border); } .row span { color: #9298a5; } .thumbs { display: flex; gap: 22px; margin-top: 30px; }
  body[data-light=true] { background: #f3f4f7; color: #222733; --bg-secondary: #fff; --border: #15233a25; --text-primary: #222733; --text-secondary: #596174; --accent: #365abd; } body[data-light=true] header, body[data-light=true] .settings { color: #222733; }
  @media(max-width:1099px) { main { display: block; overflow-y: auto; } .settings { border-left: 0; border-top: 1px solid var(--border); overflow: visible; padding: 24px; } }
`
document.head.appendChild(style)

function Preview() {
  const [appearance, setAppearance] = useState<OrbAppearance>(normalizeOrbAppearance(DEFAULT_ORB_APPEARANCE))
  const [name, setName] = useState('Research companion')
  return <><header><div><span>Agents /</span><strong>New agent</strong></div><button onClick={() => { document.body.dataset.light = String(document.body.dataset.light !== 'true') }}>Toggle theme</button></header>
    <main><OrbAppearanceEditor value={appearance} onChange={setAppearance} name={name} description="Find the connections. Follow your curiosity." />
      <section className="settings"><h1>A mind of its own.</h1><p>Give your agent a purpose, a voice, and the tools to get there.</p>
        <label className="field">Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field">Purpose<input defaultValue="Thoughtful research, clearly explained." /></label>
        <div className="section-label">How your agent thinks</div>
        <div className="row">Model<span>Choose a model</span></div>
        <label className="field">System prompt <textarea defaultValue={'# Research companion\n\nExplore the question carefully. Compare primary sources,\nmake uncertainty visible, and connect the findings.'} /><small>Source / Preview is supplied by the shared Markdown editor.</small></label>
        <div className="section-label">Tools & knowledge</div>
        <div className="row">Skills<span>Choose skills</span></div><div className="row">MCP tools<span>Choose connections</span></div><div className="row">Browser<span>Ask before using</span></div>
        <div className="thumbs">{ORB_PALETTES.map((palette) => <LiquidGlassOrb key={palette.id} compact appearance={{ palette: palette.id }} label={palette.name + ' thumbnail'} />)}</div>
        <output id="appearance-value" hidden>{JSON.stringify(appearance)}</output>
      </section>
    </main></>
}
createRoot(document.getElementById('root')!).render(<Preview />)
