import { useId } from 'react'
import '../styles/incognito.css'

// Sunglasses for the Mousse logo, drawn in the logo's own 514-unit space so they sit over its eyes
// (mousse_logo_icon_outline.svg: eyes at x 200-313, y 262-324, face centre x 256.5).
// The right half is the left half mirrored about the face's centre.
const LENS = 'M166 256H248Q252 256 251.5 260L247 299C244.5 320 230 332 211 332H203C184 332 169.5 320 167 299L162.5 260Q162 256 166 256Z'
const ARM = 'M161 262L117 253'
const BROW = 'M158 259H355'
const MIRROR = 'matrix(-1 0 0 1 513 0)'
// A small fixed reflection on each lens, the same way up on both.
const GLINT = 'M236 267L226 285'
// The moving glint: a wide and a thin diagonal stripe, left of the lenses until they sweep across.
const SHINE_WIDE = 'M110 248H134L104 342H80Z'
const SHINE_THIN = 'M144 248H153L123 342H114Z'

function Frame() {
  return (
    <>
      <path d={ARM} className="incognito-glasses-line" />
      <path d={ARM} className="incognito-glasses-line" transform={MIRROR} />
      <path d={LENS} className="incognito-glasses-lens" />
      <path d={LENS} className="incognito-glasses-lens" transform={MIRROR} />
      <path d={BROW} className="incognito-glasses-line incognito-glasses-brow" />
    </>
  )
}

/** Sunglasses laid over the logo while a thread is private. They slide down into place when `on` turns true. */
export function IncognitoGlasses({ on }: { on: boolean }) {
  const clipId = `incognito-lenses-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg className="incognito-glasses" data-on={on || undefined} viewBox="0 0 514 514" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <path d={LENS} />
          <path d={LENS} transform={MIRROR} />
        </clipPath>
      </defs>
      <Frame />
      <g clipPath={`url(#${clipId})`}>
        <path d={GLINT} className="incognito-glasses-glint" />
        <path d={GLINT} className="incognito-glasses-glint" transform="translate(99 0)" />
        <g className="incognito-glasses-shine">
          <path d={SHINE_WIDE} />
          <path d={SHINE_THIN} />
        </g>
      </g>
    </svg>
  )
}

/** The same sunglasses as a small inline icon, for a private thread's header. */
export function SunglassesIcon({ width = 22 }: { width?: number }) {
  return (
    <svg className="incognito-icon" viewBox="104 238 305 104" width={width} height={Math.round((width * 104) / 305)} fill="none" aria-hidden="true">
      <Frame />
    </svg>
  )
}
