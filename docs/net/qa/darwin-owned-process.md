# Darwin owned process drain

I reproduced the unchanged `platformProfileDrain.test.ts` child/grandchild case
on UI candidate `de50e0f1`: profile removal failed after 15.659 seconds with
`profile_busy`. The production tree signaler explicitly rejected Darwin and had
no Darwin creation-identity capture. A fixture grandchild remained live after its
original parent exited. I inspected its exact PID, start and fixture command
before emergency cleanup. Earlier frozen `74abef64` and Control cutover logs
showed the same failure; those passing/failing baselines were not substituted for
this current reproduction.

I separately ran the current production profile-isolation fixture through the
actual preload, GUI controller and MMS server. All seven checks passed, including
the intentional `profile_mismatch` rejection and real per-profile settings
events. I made no profile authorization change. I used a short isolated worktree
because the original long checkout path exceeded the Darwin Unix socket limit.
Its runtime dependencies came from the current Chats candidate; the older Net
dependency directory lacked `@agentclientprotocol/sdk`.

## Implementation

`darwinProcess.cc` is a separate NAPI 8 addon. It reads `proc_bsdinfo` through
`proc_pidinfo(PROC_PIDTBSDINFO)` and inventories direct children with
`proc_listchildpids`. Creation identity is PID plus kernel birth seconds and
microseconds. Apple's [libproc wrapper source](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)
confirms that `proc_listchildpids` returns a PID count, while `proc_listpids`
returns a byte count.

The adapter captures before local termination, verifies each parent edge and
the unchanged root, checks for newly appeared children before completing
capture, and stores at most 256 process identities. Capture, signal iteration
and liveness iteration have one-second local deadlines. It signals descendants
before parents. Each native signal rechecks the exact birth identity immediately
before signaling one positive PID. It never signals a process group or matches
process names. Captured descendants remain identifiable after reparenting;
shutdown does not rediscover descendants from a dead root's reusable numeric
PID. Identity, permission and resource uncertainty retains active ownership.
Zombies and `ESRCH` are treated as exited.

The fixed host resource is
`out/net-native/darwin-<arch>/owned-process.node`, accompanied by a bounded
manifest with platform, architecture, NAPI and SHA-256 checks. There is no
received module path or runtime compiler. Missing or substituted resources fail
closed. `buildPackagedNativeReader()` also builds this independent addon, so the
existing desktop, CLI, development and packaging entry points include it. The
existing `out/net-native/**` ASAR unpack rules apply. Linux and Windows signaling
are unchanged; other platforms still report unsupported tree termination.

## Verification

I ran focused checks only, using Node 24.20.0 on Darwin arm64:

- The original composed profile-removal and installation-stop case passed in
  1.55 seconds after the change.
- All 39 tests in `platformProcessLifecycle`, `platformProfileDrain` and the
  initial native adapter tests passed. The final native file has five passing
  tests, including missing addon/hash substitution, changed root/parent,
  bounded inventory, retained uncertainty, substituted birth, unrelated live
  processes, and a stubborn captured orphan through TERM then KILL.
- Two PTY checks initially failed before spawning: the shared `node-pty`
  `spawn-helper` had mode 0644. I copied that dependency into the task-owned
  worktree and ran the existing executable repair there. The shared installation
  remained unchanged. The focused checks then passed.
- Source Node typecheck, source ESLint and diff checks passed.

The emitted QA entry uses the real `HeadlessAgentRunner` and fixed addon loader.
I ran it under Node 24.20.0, actual Electron 43.2.0 main mode (embedded Node
24.18.0), and a separately built macOS application carrying the production
main/CLI modules with a QA-only main entry. The ASAR probe verified the addon was
unpacked, exercised fixed packaged resolution, retained the original stubborn
orphan identity, denied a substituted birth, preserved an unrelated tree, and
finished with zero owned work and every fixture PID gone. These are process
lifecycle checks; they do not qualify Electron's embedded Node version for
unrelated cryptographic requirements.

Reproduction commands, after preparing the normal dependencies:

```sh
node scripts/build-owned-process.mjs
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run tests/platformProcessLifecycle.test.ts tests/platformProfileDrain.test.ts tests/darwinOwnedProcess.test.ts
TMPDIR=/private/tmp node scripts/net-qa/owned-process/run.mjs node
TMPDIR=/private/tmp node scripts/net-qa/owned-process/run.mjs electron
TMPDIR=/private/tmp node scripts/net-qa/owned-process/run.mjs mac-app
```

The QA driver preserves its unique evidence/package directory. Its fixed
heartbeat script path is a test-only launch input, not a production adapter or
remote DTO. On this machine the retained reports are:

- `/private/tmp/mousse-profile-lifecycle-owned-red.log`
- `/private/tmp/mousse-profile-lifecycle-owned-green.log`
- `/private/tmp/mousse-profile-lifecycle-focused.log`
- `/private/tmp/mousse-profile-lifecycle-native-final.log`
- `/private/tmp/mousse-owned-process-qa-MDX9nA/evidence.json` (Node)
- `/private/tmp/mousse-owned-process-qa-EjY5zy/evidence.json` (Electron)
- `/private/tmp/mousse-owned-process-qa-MHzvdF/evidence.json` (final ASAR)

This checkpoint qualifies the reproduced current Darwin arm64 ownership paths.
I have not run a full suite, qualified Darwin x64, or newly qualified Linux or
Windows with this checkpoint. The finite capture is not a kernel-level process
freeze or proof against arbitrary new descendant creation after capture. This
remains a draft stacked candidate for review; it does not merge or enable the
network stack on the default branch.
