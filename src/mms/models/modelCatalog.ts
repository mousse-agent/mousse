import { gateModelCatalog, parseModelCatalog, type ModelCatalog } from '../../shared/modelCatalog'
import { mousseVersion } from '../appVersion'
import { compareVersions } from '../harness/driver'
// Bundled into the daemon by esbuild and electron-vite (both inline JSON imports), so packaged
// builds read no file at run time.
import bundled from './models.json'

let read: ModelCatalog | undefined
/** The downloaded copy (`catalogDownload.ts`), once one is verified; one per installation. */
let downloaded: ModelCatalog | undefined
const listeners = new Set<() => void>()

/** The catalog every release ships, as read (not yet gated by version). */
export function bundledModelCatalog(): ModelCatalog {
  read ??= parseModelCatalog(bundled)
  return read
}

/** `catalog` with the routes this Mousse version does not handle yet (`minMousse`) removed. */
export function catalogForThisMousse(catalog: ModelCatalog): ModelCatalog {
  return gateModelCatalog(catalog, mousseVersion(), compareVersions)
}

/**
 * The catalog in use, as read (not yet gated by version): the downloaded copy when its revision is
 * higher than the bundled one's, else the bundled copy (it wins a tie).
 */
export function readModelCatalog(): ModelCatalog {
  const own = bundledModelCatalog()
  return downloaded && downloaded.revision > own.revision ? downloaded : own
}

/**
 * The model catalog this Mousse uses: the higher revision of the bundled and the downloaded copy,
 * gated for this version. One per installation, shared by every profile.
 */
export function modelCatalog(): ModelCatalog {
  return catalogForThisMousse(readModelCatalog())
}

/**
 * Sets the downloaded copy (undefined: none). Only `catalogDownload.ts` calls this, with a copy whose
 * signature it checked. Subscribers hear about it when the catalog in use changes.
 */
export function setDownloadedModelCatalog(catalog: ModelCatalog | undefined): void {
  const before = readModelCatalog()
  downloaded = catalog
  if (readModelCatalog() === before) return
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A failing subscriber must not stop the others or the download.
    }
  }
}

/** Calls `listener` each time the catalog in use changes (a newer revision was downloaded). */
export function onModelCatalogChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
