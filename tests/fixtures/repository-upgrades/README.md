# Repository upgrade renderer fixture

I mount the production `ChatComposer`, `OrchestratorChat`, and `StorageSettings` components with controlled microphone, provider-send, and thread-inventory inputs. This exercises the renderer behavior without accessing a real microphone, saved task, or provider account.

Run from the repository root:

```sh
npx vite --config tests/fixtures/repository-upgrades/vite.config.ts
```

Open `http://127.0.0.1:5193/tests/fixtures/repository-upgrades/preview.html`. The fixture exposes `window.upgradeProbes` for controlled failures and observed calls.

I verified these scenarios in the collaborative browser preview:

- With `mediaMode='denied'`, Voice input shows microphone-permission feedback; Retry microphone invokes another request, and Dismiss clears the alert.
- With `mediaMode='missing'`, the feedback explains that a microphone is required. With `mediaMode='capture'`, recorder construction fails and the acquired track stops.
- With `mediaMode='success'`, recording starts; Stop recording stops the track and produces one removable attachment.
- With `mediaMode='pending'`, capture shows a pending state and disables Voice input. Calling `resolveMedia()` after unmount stops the late stream without creating a recorder or attachment.
- Calling `failRecorder()` during recording stops capture and shows feedback without creating an attachment. Unmounting while recording also stops the recorder and track, clears its interval, and creates no attachment.
- Storage no longer has trash rules: a thread is archived, then deleted for good from the sidebar's Archived section. The Storage trash scenarios that were listed here no longer apply.
- In the actual `OrchestratorChat`, `sendAcknowledged=true` with a failed provider result leaves the composer empty, keeps one user prompt in the transcript, clears loading, and displays the provider error. With `sendAcknowledged=false`, the rejected prompt returns to the composer and its optimistic transcript row disappears. The earlier accepted prompt remains. I observed exactly one request per click and no renderer errors. This verifies renderer behavior with controlled API responses; the separate Electron test verifies production transport.

The fixture counts active intervals as well as tracks, recorder stops, inventory calls, and concurrent inventory requests. I observed zero active intervals after either component unmounted.

I could not verify the hidden-document branch in the preview because its `document.hidden` getter was nonconfigurable. I also could not retrieve screenshots after reload because the preview snapshot tool failed; DOM inspection and interaction remained available. These are verification limits, not evidence of application failures.
