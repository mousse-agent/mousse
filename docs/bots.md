# Bots

How personal bots work as of Bot Mode Phase 1, for developers. The design and its reasons are in the plans: [`plans/bot-architecture.md`](plans/bot-architecture.md) (engine, runtime, daemon API), [`plans/bot-ui.md`](plans/bot-ui.md) (the screens, with mockups in [`plans/mockups/bot-ui/`](plans/mockups/bot-ui/)) and [`plans/bot-context.md`](plans/bot-context.md) (memory). Memory as built is in [`bot-memory.md`](bot-memory.md). Terms are in the [glossary](GLOSSARY.md). Space bots are a separate system (`src/mms/bots/space/`) and are not covered here.

## What a bot is

A bot is an agent a person makes from a **look** and one sentence ("What should it do?"). It lives in the Chats tab, in the Bots section. Its owner talks to it in its **bot chat**, and it also works on its own schedules. Everything else is set by asking it: permissions, schedules, its name, how much time it takes. The UI never shows a model, a tool row or a form.

- The definition is format 2 (`src/shared/bots/personal/definition.ts`): name, description, look, role, the main thread spec with its model choice, and the grant (`permissions`). `owner` and `placement` are reserved for Teams and bot servers. Format 1 files are upgraded on read.
- `bots.create` names the bot with one short model call (5 seconds at most). When that fails, a name made from the description is used, and the bot picks its own in its first turn. The bot's first message is produced at once, as a chat activation.
- **The starter grant** (approved by pressing Create bot): read, list, search, edit and write in the bot's files folder only, the web (`web_search`, `web_fetch`), the bot's own tools, and an hour of work per activation. A bot whose grant still holds the earlier default of 15 minutes is moved to the hour when the profile opens (`BotEngine.upgradeWorkTime`, the same publish-and-approve as Allow); a grant the owner raised stays. The browser is asked for separately (see Use the browser).

## Lanes

Each bot has two lanes. At most one chat activation and one run activation exist at a time, side by side, sharing one spend ledger.

| | Chat lane | Run lane |
|---|---|---|
| Started by | the owner's message (`bots.chat.send`), or the bot's creation | a schedule, or by hand (`bots.activate`, internal) |
| Thread | the home thread, execution key `bot:<id>` | a new child thread, `bot:<id>:act:<activationId>` |
| Context | cleared at each activation's first dispatch (`clearConversationContext`), then the chat pack | the run brief, keyed by the schedule id |
| Missing permission | a wall: the turn ends with an ask card, and the answer continues it | refused; the run carries on (see Asks) |
| Ends with | a reply (`text` row) | a run report (`run_report` row), also the notification |

- Clearing the home context keeps the transcript but sends no thread history, so no bot turn depends on a runtime session surviving. Claude Code and Codex resume their native session only while the history Mousse sends is the one saved after the last turn, so a cleared context starts a new one. Continuations inside one activation (a wall answer, a reload) keep the activation's own turns and may resume.
- A message sent while the chat lane is busy queues behind it. A message sent while the chat waits at a wall counts as Not now for its asks, and the turn continues with that message.
- Ordinary sends, steers and queue writes to a bot's threads are still refused (`bot_thread_read_only`). The owner's chat goes through `bots.chat.*`, so every turn keeps the bot's grant and lock.
- **The bot chat is `bot_messages`** in `bots.db`: owner messages, replies, run reports, notices with ask cards, error lines, and the chips of each message. The renderer reads only this table, never transcripts, so tool rows and model names can't leak.
- Each activation has a scratch folder, deleted when it ends. Documents the bot keeps go to its **files folder**, `<profile>/bots/files/<botId>/`, which every bot may write and which About never lists.
- **The bot chat's composer** is the thread composer (`ChatComposer`) without a thread's run settings: no model picker, reasoning level, permission mode, context ring, `/` commands or skills, since a bot picks its own model. It keeps the same box, attach (the button, dropping files and pasting images), dictation, Up for the last message, and Send or Stop.
- **Attached files** are copied into the bot's files folder, under `attachments/<date>/`, and the message and the bot's input name the copies (`copyBotAttachments`). The starter grant reads them, so the bot never needs the folder the owner keeps them in, and its edits never touch the originals. A pasted file has no path: it waits in a temporary folder until it is copied. At most 10 files of 50 MB each per message. Images reach the bot as files it reads, not as pictures in the message.

## Asks

An ask is a request for one permission, shown as a card with Allow and Not now (`bot_escalations`, `mode` `wall` or `ask`).

- **In a chat turn** the bot's authority check returns a wall: the dispatch ends, the reply carries the card, and the answer continues the turn ("The owner allowed …" or "The owner said not now …"). Several `escalate` calls in one turn put all their cards on that one message. At most 5 walls per activation (`MAX_BOT_WALLS`).
- **In a run** the check returns a third outcome, `refused`: the call fails with "The owner has not allowed this yet. You asked them; carry on without it and say in your report what you skipped." and the dispatch goes on. One open ask is kept per permission (by fingerprint); later runs get the same refusal and write no new ask. A run writes at most 5 new asks, a bot at most 10 a day. An ask that waits never blocks a run or skips a schedule.
- **Budgets** are different: a run that runs out of time or turns ends as failed, with an ask for more room. Only work is charged: time spent waiting for the internet is not (see No internet), and a run that made no call at all in its whole time, with the internet there, ends failed with no ask (`no_progress`, "I couldn't get anything done on this run, so I stopped.").
- **Allow** publishes and approves the widened grant; a run ask is used from the next run, with no follow-up activation. **Not now** closes the ask; a run may ask again for it after 24 hours. Asks never expire.
- About lists what the bot can use, each with Remove (`bots.permissions.revoke`). Narrowing needs no approval.
- Card wording comes from `askText` (`src/shared/bots/personal/askText.ts`).
- The bot asks straight away: when the owner wants something it has no permission for, its instructions (`src/mms/bots/instructions.ts`) tell it to call `escalate` at once, with one plain sentence on why, and then say it has asked. It never asks the owner whether it should ask.

## Run commands

"Run commands" (the neutral tool `shell`) is one permission for any command. The bot asks for it once (a card reading "run commands"); after Allow it is in the grant like any other tool, and no command is asked about again. Not now, the ask caps and About → Remove work as for every other permission. The authority allows every `shell` call once the grant holds it, whatever command or folder the call names (`botAuthority.ts`); without it, a command is a wall in the chat and a refusal with an ask in a run. Commands start in the bot's files folder. How far a command reaches depends on the runtime:

- **Claude Code** (owner's entry): Bash is offered only when the grant holds `shell`. Where Claude Code's own sandbox can run (bubblewrap and socat on Linux, Seatbelt on macOS), Bash runs in it: writable are the bot's files folder and its scratch folder; without file access the home folder is unreadable except for those; with it commands read and write the whole file system but Mousse's own data (see File access); the network is closed; `dangerouslyDisableSandbox` is refused (`claudeLockedSandbox`). Where the sandbox can't run (Windows, or Linux without bubblewrap or socat), Bash still runs, outside any sandbox, because the owner allowed commands as a whole.
- **Codex**: with `shell` the thread runs in the `workspace-write` sandbox over exactly the bot's files folder and its scratch folder, and with file access every entry beside Mousse's own data too, with no network and no temporary folder (`codexTurnPolicy`, `codexBotSandbox`). Approvals stay `untrusted`, and the grant answers every command approval with accept. A retry outside the sandbox ("retry without sandbox?") is always declined. Without `shell` the sandbox stays read-only and command approvals are walls or asks.
- **Pi**: with `shell` the turn offers Pi's `bash` tool; it runs in the locked environment, from the bot's files folder, with no sandbox.

So a command can read, and on Pi or an unsandboxed Claude Code change, files outside the bot's folders. The card's note says so.

## File access

"Use files on this computer" is one permission for every file and folder, read and write (`docs/plans/bot-architecture.md` §3.7). Without it a bot's file tools reach only its files folder and its scratch folder. The first time a file call names anything else, or the bot asks with `escalate` for any folder, there is one ask (`filesAsk()`, the same card whatever the folder); after Allow, no file or folder is asked about again. Not now, About → Remove and the ask caps work as for every other permission.

- **Stored form.** The grant's `workspace`: any non-null workspace is file access. Allow writes `{roots: ['/'], access: 'write'}` (the system drive on Windows). A grant an older build wrote for some folders keeps its form and digest and counts as file access; About lists it as one line.
- **Older asks.** When bots open (`BotEngine.upgradeFileAsks`), open folder asks are worded as the file ask. A bot that already has file access gets them settled as allowed, and a chat waiting at one continues. Otherwise one stays open (the chat's wall, else the oldest) and the others are withdrawn.
- **Mousse's own data stays closed**: the Mousse home holding the profile (every profile, the instances' sign-ins, Mousse's sign-in and keys), except the bot's files folder and scratch (`mousseDataFolder`, `BotAuthority.check`). A call there is refused with no ask, and so is a path a runtime would rewrite (`~`, a variable). This was already the floor for folders; it now holds for the whole computer.
- **Per runtime.** Claude Code: the grant gate checks every path; with "run commands" the sandbox writes the whole file system, cannot read Mousse's data but for the bot's folders, and cannot write any entry in it that does not lead to them (`claudeLockedSandbox`, `entriesBeside`). Codex: file changes are checked per path; with "run commands" its writable roots are every entry beside Mousse's data plus the bot's folders, so a command cannot make a new entry directly in a folder on the way to it, such as the home folder. Pi: its gate checks every path; `bash` has no sandbox.
- **A runtime's own storage never asks**, with or without file access. Claude Code saves large tool output (web results, long command output) in `<Claude home>/projects/<working folder as a name>/<session>/tool-results/` and reads it back with Read or Grep. The bot's working folder is its files folder, so that project folder holds only this bot's sessions; the grant gate recognises calls there (`claudeOwnStorage`) and allows them (`NormalisedCall.own`), and its sandbox can read it. Codex and Pi have no such storage that a bot's calls reach.

## Use the browser

"Use the browser" is one permission for every browser tool (`browser` in the grant, `BOT_BROWSER_PERMISSION`). The bot asks for it once (a card reading "use the browser"); an ask for any single browser tool, such as `browser_act`, is the same ask, and its card never names a tool. After Allow, `compileBotThread` turns it into the browser tools (all but `browser_request_human`: the bot asks its owner in its reply instead) and the bot has them in every chat and run, with no new ask. Not now, About → Remove and the ask caps work as for every other permission. Other Mousse tools stay refused: an `escalate` for one no bot can hold is refused at once, with no card.

The browser is the bot's own (`src/mms/bots/browser/BotBrowsers.ts`), never the owner's tabs or a thread's:

- **One managed Chromium session per bot**, without a window, so a scheduled run works with no app open. It runs on a persistent Chromium profile of its own (`botbrowser_<botId>` under the profile's managed browser data), so sites the owner signs in to for the bot stay signed in for that bot only, and the bot never uses the owner's other sign-ins. A deleted bot's browser closes at once; its profile is erased with the 30-day purge.
- **Owned by the bot's home thread, with no run**, in the browser inventory: both lanes share the session, and no thread's agent or the owner's in-app browser reaches it (another owner is refused).
- **A tab per activation.** Each activation opens and uses only its own tabs; another activation's tab is refused, and a tab list shows its own. When an activation ends, its tabs close; when the last one ends, the browser closes after two idle minutes, unless the owner is watching it or holds it.
- **First use installs it.** On a computer without the managed browser, the first browser call of any bot downloads it through the browser setup (`BrowserSetupService`, once for the installation) and waits for it; the preview reads "Setting up the browser". A computer that can't run it gets a plain refusal.
- **Stop and limits.** Every call carries the activation's signal: a stop, a wall or the deadline ends it. A stopped activation can't use the browser.
- **The owner's view** (`bots.browser.*`, apart from the required Bot UI methods, so an older daemon simply shows none): `get` returns the followed tab's URL and title, the activations that used the browser and, when asked, a fresh JPEG of the tab (`frame` in the browser worker: not an observation, never sent to a model) with the agent cursor; `control` hands the browser to the owner (the bot's actions wait) and back; `input` sends the owner's clicks, scrolling, typing, keys and navigation; `open` opens the browser for the owner, under their control, to sign in to a site for the bot.

In the bot chat, the reply of the last activation that used the browser shows a small live preview: the picture, the page's title and site, and the agent cursor. While that activation still works, the preview sits under the working line. Hovering it shows Expand, which opens the split view: the bot's browser beside its chat, following the same tab, with Take over and Give back, back, forward, reload and an address field. Activity chips read "using the browser" and "used the browser · example.com".

## Schedules

A bot's schedule is an **automation whose Who is the bot**: an ordinary job in the shared scheduled-job store (`ScheduledJob.bot`), claimed by the one `ScheduledJobService`. It is not on the definition, so a schedule changes no revision and needs no approval. Manage, on the Automations page, lists it with the person's other automations, and its Edit details changes When, Do, the name and Tell me; Who stays the bot, and its May is the bot's grant. Its runs are in the Automations inbox like any automation's, and its Needs you items are assigned to the bot (folded under Assigned to bots). The bot's About lists the same records.

- The bot keeps them with `bot_schedule_add`, `bot_schedule_remove` and `bot_schedule_list` (the job scheduler's agent tools own the `schedule_*` names, and never see a bot's jobs). `bots.schedules.add` and `bots.schedules.remove` are the owner's. All of them go through `BotScheduleBook` (`src/mms/scheduled/botJobs.ts`): at most 8 per bot, at most every 5 minutes, on an interval or a cron expression. Each add shows its label as a chip ("every weekday · 09:00").
- A job's id is `<botId>--<scheduleId>`; the schedule id is the one the bot and its chat know.
- Each due occurrence is handed to `BotEngine.runScheduledOccurrence`, which inserts a run activation keyed `sched:<botId>:<scheduleId>:<occurrenceAt>` (so a repeated hand-over inserts nothing). It is skipped, with the reason on the job (`botSkip`), while the bot is paused, while every model is at its usage limit, while a run waits at a wall, while the same schedule's previous run is still queued, or while the same schedule's run waits for the internet (`waiting_for_internet`): a waiting run never expires, so a schedule keeps at most one. Missed occurrences collapse into one. A new or edited time starts from now and never runs a backlog. Nothing starts before the bot startup pass.
- After each tick, `BotEngine.maintain` ends usage-limit pauses past their reset, starts what waits in a free lane, and runs the daily purge of deleted bots.
- **Tell me** applies to run reports. A run reports its level with `run_report`, as any automation run does; a done run whose level is below the automation's Tell me posts its report without a notification (`bots.message` carries `quiet`). Failures still notify.
- Turning one off in Manage pauses that schedule only; the bot's own Pause stops all its schedules.
- Schedules saved by earlier builds in `bots.db` (`bot_schedules`) are moved once into the shared store at profile open (`migrateBotSchedules`); see "Moving schedules".

### Moving schedules

Earlier builds kept schedules in `bots.db` (`bot_schedules`, with their next runs in `bot_schedule_state`) and ticked them with a scheduler of their own. At profile open, before anything ticks, `migrateBotSchedules` (`src/mms/scheduled/botScheduleMigration.ts`) moves them once:

- Each schedule that is not removed becomes the job `<botId>--<scheduleId>` with its prompt, who added it, when it was made, and the next run the old scheduler had (a time edited since its last tick starts from now). A next run already due runs once, as it would have before.
- `bots.db` v5 adds `migrated_at` and `migrated_job_id` to `bot_schedules`; each row is marked with its job after the job is saved. Rows are never deleted, and opening a v4 database first writes the copy `bots.db.pre-v5`.
- It is idempotent: a job that is there already is only marked, so a move stopped part-way is finished at the next open and never makes a job twice. A moved schedule removed later is never moved back.
- `unmigrateBotSchedules` undoes it in code (the jobs go, the marks are cleared); no command runs it. Edits made after the move are not copied back, and schedules added after the move have no row, so they are not brought back.
- A bot's job names a thread that does not exist (`bot-schedule:<botId>`). A build from before the move, which ignores the `bot` field (and cannot open a v5 `bots.db`), finds that thread gone and pauses the job with "Its thread was deleted" instead of running the bot's prompt without the bot. To go back to such a build, restore `bots.db.pre-v5`.
- **Coming back from an older build.** An older build's first save of the jobs drops every field it does not know: `bot`, `draft`, `keys`, `tellMe`, `agent` and `cliName`. This build keeps a copy of those fields in `scheduled/jobs-kept.json`, a file older builds never write, and puts them back at profile open (`ScheduledJobStore.restoreDroppedFields`) on each job that has none of them; a bot's job paused with "Its thread was deleted" runs again. `migrateBotSchedules` also repairs from `bots.db`: a moved job without its bot gets it back, and a schedule the older build removed (after `bots.db.pre-v5` was restored) is removed from the shared store. What the older build changed meanwhile stays; a job it added has no copy.

## No internet

A bot activation (chat lane or run lane) waits when the internet is gone, instead of failing.

- **The check** (`src/mms/bots/activation/connectivity.ts`, the host's `connectivity`): a DNS lookup and a TCP connection to port 443 of the provider's API host (Claude Code `api.anthropic.com`, Codex `chatgpt.com`, a known Pi provider's host) and of two well-known hosts; any one that answers is online. It never calls a model API. A Pi provider on this computer (Ollama, LM Studio) is never checked. Results are reused for 5 seconds.
- **When.** Before each main dispatch is sent (`sendDispatch`). While a dispatch runs, every 20 seconds once it has made no call for a minute; two failed checks in a row end it. At its deadline, when it made no call for a minute. And when its run fails on a connection error (`[provider_unavailable]`, ENOTFOUND and the like; `isConnectionFailure`); with the internet there, that is the provider's own failure and ends the run as before.
- **While it waits** the activation stays `running` with `end_reason` `waiting_for_internet` (no new column, so older builds still read `bots.db`), and holds its lane. Its chat gets one notice, "Waiting for internet. I'll carry on when it's back." (`bm_<activationId>_offline`, at most one per activation), and no error row. The summary's `stateText` is "Waiting for internet" (sidebar row, chat header and status line, `waiting: 'internet'`) while every running activation of the bot waits. A dispatch ended for the internet is charged only up to its last call. Waiting is never a failure, never counts toward the failure streak and never raises an ask.
- **When it is back** (checked after 15 s, then 30 s, then every minute): a dispatch that was never sent is sent; one that ended is continued on the same thread with "The internet connection dropped while you were working; it is back now. Continue." (`continueWith`, `network`), as a restart continuation is, without using the automatic restart allowance. Unknown calls still pause it first.
- **Restarts.** A waiting activation is found by the startup pass: a dispatch never sent is sent again through the same check; one that ended waits again and continues once the internet is back.

## Model and depth

The model is hidden. The definition holds `{mode: 'auto', depth}` or `{mode: 'named', model, depth}`; no client payload carries a model or an instance id, except the instance id of a Sign in button.

- **Resolution** (`src/mms/bots/model/`) runs at each activation's first dispatch. Candidates are the owner's entries that are enabled, signed in, ready, and whose runtime can hold the bot's policy (`harness.canHoldBot`). Depth picks a tier and an effort: `quick` is the standard tier at the lowest effort, `normal` the standard tier at its default, `deep` the frontier tier at the highest. Within a tier, subscriptions (a Claude or ChatGPT sign-in) rank before API keys, then newer models, then the entry's own order (Codex lists its default first). Tiers come from `models.json` and, for models outside the catalog, `src/shared/bots/personal/modelTiers.ts` (Claude Code's `sonnet` is standard, `opus` frontier, `haiku` small); Codex's `default` is standard.
- **Sign in.** A bot with no model and an owner's entry that could hold it once signed in is stuck with Sign in, which opens that entry's card in Settings → Providers.
- **Default bot model** (Settings → Models → Bot model, `settings.botModel`): Automatic by default. Its choices (`settings.getOptions().botProviders`) are the ready models that can hold a bot (`BotModelChooser.holdable`). Resolution order: the bot's own override (`use_model`, `set_depth`), then a named model in its definition, then, when the bot's choice is automatic, this default at the effort the bot's depth gives (`effortFor`). A default that can't run the bot now (signed out, removed, at its usage limit, or refused by `canHoldBot`) leaves the bot on automatic at the same depth, as an unavailable named model does. Model names show on this Settings page only, never on a bot screen.
- **By hand (#673).** By usage stays the default. The owner can pick a model by hand in About → Runs on (`bots.model.set`; `null` is by usage again), saved as a revision with the same grant, and for one automation through `bots.schedules.add`'s `model` when the bot is Who (no screen sets it yet; kept on the job as `bot.model` and set as that run's named choice). The choices are the ready models that can hold a bot here (`bots.model.get`, from `BotModelChooser.holdable`). This picker is the only bot screen that names models. The computer picker offers only this computer until bots can run on another one; the bot's own schedules never name a model.
- **Asking.** `set_depth` and `use_model` take `now` (continue this turn on the new choice) or `always` (saved as a revision with the same grant; chat lane only). A named model that isn't available leaves the bot on auto, and it says so without naming models. Bot instructions forbid naming models or providers.
- **Usage limits.** A bot turn that hits a usage limit fails at the run level and records the reset time. The engine marks that instance limited and tries the next candidate (at most 2 retries per activation). With none left, the bot pauses until the reset (`paused_reason='usage_limit'`) and posts "Paused until 14:00 (your Claude usage limit)", naming the provider family only. Its schedules run again at the reset. This never counts as a failed run.

## States and pausing

States are idle, working ("Waiting for internet" while it waits for it), needs you (an open ask), stuck (an error with one action, such as Sign in or Set up a provider), and paused (`src/shared/bots/personal/state.ts`). "Done" is only an animation of the face.

- **Pause** stops schedules only; chat still works. The owner pauses from the menu (`bots.personal.pause`).
- **Three failed runs in a row** pause the schedules, with one notice. A run that ends done resets the count, even with refused asks. Usage limits, waiting for the internet, stops and chat failures never count.
- **Resume** (`bots.personal.resume`) clears every pause, the failure count and the stuck error.

## Runtimes that can hold a bot

Bots run on the owner's own provider entries, the same ones their chats use, with the sign-ins they already have: Claude Code, Codex and Pi entries. Mousse adds no entry for bots. A runtime holds a bot when its driver says so (`HarnessDriver.botAuthority`) and `checkPolicy` admits the bot's policy (`src/mms/harness/policy.ts`). There are two ways to hold one:

- **Every call (`toolControl: 'exact'`).** Mousse runs or gates each tool itself.
  - **Pi RPC:** Linux, macOS and Windows, with recorded evidence for this platform (`CONTAINMENT_EVIDENCE`, `src/mms/harness/compatibility.ts`). Bot turns run ephemeral: no saved session, history in the prompt, never kept warm, in the locked environment, in a process group of their own.
  - **A locked Claude Code entry** (`profile: 'locked'`), on Linux on a recorded Claude Code version. Mousse no longer creates one; an entry left from an earlier build ("Claude for bots", `claude:bots`) is removed at startup (`removeRetiredBotRunner`).
- **Every approval (`toolControl: 'approval_only'`, `HarnessDriver.botApprovals`).** The bot's permissions answer every approval the runtime raises, through the same check (`BotCheck`) that `BotEngine` builds for Pi: allowed runs; a missing permission is a wall in the chat lane and a refusal with an ask in a run; anything that can't be asked for is refused. Nobody sees a normal approval prompt. The turn runs in the runtime's asking mode whatever the thread or entry is set to (`checkPolicy` refuses a bot policy bound in any mode but Ask), in the bot's files folder.
  - **Claude Code** (`src/mms/harness/claude/locked.ts`, `ownerEntry`): every call goes through the grant gate in Mousse's `PreToolUse` hook and `canUseTool`. The turn uses the entry's own environment and sign-in, but none of the owner's settings files, plugins or MCP servers, offers only the granted built-ins (Bash with "run commands", see above), and is one query that is never kept warm.
  - **Codex** (`src/mms/harness/vendors/codex/botApprovals.ts`): Ask's policy (`untrusted` approvals, no network; the read-only sandbox, or `workspace-write` over the bot's folders with "run commands"). A command it asks about is a `shell` call; a file change is a `write` (a new file) or `edit` call on each path it touches. A change Codex does not describe, or one that would widen where it writes, is declined. Questions to the owner are refused, and the owner's own Codex MCP servers are switched off for the thread; a bot turn does not run when Mousse can't read them.
  - What these runtimes run without asking is not checked: Claude Code asks about every call, but Codex reads files with the commands it trusts and searches the web without asking. Its sandbox keeps those from using the network or changing anything outside the bot's writable folders, but not from reading outside the bot's folders.
- Runtimes that approve tools themselves (`toolControl: 'uncontrolled'`: Cursor, generic ACP agents) can't hold a bot. Neither can other approval-based drivers (Antigravity, ACP presets) until their approvals are wired to the bot's authority.

## The supervisor

Each dispatch's deadline is enforced outside the daemon for the processes a bot turn owns alone. When a runtime reports such a process (Pi's ephemeral bot turns, a locked Claude Code entry), `BotProcessRegistry` (`src/mms/bots/supervisor/`) records the pid and group and starts `bot-supervisor` (`src/cli/fastpath/botSupervisorMain.ts`), a plain Node process, detached. At the deadline it ends the process group (SIGTERM, then SIGKILL after 2 seconds; `taskkill /T /F` on Windows), confirms the exit, and writes a line to `<profile>/bots/supervisor/<dispatchId>.json`, which the daemon folds into `bot_dispatches.exit_at`. A dispatch that settles first stops its supervisor. At startup, `reconcile()` ends the groups of unfinished dispatches.

Claude Code and Codex on the owner's entries report no process: Codex's app-server serves the owner's other chats, and Claude Code's process belongs to the SDK's query. Neither is registered or killed for a bot. At the deadline the turn's signal ends the turn through the runtime's own interrupt (`turn/interrupt` for Codex, closing the query for Claude Code).

## Memory

Mousse keeps an append-only **bot journal** in `bots.db` of everything it sees a bot do and be told. Capped, dated **bot memory** entries, the **chat summary** and FTS5 search sit on top of it. Every activation's first dispatch gets a context pack built from it: the chat pack in the chat lane, the run brief in the run lane. The bot has five tools that are always on and never grantable: `memory_search`, `memory_read`, `memory_list`, `memory_save` and `memory_forget`; runs may only save run notes and never forget. Details: [`bot-memory.md`](bot-memory.md).

## Deleting a bot

`bots.delete` archives at once and purges after 30 days:

- **At once:** activations stop, asks are withdrawn, the grant is revoked, the bot leaves every list, and its threads are settled (archived). Scratch folders go when nothing runs in them.
- **After 30 days:** a daily sweep (`BotEngine.sweepDeleted`) deletes the definition, the threads for good, the chat, the schedules, the files folder and the memory rows (`BotMemoryAdmin.purge`). Run history in the Run Engine database and runtimes' session files are not purged; the log says so.
- There is no restore in Phase 1.

## Where the code lives

| Area | Path |
|---|---|
| Shared types: definition, look, chat rows, chips, states, asks, memory, methods | `src/shared/bots/personal/` |
| Engine: activations, lanes, dispatch, walls and asks, usage pauses, waiting for the internet, delete | `src/mms/bots/activation/BotEngine.ts`, `src/mms/bots/activation/connectivity.ts` |
| Bot UI daemon side: create, chat, About, and what clients see | `src/mms/bots/chat/` |
| Daemon methods (`bots.personal.v2`) | `src/mms/bots/registerMethods.ts`, `src/shared/bots/personal/methods.ts` |
| Store, `bots.db` migrations | `src/mms/bots/store/BotStore.ts` |
| Grant compile, authority | `src/mms/bots/grants/compile.ts`, `src/mms/bots/authority/botAuthority.ts` |
| Model choice | `src/mms/bots/model/` |
| Schedules (in the shared scheduler) | `src/mms/scheduled/botJobs.ts`, `BotEngine.runScheduledOccurrence` |
| Supervisor | `src/mms/bots/supervisor/`, `src/cli/fastpath/botSupervisorMain.ts` |
| Chips | `src/shared/bots/personal/chips.ts`, `src/mms/bots/activity/BotActivitySink.ts` |
| Instructions | `src/mms/bots/instructions.ts` |
| Bot app tools | `src/mms/run/mcp/appTools/bots.ts`, `src/mms/run/mcp/appTools/botMemory.ts` |
| The bot's own browser, its methods | `src/mms/bots/browser/`, `src/shared/bots/personal/browser.ts` |
| Memory and context | `src/mms/bots/memory/` |
| Wiring | `src/mms/MmsProfileServices.ts` |
| Renderer: chat, ask cards, menu, About, New bot, faces, browser preview and split view | `src/renderer/components/bots/`, `src/renderer/stores/botsStore.ts`, `src/renderer/stores/botBrowserStore.ts`, `src/renderer/services/personalBotsClient.ts` |
