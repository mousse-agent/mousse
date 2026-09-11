# Browser artifact ownership and observation import

Root adds `BrowserArtifactService` over the reviewed shared `FileArtifactStore` (`4f2cde8`). This is a profile-owned service, constructed and synchronously drained by `MmsProfilePlatform`. It records exact profile/thread/run/session ownership in a bounded index before publishing a reference. Reads require that exact scope before opening the shared blob; source worker paths and native handles never appear in the public reference.

The worker screenshot importer accepts only the fixed `workerArtifactRoot/profileId/sessionId/art_UUID.png` source under the injected profile root. It reads a bounded regular file, checks the PNG signature/IHDR dimensions against the observation, imports it into the common artifact store, and replaces the worker ID with the published artifact ID. Simultaneous imports of one source share an operation. Cached imports reject changed dimensions or a smaller byte budget. The importer does not copy a user's external browser/profile data.

`BrowserSessionManager` now offers a host observation decorator after session ownership and returned-session identity checks. Open, observe, wait, agent action, and human action pass observations through that hook. If a screenshot cannot be imported, structure remains available with an explicit warning and no screenshot. This preserves a previously dispatched action's actual outcome. `BrowserViewerService` supplies the selected session ID to its artifact resolver and rejects an observation from another session.

Production wiring still required: construct browser sessions with `platform.browserArtifacts.decorateObservation`, provide the same owned staging root to managed/attached executors, and resolve/read references through an authenticated viewer/domain using the session manager's admitted ownership. A `BrowserArtifactScope` supplied to this service is a **trusted host input**, not an authorization token that may be deserialized directly from renderer/model claims. No browser RPC or preload API is enabled by this commit.

Evidence:

- 43 combined tests passed across browser artifact service, reviewed backend routing, native Agent Editor framed production, profile drain, and shared artifact ownership.
- 11 browser artifact/viewer tests passed, including actual managed Chromium capture → shared store import → viewer metadata → exact PNG byte/dimension verification → denied wrong-session read, plus a constrained budget retaining semantic observations without a screenshot.
- Both TypeScript projects and the full app/CLI build passed.
- An initial combined run found that the native `ask_user` deadline fixture could expire before reaching the question. The fixture now observes the question first, uses a realistic setup allowance, accepts both valid deadline/cancel classifications, and proves an unrelated thread question survives. The original failing run was not counted as passing evidence.

Limits: this is not final in-app BrowserPanel acceptance, a complete browser owner drain, aggregate artifact retention/quota enforcement, or a portable hostile-filesystem race guarantee. The managed broker/worker lifecycle is separately being hardened by Grok. The Electron-attached executor and targeted command transport are separate parallel packages. Only per-call artifact bounds and exact recorded ownership are established here; callers still enforce broader execution budgets and choose authorized sessions.
