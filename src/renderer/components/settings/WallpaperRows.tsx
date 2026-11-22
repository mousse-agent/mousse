import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  WALLPAPER_DEFAULT_DIM,
  WALLPAPER_MAX_DIM,
  WALLPAPER_POSITIONS,
  type ThemeWallpaper,
  type WallpaperFit,
  type WallpaperPosition
} from '../../../shared/themes/userThemes'
import type { StoredWallpaperInfo } from '../../../shared/themes/wallpaperImage'
import { previewWallpaperDim, useWallpaperLayer, useWallpaperProblem } from '../../lib/wallpaper'
import { useAppStore } from '../../stores/appStore'
import { Select } from '../ui/Select'
import { SettingsRow } from './SettingsRow'

const FIT_LABELS: Record<WallpaperFit, string> = { cover: 'Fill', contain: 'Fit' }
const POSITION_LABELS: Record<WallpaperPosition, string> = {
  center: 'Center',
  top: 'Top',
  bottom: 'Bottom',
  left: 'Left',
  right: 'Right',
  'top left': 'Top left',
  'top right': 'Top right',
  'bottom left': 'Bottom left',
  'bottom right': 'Bottom right'
}

/** What the picker says when the daemon refuses a file; the full rule is in its tooltip. */
const REFUSED_SHORT = "Can't use that file."
const REFUSED_DETAIL = 'A PNG, JPEG or WebP on this computer, at most 32 MB, 16,384 pixels a side and 40 megapixels.'

/**
 * Opens the file dialog (in the main process, which hands the file to the daemon) and returns the stored image as a
 * theme wallpaper with `current`'s display settings, or null when cancelled. Rejects with a short message.
 */
export async function chooseWallpaper(current?: ThemeWallpaper): Promise<ThemeWallpaper | null> {
  const profileId = useAppStore.getState().profileId
  const bridge = (window as { mousse?: { wallpapers?: { choose(profileId: string): Promise<StoredWallpaperInfo | null> } } }).mousse?.wallpapers
  if (!bridge || !profileId) throw new Error('unsupported')
  let info: StoredWallpaperInfo | null
  try {
    info = await bridge.choose(profileId)
  } catch (error) {
    // A daemon from before wallpapers does not know the call.
    if (/method_not_allowed|not allowed/i.test(String((error as Error)?.message ?? error))) throw new Error('unsupported')
    throw new Error('refused')
  }
  if (!info) return null
  return { id: info.id, type: info.type, width: info.width, height: info.height, fit: current?.fit ?? 'cover', position: current?.position ?? 'center', dim: current?.dim ?? WALLPAPER_DEFAULT_DIM }
}

/** What a failed choose shows next to the button. */
function chooseError(error: unknown): { text: string; detail: string } {
  return (error as Error)?.message === 'unsupported'
    ? { text: 'Needs a newer Mousse service.', detail: 'Restart Mousse so its background service is updated, then choose again.' }
    : { text: REFUSED_SHORT, detail: REFUSED_DETAIL }
}

/** How long Settings stays aside after a key moves the dim slider. */
export const DIM_KEY_PEEK_MS = 700

/**
 * Settings steps aside (`html[data-settings-peek]`, app CSS) so the chat and its wallpaper show: while the dim slider is
 * dragged, and for a moment after a key moves it.
 */
function useSettingsPeek(): { hold(): void; brief(): void } {
  const timer = useRef<number | undefined>(undefined)
  const release = useRef<(() => void) | null>(null)
  const end = (): void => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    release.current?.()
    release.current = null
    document.documentElement.removeAttribute('data-settings-peek')
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- end reads only refs
  useEffect(() => end, [])
  return {
    hold: () => {
      end()
      document.documentElement.setAttribute('data-settings-peek', '')
      const events = ['pointerup', 'pointercancel', 'blur'] as const
      for (const name of events) window.addEventListener(name, end)
      release.current = () => { for (const name of events) window.removeEventListener(name, end) }
    },
    brief: () => {
      if (release.current) return
      window.clearTimeout(timer.current)
      document.documentElement.setAttribute('data-settings-peek', '')
      timer.current = window.setTimeout(end, DIM_KEY_PEEK_MS)
    }
  }
}

/** Keys that move a range input. */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

export interface WallpaperRowsProps {
  wallpaper: ThemeWallpaper | undefined
  onChange: (wallpaper: ThemeWallpaper | undefined) => void
}

/** The wallpaper of the theme being edited: choose or remove the image, and how it fills the chat. */
export function WallpaperRows({ wallpaper, onChange }: WallpaperRowsProps) {
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const layer = useWallpaperLayer()
  const problem = useWallpaperProblem()
  const choose = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await chooseWallpaper(wallpaper)
      setError(null)
      if (next) onChange(next)
    } catch (failure) {
      setError(chooseError(failure))
    } finally {
      setBusy(false)
    }
  }
  const peek = useSettingsPeek()
  // The least dim that keeps text readable over this image (the layer measures it); the slider does not go below it,
  // so it shows the dim really used and every move changes the look.
  const floor = layer && wallpaper ? Math.min(WALLPAPER_MAX_DIM, Math.max(0, Math.ceil(layer.floor * 100 - 1e-6))) : 0
  const dim = Math.max(floor, wallpaper?.dim ?? WALLPAPER_DEFAULT_DIM)
  const set = (patch: Partial<ThemeWallpaper>): void => { if (wallpaper) onChange({ ...wallpaper, ...patch }) }
  const setDim = (value: number): void => {
    const next = Math.max(floor, value)
    // Drawn now; the theme's own preview follows when the slider rests.
    previewWallpaperDim(next)
    if (next !== wallpaper?.dim) set({ dim: next })
  }
  return (
    <>
      <SettingsRow
        title="Wallpaper"
        anchor="appearance-wallpaper"
        description={error
          ? <span role="alert" className="user-theme-dropped" title={error.detail}>{error.text}</span>
          : problem && wallpaper
          ? <span role="alert" className="user-theme-dropped">{problem}</span>
          : wallpaper
          ? <span title="Mousse keeps its own copy, so the original file can move.">{wallpaper.width && wallpaper.height ? `${wallpaper.width} × ${wallpaper.height}` : 'Image'}</span>
          : <span title={`Behind the chat. ${REFUSED_DETAIL}`}>An image behind the chat.</span>}
        control={
          <div className="user-theme-wallpaper-actions">
            <button type="button" className="settings-btn" disabled={busy} onClick={() => void choose()}>{wallpaper ? 'Change…' : 'Choose…'}</button>
            {wallpaper && <button type="button" className="settings-btn" onClick={() => { setError(null); onChange(undefined) }}>Remove</button>}
          </div>
        }
      />
      {wallpaper && (
        <>
          <SettingsRow
            title="Wallpaper fit"
            control={
              <Select
                ariaLabel="Wallpaper fit"
                value={wallpaper.fit}
                onChange={(fit) => set({ fit: fit as WallpaperFit })}
                options={(['cover', 'contain'] as const).map((fit) => ({ value: fit, label: FIT_LABELS[fit] }))}
              />
            }
          />
          <SettingsRow
            title="Wallpaper position"
            control={
              <Select
                ariaLabel="Wallpaper position"
                value={wallpaper.position}
                onChange={(position) => set({ position: position as WallpaperPosition })}
                options={WALLPAPER_POSITIONS.map((position) => ({ value: position, label: POSITION_LABELS[position] }))}
              />
            }
          />
          <SettingsRow
            title="Wallpaper dim"
            htmlFor="wallpaper-dim"
            className="wallpaper-dim-row"
            description={floor > 0
              ? <span title="Text needs at least this much of the theme's background over this image (4.5:1 contrast).">At least {floor}% for readable text.</span>
              : <span title="How much of the theme's background covers the image.">Theme color over the image.</span>}
            control={
              <>
                <input
                  id="wallpaper-dim"
                  type="range"
                  className="acrylic-intensity-dial"
                  min={0}
                  max={WALLPAPER_MAX_DIM}
                  step={1}
                  value={dim}
                  style={{ '--fill': `${(dim / WALLPAPER_MAX_DIM) * 100}%`, '--floor': `${(floor / WALLPAPER_MAX_DIM) * 100}%` } as CSSProperties}
                  onPointerDown={() => peek.hold()}
                  onKeyDown={(event) => { if (SLIDER_KEYS.has(event.key)) peek.brief() }}
                  onChange={(event) => setDim(Number(event.currentTarget.value))}
                />
                <span className="acrylic-intensity-value">{dim}</span>
              </>
            }
          />
        </>
      )}
    </>
  )
}
