import { gateModelCatalog, parseModelCatalog, type ModelCatalog } from '../../shared/modelCatalog'
import { mousseVersion } from '../appVersion'
import { compareVersions } from '../harness/driver'
// Bundled into the daemon by esbuild and electron-vite (both inline JSON imports), so packaged
// builds read no file at run time.
import bundled from './models.json'

let read: ModelCatalog | undefined

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
 * The model catalog this Mousse uses: the bundled copy, gated for this version. One per
 * installation, shared by every profile.
 */
export function modelCatalog(): ModelCatalog {
  return catalogForThisMousse(bundledModelCatalog())
}
