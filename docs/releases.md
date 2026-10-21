# Releases and versions

How Mousse is versioned, how nightly and stable builds are made, and what gets a version of its own.

## Channels

| Channel | Made by | When | Published as |
|---|---|---|---|
| CI build | `ci.yml` | Every PR and every push to `master` | Nothing; it only checks that the app builds |
| Nightly | `nightly.yml` | Once a day at 20:47 UTC (02:17 IST), only when `master` has new commits | A GitHub prerelease, never marked latest |
| Stable | `release.yml` | When someone pushes a `vX.Y.Z` tag | A draft GitHub release, published by hand |

Both nightly and stable builds publish only when everything passes: typecheck, lint, build, the Windows-relevant tests, the full suite (`npm test`) on Linux, packaging on Windows and Linux, each packaged CLI reporting the right version, and a secret scan of the packaged app (on the Linux packages, which hold the same app code as Windows). In these builds a failed test gets two more tries, because a few timing-sensitive process tests occasionally fail on shared runners; a test that fails every try still blocks. When anything fails, nothing is published and the last good build stays up. GitHub emails the person who last changed the workflow about the failed run.

The nightly compares `master` with the commit of the newest nightly release. With no new commits it stops after that check. A failed nightly leaves no release, so the next night tries again. Run it by hand from the Actions tab (Nightly → Run workflow); tick **force** to build even without new commits.

The newest 10 nightlies are kept; older ones and their tags are deleted.

## The app version

- `package.json` holds the only version. The GUI (bottom of the Settings sidebar), `mousse-cli --version`, the daemon's `hello_ok.serverVersion`, provider client info and installer names all come from it.
- `master` always holds the **next** stable version. After `v0.1.2` ships, the next PR sets `0.1.3`.
- Nightlies are SemVer prereleases of that version: `0.1.2-nightly.20261022.17` is the nightly built on 22 October 2026 (UTC) by workflow run 17. It sorts before `0.1.2`, so a nightly never looks newer than the stable release it leads to. The release page names the commit.
- Windows file versions take only numbers, so a nightly installer's file version is `0.1.2.<run number>` and its product version is the full version.

Which number to bump, while Mousse is below 1.0:

- **Patch** (`0.1.x`): fixes and features that keep existing data, daemons and peers working.
- **Minor** (`0.x.0`): large features, or any change that bumps a contract version below in an incompatible way.

## Cutting a stable release

1. Make sure `package.json` on `master` holds the version you are releasing, for example `0.1.2`, and that a recent nightly of that commit passed.
2. Tag that commit and push the tag: `git tag v0.1.2 <commit> && git push origin v0.1.2`. The workflow refuses a tag that does not match `package.json` or is not on `master`.
3. When the workflow finishes, open the draft release. It has the installers (`Mousse.Setup.<version>.exe`, `Mousse-<version>.AppImage`), the CLIs, `SHA256SUMS-<version>.txt` and notes generated from the PR titles since the previous stable tag. Add the highlights, download the assets once and check them against the checksums (see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)), then publish.
4. Open a PR that bumps `package.json` to the next patch version: `npm version 0.1.3 --no-git-tag-version`.

Nightlies stop with an error while `master` still holds a version that is already tagged, so step 4 cannot be forgotten for long.

Installed builds see the new stable release only once its draft is published.

## In-app updates

Installed Mousse updates itself from these GitHub releases (`src/main/updates/`, built on `electron-updater`).

- **Channel.** A nightly build follows nightlies and a stable build follows stable releases. Settings → Updates switches channel; the choice is kept in `updates.json` in Electron's user data folder. Moving from a nightly to stable never installs an older build: it waits for a stable release newer than the running one, because an older build may not read data a newer one saved.
- **Checks.** The first check runs 15 s after the app starts, then every 30 minutes, and again when a window gains focus at least 10 minutes after the last check. Failed checks back off up to 2 hours without showing anything; a check started from Settings shows its error. Each check reads GitHub's release feed and one small manifest, with no GitHub API calls and no rate limit.
- **Download.** Nothing downloads until the user clicks Download in the update popover (the rail button that appears under Settings). After the first update, Windows downloads only the changed blocks listed in the installer's `.blockmap`. Downloads are checked against the manifest's SHA-512.
- **Install.** The user confirms; running agent turns are stopped and marked interrupted (the Run Engine does not resume them on its own). Mousse disconnects, stops the background service, runs the installer silently and opens the new version, which starts a new service. If the service does not stop within 30 s, or the installer cannot be started at all, the service comes back, the download stays, and the popover offers to try again. If Mousse has already started quitting, or the installer ran but the version did not change, the next launch says the update did not install and offers it again.
- **Not covered.** macOS (updates need a signed build), Linux builds not started from their AppImage, development builds, and the portable `mousse-cli-<version>-win-x64.exe` download. `MOUSSE_DISABLE_UPDATES=1` turns updates off.

Release files the updater reads, attached by `package.yml` and checked there:

| Release | Windows | Linux |
|---|---|---|
| Stable | `latest.yml`, `Mousse.Setup.<version>.exe(.blockmap)` | `latest-linux.yml`, `Mousse-<version>.AppImage` |
| Nightly | `nightly.yml`, same installer files | `nightly-linux.yml`, same AppImage |

To try the updater from a checkout, serve a folder with a `latest.yml` (or `nightly.yml`) and its installer over HTTP and start `npm run dev` with `MOUSSE_UPDATE_FEED_URL=http://127.0.0.1:<port>/`. On Windows, checking and downloading work in a development build; on Linux, downloading needs a real AppImage. Do not install from a development build.

## Contract versions, not component versions

The orchestrator, providers and channels are internal modules. They ship together in one build and nothing outside the app depends on them, so they have no versions of their own: the app version identifies all of them. A separate version per module would move in lockstep with the app version and say nothing new.

What does need its own version is anything **another build can see**: older or newer daemons, peers on Mousse Net, and data saved by an earlier release. These are the contract versions, listed in [`src/mms/contractVersions.ts`](../src/mms/contractVersions.ts) and printed by `mousse-cli --version --json`:

| Contract | Covers |
|---|---|
| `daemonProtocol`, `daemonOwnerLease` | Clients talking to the daemon, and the daemon's lease file |
| `netProtocol`, `netEnvelope` | Mousse Net between installations |
| `runDatabase` | The Run Engine database schema |
| `mousseConf`, `installation`, `profile` | Saved configuration and profile layout |
| `workflowFormat`, `agentDefinition` | Saved workflows and agent definitions |
| `resourceLifecycle`, `execution`, `browserWorker` | Contracts between the daemon and its helper processes |

Rules:

- Bump a contract version only when an older or newer build could misread the change. Adding an optional field usually does not need a bump; renaming or removing one does.
- `tests/contractVersions.test.ts` lists every value, so a bump fails that test until the list is updated in the same PR. Say what changed in the PR description.
- A release that bumps a contract version is a minor release, and its notes say what stops working across versions.
- A new provider or channel API that outside code implements, such as a plugin API, gets its own contract version when it exists.
