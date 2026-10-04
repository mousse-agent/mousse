# Consolidated repository candidate — 2026-10-04

I combined all 15 open PR heads captured below on the current remote default branch, with the previously verified local desktop integration. I preserved source history and authorship. I use [PR #61](https://github.com/mousse-agent/mousse/pull/61) as the single review candidate. I verified the latest source heads in ancestry and inspected their retained behavior before consolidating their discussions and closing redundant source PRs. Their unresolved review and release gates remain attached to #61 and the existing tracking issues.

| Source PR | Frozen head | Scope |
| --- | --- | --- |
| [#38](https://github.com/mousse-agent/mousse/pull/38) | `d524d28a0248565d6dbc65be9a6b430b196bea58` | fix(linux): correct acrylic intensity and round window edges |
| [#41](https://github.com/mousse-agent/mousse/pull/41) | `9e9136d15e735dc38ddfa3105603ab9815f569cf` | feat: publish desktop chats, navigation, composer, and Linux window updates |
| [#45](https://github.com/mousse-agent/mousse/pull/45) | `aa3feeeb45223e0705d85ffe965e3b65eaa1906a` | feat(net): Mousse Net foundation for Bridge and Spaces |
| [#48](https://github.com/mousse-agent/mousse/pull/48) | `1320236cb0571d31f4508c35ec170c6a3bf5496e` | feat(net): P2 profile-scoped network and enrollment CLI |
| [#49](https://github.com/mousse-agent/mousse/pull/49) | `4247903bd52cfeafd1348eb797524c2e08deb9a5` | feat(net): P2 exporter-bound node enrollment |
| [#50](https://github.com/mousse-agent/mousse/pull/50) | `419c3965f6c9e5c55840b748de4a2e225a155e20` | feat(chats): prepare gated Space publication and network binding |
| [#51](https://github.com/mousse-agent/mousse/pull/51) | `eac2322228288702647fbf36f6fcf37ee8657aac` | Prepare Control backend cutover while preserving legacy credential migration |
| [#52](https://github.com/mousse-agent/mousse/pull/52) | `2e8e1bd30c240d88fd18a36474943dd7c500413a` | feat(gui): integrate network Chats and Devices with the current shell |
| [#53](https://github.com/mousse-agent/mousse/pull/53) | `e36e4f49e64d8a636ca33a13a152ff37e9d2d6a8` | Preserve unchanged Tunnel routes and await Electron foreground shutdown |
| [#54](https://github.com/mousse-agent/mousse/pull/54) | `dfabc2cb03209845407b9149c0f62b9096f4916c` | feat(net): add profile rollback and default-off domain admission |
| [#55](https://github.com/mousse-agent/mousse/pull/55) | `97a55700e9285d1f324a67d64b1aacf4b20847d9` | Drain Darwin owned descendants using kernel birth identities |
| [#56](https://github.com/mousse-agent/mousse/pull/56) | `0204e5a0988e0530435301076b89fd222726d69a` | feat(gui): rediscover saved Chat device tasks |
| [#57](https://github.com/mousse-agent/mousse/pull/57) | `e206ac1fe113f923c0023fb1ec5ec11ce21565fa` | fix(cli): preserve packaged exit status and qualify Linux ASAR |
| [#58](https://github.com/mousse-agent/mousse/pull/58) | `dc2ce007e5cf912175149608b17c72e2b33be3bf` | test(gui): preserve mounted network view lifecycle regressions |
| [#60](https://github.com/mousse-agent/mousse/pull/60) | `29d5bc269385c05da92c4fc787de40c2ce60f351` | feat(net): add optional Mousse Plus identity and hosted Spaces transport |

## Integration decisions

I started from remote default `7c973adf2ada0e854a44985c36ceef48e1588063` and retained the primary checkout's prior integration `fa47303ed6c38e3c14d3489c083b192c85aa758b`, including the complete #41 history and its verified local fixes. I kept the newer startup/cache changes together with desktop provider authentication and composer behavior.

I retained the current #45 Net admission and lifecycle semantics while adding #52 network Chat binding and Control retirement. In particular, disabled networking returns `disabled`, doctor/protect/unlock require opt-in, and `net init --unlock` is the explicit protected-profile reactivation path. I kept independent domain/RPC admission, profile-wide preauthentication limits, safe checkout denial, private authorization, join reservations, and retryable route withdrawal. I adapted renderer denial handling to clear a disabled network view.

Historical heads whose commits were already integrated by equivalent or adapted implementations are retained through merge ancestry. I kept the later implementation rather than replaying older behavior. Plus remains optional and profile-owned; hosted companion/server deployment and credential review remain separate.

I incorporated the renewal-clock checkpoint published to #45, #50 and #52 during preparation. This table now records the latest source heads captured for consolidation; subsequent source updates require another integration.

I fixed two concrete Windows runtime blockers: unsupported directory open/fsync errors and Git's rejection of Node's Windows null-device path. Directory handling tolerates only Windows EPERM/EINVAL at directory open/fsync, retaining file flushes, atomic renames and SQLite FULL durability. Git uses its supported `/dev/null` path while preserving hook, fsmonitor, filter and protocol protections. I adapted real process-crash and tunnel fixtures to Windows process invocation/exit reporting without weakening production process or credential policy.

I deferred eager workspace views, hidden overlays, theme reads and Chat refresh until the real profile selector resolves the trusted binding. This removes requests made with the initial `default` placeholder and avoids the redundant initial startup batch. Navigation and chrome remain available during bootstrap, and the protocol request limit remains 64.

## Local testing

I selected `codex/all-open-prs-20261004` in `E:\avarnic\mousse` for `npm start`. Those edits were excluded at that historical testing checkpoint; I now include all current tracked and untracked work in the consolidation below. The pre-integration commit and file copies are retained locally for recovery.

I passed both TypeScript checks and the production desktop/main/preload/CLI build with the private renderer edits present. After the final backend changes I passed the Node TypeScript check and launched `npm start`, rebuilding the CLI, browser worker, Electron main and preload successfully.

I ran focused provider/catalog, mounted renderer, CLI/default-off, directory-error, TLS enrollment, transport, Chat publication/task recovery, private authorization, rollback, Control cutover, Plus profile/login and Git isolation checks. I corrected the concrete Windows failures and passed each affected rerun, including all 7 Chat task tests, 19 enrollment/transport tests, 33 CLI/default-off tests, 14 directory-error tests, 5 safe-checkout tests, the malicious Git configuration isolation case, 26 provider/catalog tests and 62 renewal/identity/Spaces/sync tests. Platform-specific daemon fixtures remain skipped on Windows. I did not run the full suite.

After observing startup request-limit/profile errors, I passed all 15 GUI controller checks and added a passing hidden Electron regression mounting the real StrictMode root, profile selector, browser permission view and Channels panel against a controlled UI API. It holds bootstrap responses, verifies no profile reads occur before binding, and verifies browser, channels, theme and Chat reads resume afterward without renderer errors. I passed the final renderer TypeScript check with the private edits and rebuilt production assets after this change.

Windows Plus credential-file bootstrap remains fail closed because POSIX-private file permissions cannot be verified there; browser login remains the supported path. Windows directory power-loss durability, paid providers, hosted production interoperability, every packaged platform, completed soak and release approval remain unqualified.

## Latest consolidation and current verification

I started this update from current master `d233868d`, fast-forwarded to the latest combined checkpoint `d3fc1f60`, and added all 185 locally changed or untracked files from the primary checkout. That includes the desktop shell/sidebar/composer and chat/tool presentation, Hugeicons migration, bundled Geist fonts and licenses, startup/theme surfaces, native first paint and handshake support, agent timing/completion presentation, focused regression fixtures, the collaboration plan and architecture-review PDF. I preserved the primary checkout and normalized text line endings to avoid formatting-only diff noise.

I incorporated the latest #45/#50/#52 heads in merge `5d75b0dd`. Their current code and test corrections were already present through master and the later integrated layers; this merge retained their ancestry and added the missing status evidence. Every source head listed above is an ancestor of this candidate. I retained later intentional integrations, including Control retirement, current default-off admission, typed Chats errors, stronger prompt lineage and current desktop presentation, rather than replaying older behavior.

I passed Node and renderer type checks and the production desktop/main/preload/CLI build on Windows. I passed 69 checks across 12 focused files covering startup appearance and first paint, profile readiness/footer isolation, controller startup, window material, sidebar animation/reduced motion, prompt markers, icons, model variants and tool grouping. I separately passed three targeted agent stop/retry cases; 33 unrelated cases were excluded. Focused ESLint completed with zero errors and 69 warnings, including ignored test-file notices. I did not run the full suite. Earlier source reports remain historical evidence and do not establish fresh current-head qualification of every platform or network feature.

## Carried review and release gates

I retain the candidate as a draft. Authentication/authorization and credential changes still require the other human teammate's review under the shared team policy. I preserve the actual-companion evidence in [Plus rendezvous recovery](../net/qa/plus-rendezvous-recovery.md): committed revocation with a lost acknowledgement cannot reconcile on retry, and a committed hosted invitation replay fails outer enrollment's exact expiry check. Historical expired/pruned pending-operation recovery also remains incomplete. I have not weakened custody, authority or expiry guards to close these gates.

I carry forward Linux visual confirmation, supported-platform vault and package qualification, hosted production/browser-login interoperability, private authorization release review, paid-provider evidence and completed soak/full release qualification. [Issue #44](https://github.com/mousse-agent/mousse/issues/44), [#40](https://github.com/mousse-agent/mousse/issues/40), and [#37](https://github.com/mousse-agent/mousse/issues/37) remain open for their broader outstanding scope. Closing a source PR consolidates its implementation and discussion; it does not mark these issues complete or certify release readiness.
