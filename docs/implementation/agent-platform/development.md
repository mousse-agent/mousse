# Parallel development runtime

Run `npm ci` independently in each worktree, then `npm run dev`. The development launcher defaults to `<worktree>/.mousse-dev/runtime`, separate Electron storage under that home, and a deterministic loopback renderer port from 5100 through 5999. Vite fails on a collision instead of silently switching ports. Set `MOUSSE_RENDERER_PORT` explicitly if two checkout hashes collide.

Explicit `MOUSSE_HOME`, `MOUSSE_ELECTRON_USER_DATA`, `MOUSSE_BROWSER_ROOT`, and `MOUSSE_ARTIFACT_ROOT` overrides are supported. Services must still receive injected paths; these variables configure process bootstrap and are not a profile-switch mechanism. A normal installed launch without overrides retains its existing Electron userData pending the profile migration work.

Example PowerShell:

~~~powershell
$env:MOUSSE_HOME = 'C:\mousse-fixtures\worker-a'
$env:MOUSSE_RENDERER_PORT = '5211'
npm run dev
~~~

Never point AI worker tests at the user's ordinary `.mousse` home or live browser cookies. Keep live channel delivery and paid model evaluations opt-in. `npm test` remains a Node-only deterministic test command; `npm run test:orb` exercises the real renderer separately without a browser download.

Foundation dependencies selected from the npm registry on September 11, 2026: `@xyflow/react` 12.11.6 (MIT, renderer graph canvas), `ajv` 8.20.0 (MIT, schema validation), `yaml` 2.9.0 (ISC, standards parser), `fflate` 0.8.3 (MIT, managed bundle archive handling). Pin exact versions in package/lock manifests. Archive decoders still require entry/path/expansion limits; the dependency alone does not establish safe import. Browser agent execution must use Mousse's own worker/executor, not a third-party agent package.
