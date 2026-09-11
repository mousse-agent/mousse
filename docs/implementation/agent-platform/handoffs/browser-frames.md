# Browser frame and open shadow handoff

This follow-up extends the B03 managed Chromium worker with actual cross-origin iframe/OOPIF and open shadow-root routing. The worker remains Electron free and keeps CDP sessions, backend node IDs, and frame target IDs private.

The session attaches iframe targets by enabling flattened `Target.setAutoAttach` on both the browser connection and the owned page session. Each attached frame is tracked by target/session/frame ID and parent frame ID. Observations collect the root and attached frame sessions, merge accessible elements into one bounded observation, and translate frame-local bounds through `DOM.getFrameOwner`/`DOM.getContentQuads`. Reference records retain their owning CDP session and frame ID; actions route `DOM`, `Runtime`, focus, keyboard, mouse, fill, and click commands to that owning session. Detached targets and changed child loader IDs invalidate the frame references. Nested parent offsets are accumulated for attached child frames.

Open shadow content is collected through Chromium accessibility/DOM snapshot nodes. Actionability hit testing uses the owning shadow root when present, so overlay checks work for open shadow controls. Closed shadow internals remain inaccessible and are not claimed.

Capability report changes:

- `capabilities.oopif: 'supported'`
- `capabilities.openShadowDom: true`
- `capabilities.closedShadowDom: 'unsupported'`

The real loopback fixture uses two origins (`127.0.0.1` and `foo.test` mapped to loopback) with `--site-per-process`. The test proves an attached iframe target/session, duplicate parent/frame labels, frame-local fill and click, an empty-form validation error, server-side POST result, frame navigation and removal, stale reference rejection, and open-shadow fill/click result. It does not expose raw target/session IDs to the renderer or model.

Evidence:

```text
npx vitest run tests/platformBrowserWorker.observation.test.ts -t "cross-origin frames|open shadow" --maxWorkers=1 --reporter=dot
  2 tests passed
```

The full browser suite, typecheck, and CLI build remain required after this follow-up. OOPIF qualification is for managed Chrome for Testing on the current Windows platform; Electron-attached mode, packaged installers, Linux, and macOS remain unqualified. Cross-frame drag and image-point targeting across OOPIF boundaries remain unsupported; semantic refs route correctly.
