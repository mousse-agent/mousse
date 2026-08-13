# Mousse deployment guide

This guide records the reproducible release path and every deployment item that
still needs an external platform or owner action. It intentionally contains no
credentials, approval codes, signing material, or machine-specific API keys.

## Release invariants

1. Build release assets from the exact public Git commit targeted by the GitHub
   release tag. Never publish a binary whose source is only in an unpushed
   working tree.
2. Use Node 22.19.0 or newer, as required by `package.json`.
3. Build Windows and Linux in separate clean worktrees. Native `node-pty`
   modules are platform- and Electron-ABI-specific; never share `node_modules`
   between Windows and WSL.
4. Produce unsigned artifacts. Code signing is a later SignPath Foundation
   workflow and must not be simulated with a personal certificate.
5. Do not package `.mousse/`, `.mousse-worktrees/`, `.env*`, logs, build
   scratch directories, provider credential stores, or the daemon owner token.
6. Inspect the final packaged archive, not only the source tree, before upload.

## Windows unsigned build

From a clean Windows worktree at the release commit:

```powershell
npm ci
npm run typecheck
npm test
npm run dist:win
```

Expected GUI artifact: `release/Mousse Setup <version>.exe`.  
Expected CLI artifact: `release/cli/mousse-cli-<version>-win-x64.exe`.

If `electron-builder` reports that `node_modules/electron/dist` is absent, run
`node node_modules/electron/install.js` once and rerun the two builder commands.
This downloads the exact Electron version pinned in the lockfile; it does not
change application source.

## Linux unsigned build with WSL 2

Use a Linux-only clean worktree. Keeping the worktree outside another Git
working tree avoids npm resolving a parent Windows installation.

```bash
nvm use 22.19.0
npm ci
npm run typecheck
npm test
npm run dist:linux
```

Expected GUI artifact: `release/Mousse-<version>.AppImage`.  
Expected CLI artifact: `release/cli/mousse-cli-<version>-linux-x86_64.AppImage`.

The current verified WSL distribution is AlmaLinuxOS 9 on WSL 2. AppImage
creation is headless and does not require a desktop session.

## Secret and package-content gate

Before upload:

1. Run a secret scanner against `git archive <release-commit>` and the Git
   history. The release process used Secretlint's recommended preset plus
   explicit private-key, GitHub-token, OpenAI-key, and generic credential
   patterns.
2. Extract or list `resources/app.asar` in both GUI packages and inspect all
   application files for the same patterns.
3. Search unpacked `resources`, `macros`, and package metadata.
4. Confirm only runtime code, static product assets, open-source licenses, and
   default configuration are present.
5. Record SHA-256 for every uploaded asset in `SHA256SUMS.txt` and verify the
   file immediately after downloading it from the draft release.

Source scans can produce example credential field names. A finding is only
safe to dismiss after confirming that it is a placeholder or schema key and
not a real value. Never upload an uncertain artifact.

## GitHub release

For the first public build, target the public release commit and create a draft
until all artifact and checksum checks pass:

```powershell
gh release create v0.1.0 --repo mousse-agent/mousse --target <public-commit> --draft --title "Mousse v0.1.0" --notes-file <notes>
gh release upload v0.1.0 <windows-gui> <windows-cli> <linux-gui> <linux-cli> SHA256SUMS.txt --repo mousse-agent/mousse
```

After downloading and rechecking the draft assets, publish with:

```powershell
gh release edit v0.1.0 --repo mousse-agent/mousse --draft=false
```

No source branch push is part of this workflow.

## SignPath Foundation handoff

The unsigned Windows installer is the input requested for the SignPath
Foundation application. After approval:

1. create a SignPath project for `mousse-agent/mousse`;
2. configure GitHub Actions to build from an immutable release tag;
3. submit the unsigned installer produced by that workflow;
4. publish the returned signed installer as a new release asset;
5. update checksums and keep the unsigned artifact clearly labelled.

Do not place SignPath organization IDs, API tokens, or certificate material in
this repository. Store workflow secrets only in GitHub's encrypted secret
store.

## Website handoff

`mousse-site` resolves Windows and Linux downloads server-side from the latest
GitHub release and falls back to the repository release page. The macOS control
links to the repository until a macOS release artifact exists.

The site build is local-only while the owner instruction **do not push
anything** remains in force. The existing Vercel deployment will update only
after its three local site commits are reviewed and pushed by the owner. A
separate Sites deployment is also intentionally not created because that
workflow requires pushing the validated source to a hosting repository.

## Mobile client handoff

The standalone `mousse-client` repository contains Capacitor Android and iOS
projects. Web validation is platform-independent. Native release builds need:

- Android: Android Studio/JDK, an Android SDK, an owner-controlled application
  ID, and a release keystore stored outside Git.
- iOS: macOS with the current Xcode and CocoaPods, an Apple Developer team, the
  final associated-domain/deep-link entitlement, and App Store signing.

Use debug builds for local verification only. Never commit a keystore,
provisioning profile, signing password, Apple API key, or built mobile package.

## Known external blockers and deferred gates

- macOS desktop binaries are intentionally absent; the website links to GitHub
  until the owner adds them.
- An iOS native build cannot be verified on Windows/WSL; it requires a macOS
  runner with Xcode.
- Site publication is deferred by the explicit no-push instruction.
- The current desktop dependency tree reports upstream audit findings in
  transitive packages. None originate in `@jmondi/oauth2-server`, but they must
  be reassessed before a later signed/stable release and updated without a
  breaking downgrade.
- The OAuth HTTP server and mobile client are local commits newer than the
  public `origin/master` release source. They must not be represented as part
  of `v0.1.0` until their commits are reviewed and intentionally pushed.
