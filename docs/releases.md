# Releases and versions

How Mousse is versioned, how nightly and stable builds are made, and what gets a version of its own.

## Channels

| Channel | Made by | When | Published as |
|---|---|---|---|
| CI build | `ci.yml` | Every PR and every push to `master` | Nothing; it only checks that the app builds |
| Nightly | `nightly.yml` | Once a day at 20:47 UTC (02:17 IST), only when `master` has new commits | A GitHub prerelease, never marked latest |
| Stable | `release.yml` | When someone pushes a `vX.Y.Z` tag | A draft GitHub release, published by hand |

Both nightly and stable builds publish only when everything passes: typecheck, lint, build, the Windows-relevant tests, the full suite (`npm test`) on Linux, packaging on Windows and Linux, the packaged CLI reporting the right version, and the secret scan of the packaged apps. When anything fails, nothing is published and the last good build stays up. GitHub emails the person who last changed the workflow about the failed run.

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
3. When the workflow finishes, open the draft release. It has the installers, the CLIs, `SHA256SUMS-<version>.txt` and notes generated from the PR titles since the previous stable tag. Add the highlights, download the assets once and check them against the checksums (see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)), then publish.
4. Open a PR that bumps `package.json` to the next patch version: `npm version 0.1.3 --no-git-tag-version`.

Nightlies stop with an error while `master` still holds a version that is already tagged, so step 4 cannot be forgotten for long.

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
