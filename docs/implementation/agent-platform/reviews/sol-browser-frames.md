# Sol browser frames and open-shadow review

Reviewed integration base: `c41407f2451c02f7babd68b10bfd440178b388e9`  
Reviewed candidate: `14c6adbdbea542902fd07217f195c4609b77ef0d`  
Candidate merge: `00bc08e`  
Review fix: `3fddd12`

## Findings fixed

- **A fixture DNS override shipped in every managed Chromium launch.** The candidate always mapped `foo.test` to `127.0.0.1`. That changes real navigation and can defeat a hostname-based network policy by resolving an allowed test hostname to loopback. Default launches no longer contain the rule. A trusted host-only argument seam injects it for the isolated fixture, while profile-directory and remote-debugging overrides are rejected.
- **Frame offsets were applied before frame-local visibility checks.** A visible child element could disappear when the iframe's parent offset exceeded the child viewport dimensions. Visibility is now evaluated in the child viewport, then the surviving bounds are translated into the root viewport. The real OOPIF fixture places the frame at `margin-left: 600px` to exercise this case and still performs real fill, click, validation, and POST behavior.
- **`maxElements` multiplied across attached frames.** The root and every child independently received the caller's full allowance, so an attacker-controlled frame tree could exceed the declared observation bound. Root and child collections now share one clamped element budget and inspect at most 32 attached frames per observation. Exhaustion returns `truncated` and `frame-observation-truncated`; the real fixture asserts that `maxElements: 1` never returns more than one merged element.
- **Nested-frame parent metadata was not resolved from the frame tree.** `TargetInfo.parentFrameId` is not authoritative for every attached target. Offset calculation now refreshes frame and parent IDs from the owned root page's frame tree and rejects cycles before recursively accumulating offsets.
- **Frame navigation invalidated only the new frame ID.** The old frame ID is now invalidated before replacement, and the fixture reuses a valid pre-navigation child observation to prove it is rejected after navigation.
- **A missing element reference surfaced as `invalid_action`.** Plain `BrowserReferenceStore` stale-reference errors are now translated to the typed `stale_ref` worker error.

## Verification

The repository-managed Chrome for Testing binary was used against two loopback servers. The cross-site hostname mapping was injected only into that broker fixture. No live browser profile, account, provider, or network service was used.

```text
npx vitest run tests/platformBrowserWorker.observation.test.ts tests/platformBrowserWorker.lifecycle.test.ts -t "cross-origin frames|open shadow|fixture DNS" --maxWorkers=1 --reporter=verbose
  2 files, 3 passed, 8 skipped

npx vitest run tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.observation.test.ts tests/platformBrowserWorker.framing.test.ts tests/platformBrowserContracts.test.ts --maxWorkers=2 --reporter=dot
  5 files, 41 tests passed

npm run typecheck
  passed

npm run build:cli
  passed
```

The real B02 cases prove a flattened cross-origin iframe session, frame-local observation with root-viewport bounds, duplicate-label separation by opaque references, empty validation without a POST, fill and click with one server POST, navigation and detach invalidation, and open-shadow fill/click behavior.

## Remaining scope

- The real fixture contains one OOPIF level. Parent lookup and recursive offsets now handle nested attached frames defensively, but nested OOPIF action behavior is not qualified by an actual nested-origin fixture.
- A child-frame budget exhaustion is explicitly marked truncated but does not yet provide an opaque continuation across child frames. Callers can request a larger bounded page or refresh; complete paged traversal across many frames remains open.
- Cross-frame drag and OOPIF image-point targeting remain unsupported. Closed shadow roots remain inaccessible.
- Headed mode, packaged executable discovery/install behavior, Electron-attached mode, macOS, and Linux remain unqualified.
