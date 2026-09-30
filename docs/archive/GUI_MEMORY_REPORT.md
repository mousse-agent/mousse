# Mousse GUI idle-memory investigation

Date: 2026-08-05  
Platform measured: Windows 11 x64, Electron 43.2.0, Mousse 0.1.0

## Executive summary

Task Manager's approximately 800 MB figure is the sum of private/committed memory
for both the GUI and the separately hosted MMS daemon. It is not 800 MB of React or
CSS heap. The measured baseline was 795.3 MB private across seven Chromium
processes, but only 374.4 MB was resident working set at the same instant.

The biggest GUI lifecycle bug was that the Close button did not close Mousse. The
`close` event was cancelled and the window was hidden, retaining the renderer, GPU
process, network service, every mounted panel, and the tray. The fix makes Close
terminate the GUI client while leaving only the MMS daemon available for scheduled
jobs, channels, and agents.

Inactive heavy panels are now unmounted rather than hidden, and nested CSS
`backdrop-filter` layers no longer duplicate Windows' native acrylic compositor.

## Measurement method and limitations

Measurements used `Win32_Process` for parent/command-line classification and
`Get-Process` for `WorkingSet64` and `PrivateMemorySize64`, after a 20-second idle
settle. A second sample was taken after 60 seconds. `private` is the closest match
to the roughly 800 MB Task Manager total; working set is physical RAM resident at
that moment and changes substantially as Windows trims pages.

CSS features do not have independent heaps, so claims such as “this animation uses
12 MB” cannot be measured directly. Feature attribution below uses process
boundaries, source ownership, and before/after deltas. Values marked “part of” are
shared Chromium allocations and must not be added together.

## Baseline process breakdown

| Process/owner | Working set | Private memory | What it contains |
|---|---:|---:|---|
| MMS daemon main | 124.6 MB | 270.2 MB | Scheduler, providers, orchestration, thread state, Node/V8 |
| GUI main | 65.7 MB | 181.9 MB | Electron main, BrowserWindow, tray, IPC and presentation mirror |
| GUI GPU | 82.3 MB | 184.5 MB | Window compositor, native acrylic, CSS blur/render surfaces |
| GUI renderer | 69.7 MB | 109.8 MB | React, all six panels, DOM, xterm/webview host state |
| Daemon GPU/helper | 12.0 MB | 26.3 MB | Headless Electron platform overhead |
| Two network utilities | 20.1 MB | 22.6 MB | One utility per Electron root |
| **Total** | **374.4 MB** | **795.3 MB** | **Seven processes** |

## Feature-level findings

| GUI feature | Measured/estimated private cost | Finding | Fix/status |
|---|---:|---|---|
| Base Electron GUI (main + renderer + GPU + utility) | about 488 MB baseline | The dominant GUI cost is Chromium process infrastructure, not a single React component. | GUI now exits instead of hiding; further reductions require a lighter shell or more main-process lazy imports. |
| MMS daemon | about 307 MB baseline including helpers | Counted in the reported 800 MB even though it is not GUI rendering. It intentionally survives GUI exit for background work. | Retained for functionality. Lazy provider/MCP/channel imports are the next safe optimization. |
| Hidden heavy panels | part of the 109.8 MB renderer; controlled GUI delta contributes to roughly 55 MB total reduction | Agents, Browser, Terminal, Files, Git and Documents were all mounted. Hidden panels kept effects, xterm objects, file polling and potential webview guests alive. | `MainViewPanel` now mounts only the selected panel. Browser webviews and xterm React objects are disposed when their panel is left; durable daemon PTYs remain intact. |
| Browser webview | roughly 50–150 MB **per opened guest**, page-dependent | No webview guest process existed in the empty baseline, so it did not explain this particular 800 MB sample. Previously visited/persisted tabs can add a renderer process per site. | Browser panel unmount now destroys guests when inactive. Keep tabs as state and recreate on return. |
| Native Windows acrylic | part of the 184.5 MB GUI GPU reservation | One whole-window native acrylic surface is reasonable, but it was combined with many nested CSS backdrop filters. | Native acrylic remains to preserve appearance. |
| Nested CSS backdrop blur | GPU private fell by about 19 MB in the controlled build; shared with other compositor changes | `--glass-blur` was applied to many surfaces, creating overlapping off-screen compositor layers over native acrylic. | Acrylic keeps translucent colors but nested `backdrop-filter` is set to `none`; Windows performs the single window blur. |
| CSS transitions and idle animations | below process-level resolution while idle | Transitions allocate negligible persistent RAM. Infinite spinners/pulses cost compositing/CPU only while their loading/recording state is visible. They are not the primary idle-memory cause. | Existing `prefers-reduced-motion` rules cover expensive thinking effects. No blanket animation removal needed. |
| Shadows/gradients | below process-level resolution | Static shadows may create compositor layers but are not large JS/private allocations. | Keep; audit only if GPU traces show excessive layer promotion. |
| System tray | small, shared GUI-main allocation | Tray was needed only because Close hid the GUI. It also made the misleading background behavior possible. | Removed. Relaunch Mousse normally to reopen it. |
| Agents & Tasks secondary window | roughly one additional renderer (commonly 80–150 MB) when open | Not present in baseline, but opening it creates another BrowserWindow and preload. | Future: make this an overlay/panel in the primary renderer. |

## Before/after results

The controlled optimized build measured 723.6 MB private before the experimental
daemon-host change, versus 795.3 MB baseline: a reduction of 71.7 MB (9.0%) for
the full GUI+daemon process group. Normal run-to-run variation is expected because
V8 reserves address space lazily and the measurements include shared daemon state.

The GUI-owned portion fell from approximately 488 MB to approximately 434 MB
private (about 11%). More importantly, Close now releases that entire GUI-owned
portion instead of merely allowing Windows to trim its working set.

### Close behavior

| State | Before | After |
|---|---|---|
| GUI open | 7 processes | 7 processes with Electron-host daemon |
| GUI closed | 7 processes; window hidden | 3 daemon-only processes |
| GUI resources after close | Renderer, GUI GPU, GUI utility and main retained | All four GUI processes terminate |
| Background MMS | Retained | Retained intentionally |

The remaining daemon is expected to settle near the user's observed combined
working set of approximately 185 MB; working set varies with recently accessed
threads/providers. Its private reservation is higher than its resident RAM.

An `ELECTRON_RUN_AS_NODE` single-process daemon was also tested. It reduced the
daemon process count from three to one, but increased settled resident memory to
about 253 MB in this workload, so it was rejected and not shipped.

## Implemented changes

1. Removed the `close` handler that converted Close into Hide.
2. Removed the always-resident tray lifecycle.
3. Changed `MainViewPanel` from six `KeepMounted` panels to one active panel.
4. Removed nested CSS backdrop blur when native acrylic is active.
5. Preserved the standalone MMS daemon so scheduled jobs, connected channels,
   terminals and agents can continue after the GUI exits.

## Recommended follow-up work

1. **Lazy-load daemon providers and integrations.** `MousseMainService` eagerly
   imports provider SDKs, MCP, channel adapters and agent integrations. Load each
   only when configured/used. This is the largest remaining idle-memory target.
2. **Add memory telemetry.** Record `app.getAppMetrics()` plus renderer heap and
   webview guest counts in a debug-only diagnostics screen to make regressions
   reproducible.
3. **Unload inactive panels after a grace period if instant tab return is desired.**
   The current implementation unloads immediately for maximum memory recovery.
4. **Virtualize long chat histories.** The empty/normal idle baseline is fixed,
   but long conversations still scale with rendered message count.
5. **Replace the Agents & Tasks BrowserWindow with an in-window overlay.** This
   avoids a second renderer when that view is open.
6. **Offer an explicit “Stop background service on exit” preference.** Default it
   off so channels/schedules remain reliable; users who want zero Mousse processes
   can opt in.

## Phase 2: static-compositor and retention pass

After the initial report, the GUI was given a stricter target and compared with
T3 Code's renderer-memory work. T3 Code PR #5148 did **not** identify CSS as its
main renderer OOM cause: it collapsed redundant live context-window events and
reduced fully hydrated thread subscriptions from ten to three. Mousse had an
equivalent retention multiplier plus a much heavier visual compositor setup.

Changes made in this pass:

- Reduced cached, fully hydrated thread transcripts from 16 to 3.
- Mounted only the selected GUI agent chat. Previously every agent retained its
  full transcript, markdown/tool DOM, subscriptions and element measurements.
- Disabled native Windows acrylic.
- Forced solid renderer surfaces even when old settings request acrylic.
- Disabled all cosmetic CSS animations, transitions, backdrop filters, filters,
  shadows and `will-change` promotion in the production renderer.
- Disabled hardware acceleration for the GUI process only. The daemon path is
  unchanged.

### Phase 2 measurements

| Build | GUI private memory | Change from original GUI |
|---|---:|---:|
| Original | approximately 488 MB | baseline |
| Inactive panels + nested blur removal | approximately 388–434 MB | 11–20% lower |
| Static CSS + no acrylic + retention caps | approximately 388 MB before GPU change | about 20% lower |
| Static CSS + software compositing | **approximately 291 MB** | **about 197 MB / 40% lower** |

The remaining measured 291 MB is approximately 145 MB Electron main, 110 MB
renderer, 23 MB software GPU helper and 12 MB network utility. Tests with the GPU
and network service folded into the main process reached only 286 MB and increase
crash/security coupling, so that configuration was rejected. A 128 MB V8 old-space
cap also did not lower committed memory.

This establishes an Electron/Chromium floor near 285–295 MB private for this build.
Reaching 200 MB **private/committed** memory requires replacing or substantially
rearchitecting the Electron shell (for example Tauri/WebView2), not more CSS
removal. If “RAM” means resident working set, installed-build figures should be
measured separately because unpacked cold builds keep hundreds of megabytes of
recently paged code resident; private memory is the stable comparison used here.
