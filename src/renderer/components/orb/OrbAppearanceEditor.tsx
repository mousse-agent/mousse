import { useId, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw, Plus, X } from 'lucide-react'
import { LiquidGlassOrb } from './LiquidGlassOrb'
import { DEFAULT_ORB_APPEARANCE, ORB_PALETTES, normalizeOrbAppearance, orbPaletteName, selectOrbPalette, stepOrbPalette, type OrbAppearance } from './orbAppearance'
import './orb.css'

interface OrbAppearanceEditorProps {
  value?: unknown
  onChange: (appearance: OrbAppearance) => void
  name?: string
  description?: string
  readOnly?: boolean
  active?: boolean
}

/** Controlled identity half of the Agent Editor. The parent owns draft persistence. */
export function OrbAppearanceEditor({ value: input, onChange, name = 'Your agent', description = 'A little personality. A world of possibility.', readOnly = false, active = true }: OrbAppearanceEditorProps) {
  const value = normalizeOrbAppearance(input)
  const id = useId()
  function patch(next: Partial<OrbAppearance>) {
    if (!readOnly) onChange(normalizeOrbAppearance({ ...value, ...next }))
  }
  function cycle(direction: -1 | 1) {
    if (!readOnly) onChange(stepOrbPalette(value, direction))
  }
  function onPaletteKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    cycle(event.key === 'ArrowLeft' ? -1 : 1)
  }
  return (
    <section className="orb-identity" aria-label="Agent appearance">
      <div className="orb-identity__stage">
        <span className="orb-identity__eyebrow">Made to be yours</span>
        <div className="orb-identity__art"><LiquidGlassOrb appearance={value} active={active} /></div>
        <div className="orb-identity__copy">
          <h2>{name.trim() || 'Your agent'}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="orb-identity__controls">
        <div className="orb-palette" role="group" aria-label="Orb color palette" onKeyDown={onPaletteKey}>
          <button type="button" className="orb-arrow" aria-label="Previous orb palette" disabled={readOnly} onClick={() => cycle(-1)}><ChevronLeft size={18} /></button>
          <div className="orb-palette__name" aria-live="polite" aria-atomic="true"><span>{orbPaletteName(value)}</span><small>Color palette</small></div>
          <button type="button" className="orb-arrow" aria-label="Next orb palette" disabled={readOnly} onClick={() => cycle(1)}><ChevronRight size={18} /></button>
        </div>
        <div className="orb-swatches" role="group" aria-label="Choose an orb palette" onKeyDown={onPaletteKey}>
          {ORB_PALETTES.map((palette) => (
            <button key={palette.id} type="button" aria-label={palette.name} aria-pressed={value.palette === palette.id} title={palette.name}
              disabled={readOnly} onClick={() => onChange(selectOrbPalette(value, palette.id))}>
              <span style={{ background: 'conic-gradient(from 40deg, ' + [...palette.colors, palette.colors[0]].join(', ') + ')' }} />
            </button>
          ))}
        </div>
        <details className="orb-customize">
          <summary>Fine-tune appearance</summary>
          <fieldset disabled={readOnly}>
            <legend className="orb-sr-only">Orb appearance options</legend>
            <div className="orb-custom-colors">
              <span>Colors</span>
              <div className="orb-custom-colors__list">
                {value.colors.map((color, index) => (
                  <div className="orb-custom-color" key={index}>
                    <input type="color" value={color} aria-label={'Orb color ' + (index + 1)} onChange={(event) => {
                      const colors = [...value.colors]
                      colors[index] = event.target.value
                      patch({ palette: 'custom', colors })
                    }} />
                    {value.colors.length > 2 && <button type="button" aria-label={'Remove orb color ' + (index + 1)} onClick={() => patch({ palette: 'custom', colors: value.colors.filter((_, i) => i !== index) })}><X size={10} /></button>}
                  </div>
                ))}
                {value.colors.length < 4 && <button type="button" className="orb-add-color" aria-label="Add orb color" onClick={() => patch({ palette: 'custom', colors: [...value.colors, '#d8a4ff'] })}><Plus size={14} /></button>}
              </div>
            </div>
            {(['luminance', 'translucency', 'motion'] as const).map((key) => (
              <label className="orb-slider" key={key} htmlFor={id + key}>
                <span>{key === 'luminance' ? 'Luminance' : key === 'translucency' ? 'Translucency' : 'Motion'}<output htmlFor={id + key}>{Math.round(value[key] * 100)}%</output></span>
                <input id={id + key} type="range" min="0" max="100" step="1" value={Math.round(value[key] * 100)} onChange={(event) => patch({ [key]: Number(event.target.value) / 100 })} />
              </label>
            ))}
            <label className="orb-parallax"><input type="checkbox" checked={value.parallax} onChange={(event) => patch({ parallax: event.target.checked })} />Follow pointer gently</label>
            <p className="orb-customize__hint">Motion follows your system accessibility preference.</p>
            <button type="button" className="orb-reset" onClick={() => onChange(normalizeOrbAppearance(DEFAULT_ORB_APPEARANCE))}><RotateCcw size={12} />Reset appearance</button>
          </fieldset>
        </details>
      </div>
    </section>
  )
}
