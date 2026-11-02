import { gateModelCatalog, parseModelCatalog, type ModelCatalog } from '../../shared/modelCatalog'
import { mousseVersion } from '../appVersion'
import { compareVersions } from '../harness/driver'
// Bundled into the daemon by esbuild and electron-vite (both inline JSON imports), so packaged
// builds read no file at run time.
import bundled from './models.json'

/** The catalog every release ships, as read (not yet gated by version). */
export function bundledModelCatalog(): ModelCatalog {
  return parseModelCatalog(bundled)
}

let cached: { version: string; catalog: ModelCatalog } | undefined

/**
 * The model catalog this Mousse uses: the bundled copy, with the routes this version does not
 * handle yet (`minMousse`) removed. One per installation, shared by every profile.
 */
export function modelCatalog(): ModelCatalog {
  const version = mousseVersion()
  if (cached?.version !== version) cached = { version, catalog: gateModelCatalog(bundledModelCatalog(), version, compareVersions) }
  return cached.catalog
}
