# Repository upgrade renderer fixture

I mount the production `ChatComposer`, `OrchestratorChat`, and `StorageSettings` components with controlled microphone, provider-send, and thread-inventory inputs. This exercises the renderer behavior without accessing a real microphone, saved task, or provider account.

Run from the repository root:

```sh
npx vite --config tests/fixtures/repository-upgrades/vite.config.ts
```

Open `http://127.0.0.1:5193/tests/fixtures/repository-upgrades/preview.html`. The fixture exposes `window.upgradeProbes` for controlled failures and observed calls.

I verified these scenarios through the T3 collaborative preview:

- With `mediaMode='denied'`, Voice input shows microphone-permission feedback; Retry microphone invokes another request, and Dismiss clears the alert.
- With `mediaMode='missing'`, the feedback explains that a microphone is required. With `mediaMode='capture'`, recorder construction fails and the acquired track stops.
- With `mediaMode='success'`, recording starts; Stop recording stops the track and produces one removable attachment.
- With `mediaMode='pending'`, capture shows a pending state and disables Voice input. Calling `resolveMedia()` after unmount stops the late stream without creating a recorder or attachment.
- Calling `failRecorder()` during recording stops capture and shows feedback without creating an attachment. Unmounting while recording also stops the recorder and track, clears its interval, and creates no attachment.
- In Storage, a dirty grace-period input survives Move to trash and inventory refresh. Setting `state='active'` externally changes the displayed row at the next five-second refresh. Setting `savedGraceDays` externally does not overwrite the dirty draft. Save trash policy persists that draft.
- Trash eligibility uses the saved policy, and the display retains blocker messaging. Delayed inventory calls plus repeated `visibilitychange` events never overlap (`inventoryMaxActive=1`). Unmount removes the timer/listener and prevents further inventory calls.
- A plain classified Storage action error displays its audited locked-resource message while preserving dirty grace days `47`, saved policy `30`, and the active row through the post-error inventory refresh. Set `actionFailure` to a public error descriptor to reproduce this transport-shaped input.
- In the actual `OrchestratorChat`, `sendAcknowledged=true` with a failed provider result leaves the composer empty, keeps one user prompt in the transcript, clears loading, and displays the provider error. With `sendAcknowledged=false`, the rejected prompt returns to the composer and its optimistic transcript row disappears. The earlier accepted prompt remains. I observed exactly one request per click and no renderer errors. This verifies renderer behavior with controlled API responses; the separate Electron test verifies production transport.

The fixture counts active intervals as well as tracks, recorder stops, inventory calls, and concurrent inventory requests. I observed zero active intervals after either component unmounted.

I could not verify the hidden-document branch in the T3 preview because its `document.hidden` getter was nonconfigurable. I also could not retrieve screenshots after reload because the preview snapshot tool failed; DOM inspection and interaction remained available. These are verification limits, not evidence of application failures.
