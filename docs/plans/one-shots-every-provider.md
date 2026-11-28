# Single requests on every provider

Design (level 2) for how Mousse runs thread titles, branch names, pull request drafts, commit messages and a bot's name and digest on every connected provider. Two independent proposals agreed on the shape; one outside read of the first draft was answered in this version. Base: master 330be6542.

## Decision
Both proposals have the same shape:
- each provider builds a **route** with stated facts;
- **one admission step** produces an immutable **plan**;
- **one runner** sends it once;
- **one owner** handles reservations, folders, processes and leftovers;
- the launch keeps user config out by construction.

Proposal 1 is the base. Parts taken from proposal 2 and from the outside read are folded in.

**Rule amendment (product decision).** Rule 1 is amended: an agent whose own native tools Mousse can't stop before they run may still name threads. Mousse refuses every call that passes through it before it runs, detects the rest when they're reported, and labels the route **best-effort**. This covers generic ACP and Antigravity, which are on by default.

## Shape (`src/mms/harness/oneShot/`)

### 1. Route facts (`route.ts`, types only)
- **`tools`:** `none_offered`, `refused_before_run` (every tool call passes through Mousse, which refuses it), or `detected_on_report` (the agent's own tools; Mousse refuses what passes through it and ends the request at the first report).
- **`attempts`:** `one` (measured at a stub) or `unenforced`. `one_observed` is dropped: watching for a retry frame isn't proof that the retry was prevented.
- **`isolation`:** `verified` (the effects spike showed no user config loads) or `env_only` (only the environment is redirected).
- **`launch`:** `in_process`, `sealed_child` or `sealed_host`.
- **`audience`:** `any`, or `own_threads` for local models.

The label is computed, never declared. **Held** means `none_offered`, `one` and `verified`. Anything else is **best-effort**, and the tooltip lists the facts behind it.

A route doesn't run itself. It supplies a narrow **transport**: launch spec, request builder and event decoder. The runner owns sending, checks, caps and refusal handling, so a route can't skip a check or switch transport.

### 2. Admission (`admission.ts`)
`admit(op, binding)` reads only cached state and returns either an immutable **Plan** or `NotAdmitted{code, reason}`.

- **`op`** names the operation: thread title, branch name, PR draft, commit message, bot name or bot digest.
- **`binding`** names the exact target, including a thread's local binding. A local thread whose model is stale or unloaded fails closed to its first line; it is never treated as a cloud thread.
- **The Plan** carries the route, the transport, the identity (executable fingerprint, credential kind and generation, facts generation), the bounds and the operation.
- **Users:** the picker listing, Automatic, `resolveStored` and the runner all use `admit`.

**Cache only.** Title entry points get a path that only reads the cache: the listing and first-send naming never await a probe. Facts are rebuilt only on existing lifecycle events:
- a probe completing;
- a sign-in or sign-out;
- an instance config change;
- a binary change seen by a probe.

While facts are unknown, the thread keeps its first line.

### 3. Runner (`runner.ts`)
It takes a Plan, checks the identity against the live executable and credential just before sending, and sends exactly once. A mismatch is refused before sending; nothing is ever sent again.

**Bounds:**
- a per-candidate deadline, the smaller of 15 s and the budget left minus 3 s kept for the next candidate;
- the 60 s inactivity bound;
- a 128k streaming cap.

An answer is applied only if the thread's naming revision still matches.

**Budget unit**: each naming pass (first send, after-reply refinement, or a cold-start retry) has its own 3 attempts within 25 s. A candidate's timeout moves on to the next one. Total expiry or cancellation ends the pass.

**Failures (exhaustive):**

| Failure | Automatic | Explicit choice |
|---|---|---|
| `tool_refused` / `tool_detected` | next candidate; the entry's other models stay eligible | error shown; first line stays |
| `rate_limited{scope, until, transient}` (incl. quota notices sent as answer text) | quota → `usageLimits()`, transient → `namingCooldowns()`, by model or entry | same marks, no fallback |
| `retry_detected` | classified by its cause, as above | same |
| `unavailable` / `empty` / `too_long` | short cooldown on the entry; next candidate | error shown |
| `signed_out` | entry skipped | reason shown on the saved choice |
| `timeout` | next candidate if budget remains | error shown |
| `not_admitted` | skipped without sending; doesn't count as an attempt | reason shown |
| `cancelled` | pass ends | pass ends |

`policy_unenforceable` comes out of `automaticNamingStops`.

### 4. Reservations and places (`places.ts`)

- **A record before anything exists.** A durable control record `<profile>/one-shot-ledger/<uuid>.json` (states `reserved → running → stopping → reaped → removed`) is written before the place `<profile>/one-shot/<uuid>/` is created and before any vendor code runs. It lives outside agent-writable space, holds no prompt, title or secret, and is read back as untrusted input.
- **Proof the tree is gone.** A place reaches `reaped` only on positive proof that its process tree has drained:
  - **Windows:** the existing job supervisor (`windowsProviderProcess.ts`), whose job already starts at creation, reports the job empty.
  - **POSIX:** a small per-request watcher kills the whole process group when its pipe from the daemon closes, then reports the group empty. It is not a resident guardian.
  - Without that proof the record stays and is retried.
- **Vendor leftovers** are typed targets: a path rule plus an ownership proof, such as Antigravity's conversation that names this place, or an OpenCode session id. Deletion never follows links or junctions, rechecks the object's identity and ownership at deletion time, and never trusts a stored "owned" flag. Ambiguous, malformed and young records are retried, not skipped forever.
- **The sweep** runs in the daemon's existing post-ready maintenance pass, about 60 s after ready. It never runs on the start path, and doesn't wait for a naming request. Antigravity's cleanup code moves here.

### 5. Sealed launch (`launch.ts`)

- **Environment, built in this order:**
  1. an allowlist (PATH, SystemRoot, proxy and certificate settings, locale);
  2. the entry's own variables;
  3. the preset's narrow inputs;
  4. the **reserved roots applied last**, so nothing can override them: `HOME`, `USERPROFILE`, the XDG folders, `APPDATA`, `LOCALAPPDATA` and `TMP` point into the place.
- **The entry's arguments** go through a per-preset allowlist.
- **Credential inputs** are named files or variables per preset, never a whole folder. Each is tested against token rotation by file replacement. Where linking can't survive rotation, the preset reads the credential through the vendor's own config-root flag pointed at a minimal folder.
- **Prompts** go over stdin or the protocol, never the command line.
- **Claude's managed hooks** can't be turned off. When a managed settings file is found, Claude is `isolation: env_only` and best-effort; otherwise it's verified.
- **Pi's session key** is allowed for prompt-cache affinity only; it saves no chat.

### 6. Listing and picker

- **A cached title listing per model,** covering admitted, best-effort and unavailable models (with a reason), including disabled and signed-out entries. It's built from admission and never awaits a probe.
- **The saved choice** always shows as a row with its exact reason, even when nothing live matches it.
- **Older computers:** the listing still sends a per-instance `oneShot` boolean, set when at least one of the instance's models is admitted. It's removed in the last slice, once every computer reads the per-model field.

## Providers
Labels are as computed; a route's slice changes its facts.

| Provider | Route | tools / attempts / isolation / launch | Label |
|---|---|---|---|
| Pi | `pi:direct` | none / one / verified / in_process | held |
| Local models | `pi:direct`, `own_threads` | none / one / verified / in_process | held |
| Pi on Bedrock | `pi:worker` with `AWS_MAX_ATTEMPTS=1` set before client creation; SSO, credential-process, role, web-identity, `aws login` and container sign-ins refused | none / one / verified / sealed_child | held (slice 5) |
| Generic ACP | `acpOneShot`, default sealed environment, no provider-specific code | detected_on_report / unenforced / env_only / sealed_child | best-effort |
| Antigravity | `acpOneShot` plus preset inputs; keeps #1936's flags, sign-in handling, post-exit scratch check and quota mapping | detected_on_report / unenforced / env_only / sealed_child | best-effort |
| Claude | migrated in slice 2, with a handoff fence (no resend after the spare took the prompt), `CLAUDE_CODE_MAX_RETRIES=0`, `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, and its place as cwd | none / one if the stub count proves it / verified unless managed / sealed_child | held, or best-effort |
| Codex, ChatGPT token | `codex:direct` | none / one / verified / in_process | held |
| Codex, API key on OpenAI | `codex:direct_key` | none / one / verified / in_process | held |
| Codex, custom provider | app-server: native tools can't be removed by flags (`oneShot.ts:31`), so either F8 proves a launch-specific no-tools route, or it stays best-effort | detected_on_report / unenforced / env_only / sealed_child | best-effort |
| OpenCode | sealed server: deny-all session or `generate`, whichever F6 proves; free models that need `read` are best-effort | none / one if counted / per F6 / sealed_child | held, or best-effort |
| Cursor | `cursor:sdk` on a dedicated host process, as the draft has it | none / one if counted / verified / sealed_host | held, or best-effort |
| Grok, account | the headless request on a throwaway home shipped in #1995; moves onto the runner in slice 6 with its facts measured there | measured in slice 6 | per facts |
| Grok, API key | `grok:direct` | none / one / verified / in_process | held |

## Rejected from proposal 2, and why
- **Arbitrary ACP commands and Antigravity unavailable:** it was decided they're on by default as best-effort. Rule 1 is amended above.
- **A concurrency cap:** the product rule is no caps.
- **Deleting Claude's spare:** the fast-start rule. The handoff fence covers its risk.
- **A resident guardian:** replaced by the per-request watcher on POSIX and the existing job supervisor on Windows.

## Spikes (before the slice that needs them)
- **F1, effects and containment:** a fake agent with startup config, hooks and a native tool, launched through `launch.ts` on Windows and Linux. Did anything outside the place run or change? This decides `verified` versus `env_only` per launch kind.
- **Inference counts:** count calls on 429 and 503 at a stub for Claude, OpenCode, Bedrock and Cursor before any of them claims `one`. Check the tool declarations actually sent, the startup code, and session persistence.
- **F6, OpenCode:** where plugins and MCP load from; deny-all session versus `generate`.
- **F8, Codex custom provider:** is there a launch-specific route with no native tools?
- **Windows fault injection:**
  - daemon killed before spawn, during spawn, after a session is created and after the answer;
  - a surviving grandchild;
  - PID reuse;
  - a malformed record;
  - a junction inside the place;
  - an unrelated session as the negative control.

## Slices (each one end to end, from Settings through the stored choice, admission, launch and the saved title)
1. **The vertical slice.**
   - **Scope:** the core modules, `pi:direct` and generic ACP (`acpOneShot`) on the new runner, places and launch, plus the per-model listing and labels. Every other provider stays on its current code as a separately named **legacy** route, admitted through the same `admit` but with no new claims, until its own slice.
   - **Deleted:** the title gate's boolean, `purposeAllowed` for titles, and `oneShotProviderOptions`.
   - **Tests:**
     - a picker-to-title run for a scripted ACP agent known only by its command;
     - its tool report ends the request and Automatic moves on;
     - an explicit choice doesn't fall back;
     - the local-thread bindings, and both bot callers;
     - the Windows fault-injection set;
     - the sweep without any naming request.
2. **Antigravity onto `acpOneShot`,** keeping its specifics, plus **Claude** with the handoff fence and the stub count.
3. **OpenCode (F6) and Codex** `direct_key` plus F8.
4. **Cursor** on its dedicated host, with the count.
5. **The Bedrock worker.**
6. **Grok** `direct`, plus the held-home route. The old boolean is removed, and the new providers are added to `namingProviders` through the catalog skill.

**Check per slice:** its named tests through `node scripts/verify.mjs`. **Not checked without a person:** real sign-ins, and macOS and Linux crash cleanup by hand.

## Revisit if
- An ACP agent is seen causing harm before it reports a tool.
- POSIX watchers leak in practice.
- A vendor changes how it retries.
