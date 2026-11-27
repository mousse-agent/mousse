/**
 * A stand-in daemon for `oneShotPlaces.test.ts`: reserves a place and starts an agent in it through `places.ts`, then
 * stops dead at one launch boundary (blocking its thread, so nothing more happens) until the test kills it hard.
 *
 * Arguments: profile folder, boundary (`reserved`, `recorded`, `spawned` or `answered`), agent script, marker file
 * (written when the boundary is reached; `<marker>.place` holds the place id), and the agent's environment as JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { placesFs, reservePlace, spawnInPlace } from '../../src/mms/harness/oneShot/places'

const [profile, boundary, agent, marker, envJson] = process.argv.slice(2) as [string, string, string, string, string]

/** Reached the boundary: say so, then block until killed. */
function hold(): never {
  writeFileSync(marker, boundary)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  process.exit(1)
}

const place = reservePlace(profile, { route: 'test:crash', instanceId: 'crash-daemon' })
writeFileSync(`${marker}.place`, place.id)
if (boundary === 'reserved') hold()
if (boundary === 'recorded') {
  // Right after the record that names the tree is durable, before anything is spawned (POSIX: before `go`).
  const rename = placesFs.rename
  placesFs.rename = (from, to) => {
    rename(from, to)
    if ((JSON.parse(readFileSync(to, 'utf8')) as { state: string }).state === 'running') hold()
  }
}
const proc = spawnInPlace(place, { command: process.execPath, args: [agent], env: JSON.parse(envJson) as NodeJS.ProcessEnv, purpose: 'one-shot', instanceId: 'crash-daemon' })
if (boundary === 'spawned') hold()
proc.child.stdout.once('data', () => hold())
