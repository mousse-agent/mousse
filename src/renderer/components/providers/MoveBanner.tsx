import type { MoveBanner } from '../../../shared/harness/move'
import './moveBanner.css'

/**
 * The persistent Move prompt of a retired entry: on its Providers card and
 * at the top of every chat that uses it. It stays until the entry moved, and says so in plain words.
 */
export function MoveBannerView({ banner, onMove }: { banner: MoveBanner; onMove: () => void }) {
  return (
    <div className="move-banner" role="status">
      <p className="move-banner-text">
        <strong>{banner.title}.</strong> {banner.detail}
      </p>
      <button type="button" className="settings-btn move-banner-action" onClick={onMove}>
        {banner.label}
      </button>
    </div>
  )
}
