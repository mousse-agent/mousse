# Bots that keep going on their own

A bot that works while its owner is away needs five things that a chat assistant does not: nothing that starts it may be lost, its timers must survive a closed laptop, its memory must stay small and true, it must be able to act without holding keys or acting unasked, and it must not ring at 3 AM. This plan says how personal bots get all five while the bot chat stays what it is: a messenger with bubbles, quick replies and one About panel.

**Status:** phases 0 and 1 are built and merged (issues #1288 and #1312; see [What phases 0 and 1 built](#what-phases-0-and-1-built) for where they differ from the text below). Phases 2 to 4 are design. Written against `origin/master` at `0bfd7f476` (15 Nov 2026), where the line numbers below point, and checked again for substance at `2e8a5b9ca` by an independent review, which this version takes in (see How this was decided). The line numbers have not been kept up as the code changed: find things by name. Paths are relative to the repository. Terms are the [glossary](../GLOSSARY.md)'s; how bots work today is in [`docs/bots.md`](../bots.md) and [`docs/bot-memory.md`](../bot-memory.md).

## The request, and the short answer

The starting point was a checklist for always-on agents, written for a cloud agent behind webhooks:

| # | The checklist says | Already in Mousse | This plan adds |
|---|---|---|---|
| 1 | **Event inbox.** A table between webhooks and the agent; acknowledge fast; one worker per user; batch rapid messages | Every start is a `bot_activations` row with a unique key, so a repeat starts nothing; the owner's message commits with its turn. Per bot, one chat turn at a time and up to three runs. Messages sent while the bot answers join that turn (#1168). Wakes on a thread, a pull request or a background command (#1212, #1214) | Two starts that a crash can still lose or double; a reply that is not sent when the owner has already written again; pull request wakes on checks and reviews; later, a page check with no model call, and requests from outside held by Mousse ID |
| 2 | **Timers.** Their own table; one-offs apart from repeating ones; a poller drops due timers into the inbox | One-offs in `bot_reminders` (reminders, work reminders, wakes), repeating ones in the shared scheduler; one armed timer plus a 60 s tick; each fires once by key | One rule for missed time; work that waits for a time or event and goes on in its own thread; a schedule that ends itself; snooze, "until", and repeating lines with no model run |
| 3 | **Lean memory and dreaming.** Store only what can't be looked up; load a small index; tidy stale facts | A complete journal that is searched, not loaded; capped, dated, versioned entries; a Memory dialog | A "where I left off" line per automation; an index of files; retiring an entry without destroying the owner's words; tidying by code, with a model pass only later and only if needed |
| 4 | **Unattended permissions.** No raw keys in the sandbox; risky actions pause for approval without blocking the worker | A grant per bot; asks; work that waits on a question without a run slot; a secret store for threads (#595) | Closing the leaks first; "asks first" for single actions, held and run by Mousse, with Send and Not now; later, one automation allowed to do one thing alone, and secrets for bots, bound to a service |
| 5 | **Outbox.** Queue what goes out, so the agent paces notifications | Tell me levels; quiet runs post nothing; nudges and wakes wait out 22:00 to 08:00 | The chat row is written at once and only the telling is paced: quiet hours for everything unattended, one fold instead of five banners, and later a push to the phone |

So the checklist's tables mostly exist under other names. The plan adds **no inbox table, no timers table and no outbox table**. What it adds is the behaviour those tables were meant to buy, where it is missing.

What it does not reach is said where it applies, and in one place: "What asks first does not cover" under Unattended permissions. A computer that is off runs nothing; requests from outside wait for phase 4; and on a computer where a bot's commands are not held by a sandbox, no approval rule can hold them.

## Principles

1. **A row that exists is not built again.** The activation is the inbox, `bot_reminders` and the shared scheduler are the timers, `bot_messages` is the record. New state is a column or a key beside what is there, and a new table only where nothing holds the thing (`bot_actions`).
2. **The owner's surface does not grow.** Everything new appears as something that exists today: a card in the ask's look, quick replies, a quiet line, a row in About. No screen, no settings page, no form. Most of it shows nothing at all.
3. **Who started a turn limits what it may do, and never widens it.** The owner's own message, a turn the bot started for itself, and a run nobody is watching are three different things, and Mousse knows which is which without asking the model. That says who started a turn, not that every later step is what the owner wanted, so no approval depends on it.
4. **Text from outside is data.** A page, a command's output, a pull request's title or a request's body never reads as instructions, as the owner's words or as Mousse's.
5. **Everything waits in the database and fires once.** After a restart, a sleep or a week away, each thing that was due happens one time and says what time it was for. Never a backlog.
6. **The chat is the record; telling is separate.** A message is written when it happens, in order. Whether it rings, and when, is decided afterwards.

## What the owner will notice

This is the whole visible change, across all five capabilities.

**In the chat**

- **One reply instead of two.** "hi" then "check the flat" gets one answer, not "Hi! What can I do?" followed by a second.
- **Snooze.** A reminder carries quick replies: In 10 min · In 1 hour · Tomorrow 9:00 (on this computer's clock).
- **Late, and saying so**, when a report is more than 15 minutes late: "(Due 09:00, this computer was off or asleep) Here's your morning summary…"
- **A bot that stops by itself.** "It's ₹5,400 now. I've stopped checking."
- **Work that comes back.** "Not shipped yet; I'll look again at 16:00." The work line reads "checks again at 16:00", and the same work reports later.
- **An approval card**, in the ask's look, when the bot is about to do something that changes things outside its own folder:

  > **Kai wants to send this email** · from you@example.com, with Gmail · **To** landlord@example.com · **Subject** Flat B viewing · the whole message, folded after six lines · **Attached** floorplan.pdf · Kai: "You asked me to book the viewing." · **Send** · Not now

  Two buttons. There is no "always" on it.
- **A secret card**, in the same look, with a masked field, named for the service: "Your Stripe key. Kai can use it with Stripe only."
- **A quiet line before sending** when the owner pastes something that looks like a key: "This looks like a key. Keep it as a secret?" The text has not left the composer yet.

**In About**

- One plain line per service, in the words of what it does, never tool names: "Gmail · asks you before it sends or deletes". Where the owner let one automation act alone, that is a line of its own with Remove: "‘Sort new scans’ files into Scans without asking".
- A secret is part of its service's line: "Stripe · uses your Stripe key", with Remove.
- "Tells you: quiet 22:00–08:00 · only what needs you", shown only when it differs from the defaults.

**Outside the app**

- Nothing rings at night except a reminder the owner set for that time, or a bot they said may wake them. A failed run always tells, whatever the level.
- Five reports that land together are one banner.
- The dock badge counts bots that need the owner.

**By saying it**

"Don't ping me at night." "This one can wake me." "Only tell me if it's urgent." "Remind me again in an hour." "Check daily until it's under ₹5,500." "Let the scan sorter file things without asking." "What did you put away?" "Put back the one about my gym times."

## How it fits together

```
 what happens                    what is kept                         what runs            what the owner gets

 owner's message ─────────┐
 tap, answer, approval ───┤
 reminder · wake · wait ──┼──►  bot_activations  ───────────────►  chat lane (1)  ──►  bot_messages  ──►  telling
 schedule (shared store) ─┤     one row per start, unique key       run lane (3)       the record,        paced: banner,
 event: thread, PR, ──────┘            ▲                 │                             written at once    sound, badge,
 command, page                         │                 ▼                                                phone
                                       └──── parked work, no run slot ◄── waits on: your answer · your approval ·
                                                                          more room · a usage limit · a time or event
```

Sources never start a turn themselves. Each inserts an activation by key, so a repeat inserts nothing. Work that must wait leaves its run slot and comes back through the same queue. Every message the bot writes goes through one post, and the telling is decided there.

## Shared pieces

Six things are built once and used by all five capabilities.

### 1. Who started a turn

Every way a bot's turn starts, and what that turn may do. The mapping is one exhaustive switch over the activation's key and trigger, with no default branch that allows: a new kind of start is treated as the strictest row until it is given one.

| Started by | Key | Counts as the owner's own words: may act on the owner's threads, pick a model, change how the bot tells | May save facts about the owner and standing notes | A reminder it sets rings at night |
|---|---|---|---|---|
| The owner's message | `chat:`, `chat:after:` | yes | yes | yes |
| A tapped answer | `answer:` | no (the label is the bot's) | yes | yes |
| The bot's own chat turn: its first message, a wake, a question's default | `create:`, `wake:`, `question:…:default` | no | no; it saves run notes, shown as data | no |
| Work, and a reminder's work | `work:`, `reminder:` | no | run notes only (as today) | sets none |
| A scheduled run | `sched:` | no | run notes only | sets none |
| A run by hand | `manual:` | no | run notes only | sets none |
| A consult, a subagent | none of its own | no | no | sets none |

The first column exists today (`ownerChatTurn`, `BotEngine.ts:8409`). Two things are new:

- **Facts about the owner need the owner.** Today any chat-lane turn saves them (`BotMemoryStore.ts:626`), a wake's turn included, and that turn has just read a command's output or a pull request's title. They are saved only in a turn the owner's message or tap started.
- **Who set a timer is stored** (`owner_set`), from the same two rows.

A turn another device's message started keeps that device's limit, as today, and an approval is answered under the limit of the device that answers it.

Starting from the owner's message says who started a turn. It does not say that every later step is what the owner wanted: such a turn reads the bot's own reports, which may have read a web page. So this plan gives an owner's turn nothing it lacks today, and no approval is skipped because of who started the work.

### 2. Data frames

Text from outside enters a turn inside a frame with fixed markers, in which the end marker is escaped so the text cannot close it: `[output]…[end of output]` for a background command today (`wakes.ts:46-47`, `:127`), and `[data from <source>]…[end of data]` for the other kinds. Fixed markers are what the journal can recognise. Three things change:

- **The journal marks it.** Today a turn's request is journaled as a notice from Mousse (`capture.ts:150`), and `run_start` stores the trigger's input again (`BotEngine.ts:1714`), so a command's output or a pull request's title is filed as Mousse's own words and comes back so through `memory_search`. Capture and `run_start` strip the frame and write its content once, as a row marked `external` and keyed by the frame (`frame:<activationId>:<n>`), so both writers and a later recapture insert it once, search shows it as data, and a Forget that redacted it stays redacted.
- **Rows from before** are never captured again, so a one-time pass marks as `external` every notice and `run_start` row that holds a frame. It finds text by today's markers, so it is a best effort, not a proof; wakes and background commands, the only carriers so far, landed days before this plan.
- **What a bot writes down keeps where it came from.** A frame labels a source. It does not stop a model from repeating what was inside it into a note, a brief or a left-off line. So everything a bot derives stays data when it is read back: run notes, work briefs, left-off lines and reports are shown to later turns as notes, never as instructions, and facts about the owner are saved only where shared piece 1 allows.
- **Anything larger than an excerpt** (a changed page, later a request's body) is written to a file in the run's scratch folder and named in a framed line. No runtime takes a tool result in a first prompt; the run reads the file, and that read is journaled as an external tool result with no new tool.

### 3. One way for work to wait

Today work waits without a run slot for three reasons, on three code paths (`parkForQuestion`, `budgetEnd`, `usagePause`). The plan adds two reasons and makes the path one: `park(row, reason)`, one readiness check, one switch in `resumeWork`, one table of rules for `settleStrandedWork` and the work line.

| Parked as | Woken by | Stranded when (ends with a line) | Work line |
|---|---|---|---|
| `question` | a tap, a reply, a default | the question is forgotten | waiting on you · Which flat…? |
| `approval` (new) | Send, Not now, expiry | the card is withdrawn, the grant revoked | waiting on you · Send the email? |
| `budget_exhausted` | Allow | no open ask for the limit | waiting on you · more time |
| `usage_limit` | the reset time, Resume | no reset time | paused until 14:00 |
| `waiting` (new) | its timer or event | the timer row is cancelled | checks again at 16:00 · waits for acme/app#12 |

Today only work can wait (`workWaits`, `BotStore.ts:389-390`). A scheduled run may park for one reason, an approval, and the schedule's skip check, which reads only running and walled runs (`holding()`, `BotEngine.ts:1425`), must count a parked run of the same schedule too.

Every parked piece ends after a week. A free run slot goes first to what the owner just unblocked (an answer, an approval, more room), then usage-limit resets, then waits that are over, then the queue in today's order.

### 4. What is due next

`armDue` today reads only `bot_reminders` and `bot_questions.next_at`. One function, `nextDueAt(botId)`, returns the soonest of: reminders, wakes and waits; question follow-ups; approval follow-ups and expiries (`bot_actions.next_at`, `expires_at`); tellings to release; and schedules' next times. The engine's one timer arms on it, and "is this bot idle?" (nothing queued, running or ready, and nothing due within 30 minutes) is answered from it.

Each path that fires goes through one step, `fireDue({ botId, key, kind, dueAt, lateMs, missed?, ownerSet })`, which checks the bot's state, labels lateness and inserts the activation or the fixed line under today's keys.

### 5. Two clocks

Two clocks are kept apart on purpose. Configured quiet hours now use `OwnerQuietHours`; schedules and saved reminder times retain the computer clock:

- **Quiet hours follow the owner.** `ownerZone()` is the zone of the device the owner used last, sent at most once a minute through the optional `app.presence.v1` method while a Mousse window is focused and the system is not idle (a phone's parameters are exact keys, so an extra field on every call would be refused by an older computer), with this computer's zone as the fallback. `quietHoursFor(botId)` is the only place quiet hours are read: question follow-ups, bot tellings and personal automation silence use it. Wakes, reminders, approvals and scheduled work still run when due; their telling is paced.
- **Saved times stay on the computer's clock.** Cron is read in the service's zone, as for a person's automations, and the Automations page shows that zone. If "every day at 9" followed the last device, a schedule would move each time the owner picked up the phone, and a move across midnight would run twice or not at all. Phase 4 adds a settled zone (one the owner's devices have shown for 12 hours, applied once) for reminders set with a local time.
- **One rule from phase 0:** `reminderTime` (`appTools/bots.ts:1215`) reads "at 9" in the same zone the pack's "Now:" line names (`contextPack.ts:166`), or the reminder lands hours off.

### 6. One shape for a bot's automation

```
ScheduledJob {
  schedule: cron | interval                  // when
  prompt: string                             // what a run is asked; "Say exactly: …" when bot.say is set
  expiresAt?: string                         // "until": a field older builds already know
  tellMe?: TellMe
  bot: { botId, scheduleId, createdBy,
         ownerAsked?: true,                  // added in a turn the owner's own message started
         say?: string,                       // a fixed line, posted with no model run
         onlyIfChanged?: { url, contains? }  // a check with no model call before each run
  }
}
```

Everything new sits under `bot`, because `jobs-kept.json` keeps that field whole when an older build's save drops what it does not know (`ScheduledJobStore.ts:229`); `restoreDroppedFields` must also merge missing keys into a `bot` that survived. An older build runs a `say` job as a prompt that says it, and ends an `until` job at its time. The "where I left off" line and the page's last hash live in `bots.db`, never in `jobs.json`, so Forget and search reach them and a file rewritten every tick stays small.

About → Runs and the automation card word each combination: "Inbox check · every weekday 09:00", "Says “Take your pills” · every day 08:00", "Tickets page · checks every 15 min · tells you when it changes", with " · until Fri 21 Nov" appended.

## 1. Event inbox

**As built.** Every start is a row with a unique key, so a repeat inserts nothing. How each is kept differs:

| Start | Key | How it is kept |
|---|---|---|
| Owner's message, from any device | `chat:<clientRequestId>` | one transaction: the message, its journal row, and its turn or its joining a turn (`BotChatService.ts:544-597`) |
| Tapped answer | `answer:<id>` | one transaction with the question answered |
| Wake; a question's default | `wake:<id>`; `question:<id>:default` | one transaction with the wake settled or the question defaulted |
| Text reminder | `bm_<id>` | one transaction: the line posted and the reminder delivered |
| A reminder's work | `reminder:<id>` | two writes, the activation and then the reminder (`BotEngine.ts:7672-7673`); the key makes a repeat insert nothing |
| Scheduled occurrence | `sched:<bot>:<schedule>:<at>` | two stores: a claim in the shared scheduler, then the activation; the key makes a repeat insert nothing |
| `work_start` | `work:<chatActivation>:<toolCallId>` | one insert. **Gap:** with no `toolCallId` the key is random, so a turn continued after a crash can start the same work twice (`appTools/bots.ts:782`) |
| Creating a bot | the create request's key | two writes, the bot and then its first turn (`BotChatService.ts:320-321`). **Gap:** a crash between them leaves a bot with no first message, and a retry finds no turn and can make a second bot |
| Run by hand | `manual:<clientRequestId>` | one insert |

**One worker per bot, not per owner.** A bot runs one chat turn at a time and up to three runs beside it, on purpose, so the owner can always talk to it. Turns of one bot share three things, each with its own rule: memory (safe: each save is a transaction, and a repeated text returns the entry it already has), the bot's browser (steps are serialized, tabs belong to one activation, sign-ins are shared), and the files folder (the rule below).

**Decisions**

- **No inbox table.** A second table in front of `bot_activations` would hold the same rows.
- **Close the two gaps.** Creating a bot records its request key with the bot in one transaction, so a retry returns the same bot, and the startup pass queues a first turn that is missing. `work_start` gets a stable key when the runtime gives no tool call id.
- **Hold a reply the owner has already overtaken.** The failing case: "hi" starts its turn at once; "check the flat" arrives two seconds later and joins it as a note; a front-desk turn that calls no tool has no next step for the note to land in, so "Hi! What can I do?" is posted (`BotEngine.ts:4428`) and a continuation answers the rest. The rule: when a chat dispatch ends with joined owner messages it has not read, and it called no tool other than memory and cards, its text is not posted. The continuation gets it back as "your draft, not sent" and answers everything in one reply. The draft is kept as `draft:<activationId>` in `bot_memory_state`, because the activation's result is overwritten when the continuation ends (`BotEngine.ts:4406`). If the continuation fails or is stopped, the chat lane's one end path posts the draft, unless a later reply of the activation exists; `postMissingReplies` covers turns that ended cancelled or failed across a restart; the key goes when the combined reply posts. So a reply is still never lost. This adds no delay to a single message and needs no change in the apps. A collect window was rejected because it delays every first message; a "still typing" signal can come later, only to save the one wasted short call.
- **Join only when the device and its limit both match**, as the comment on `chatTurnToJoinInTx` says (`BotEngine.ts:6922`); today only the limit is compared.
- **Wakes grow; standing triggers wait.** A wake on a pull request gains `on: 'merged' | 'checks' | 'review'`. A `checks` wake fires when every check on the current head has completed, with the pass and fail counts and the failed names as data; it needs the checks' state from the pull request read (`wakeSources.ts`).
- **Files changed by two turns.** The chat and its work are told to keep the same list files, and nothing stops a lost update. On Pi, the authority records each file's hash when it is read and refuses an edit to a file that changed since; Claude Code's own Edit already refuses that; and the instructions say to read a list just before changing it, in one edit.
- **A general "whenever X, do Y" engine is not built.** A schedule that runs as often as every minute, posts nothing when there is nothing new, and keeps a "where I left off" line covers it, at the cost of a model run per check. Requests from outside, files landing and MCP events come when someone needs them (phase 4), as rows in a `bot_events` table in `bots.db` keyed by the sender's own id, never in `jobs.json`.
- **"Tell me when this page changes" without a model run per check comes in phase 3**, because its protocol has to be exact or it loses a change. `onlyIfChanged` puts a check in front of a schedule:
  - **State** is kept per schedule in `bots.db`: the schedule's generation, the hash last handed to a run, the check in flight, and how many checks in a row failed.
  - **The first check** records the page and starts no run.
  - **The fetch** is made by Mousse under the same rules as a secret's request (a public address, checked and then used; no redirect to another host), with no secret. `runScheduledOccurrence` starts it and answers "not ready"; the next tick reads the result.
  - **Unchanged:** the occurrence is skipped as `unchanged`: no activation, no run in the automation's list, no model call.
  - **Changed:** the changed text is written to a file, and then one transaction inserts the run, which names that file, and moves the handed-over hash. A crash before it leaves the old hash, so the change is seen again; a crash after it leaves a run that holds the change. A run that then fails is told as a failure, so a change is never lost silently.
  - **A result for an older generation** (the schedule was edited or removed while the page loaded) is dropped.
  - **A page that can't be read** six times in a row, or for a day, is told once ("I can't read the tickets page any more: it asks me to sign in") and counts as a failed run. It is never skipped in silence for ever.

## 2. Timers

**As built.** Three one-off kinds in `bot_reminders` (a text reminder, a reminder that starts work, a wake) plus question follow-ups in `bot_questions.next_at`, on one armed engine timer with the 60 s tick as backstop; repeating ones as jobs in the shared scheduler. Only the chat sets reminders, wakes and schedules (`appTools/bots.ts:481`); work sets only a question's follow-up, by asking.

**Decisions**

- **Keep the split.** Schedules were moved out of `bots.db` on purpose, so one scheduler, the Automations page, Tell me and Needs you serve bots and people alike; one-offs need `bots.db` transactions with messages and activations.
- **One rule for missed time.** A timer fires at most once for all the times it missed, as soon as Mousse runs, and says the time it was for: to the bot always, and to the owner when it posts more than 15 minutes late. Today every kind does this except a scheduled run, which is caught up silently: the claim knows it was missed (`ScheduledJobStore.ts:383`) and the run is never told (`ScheduledJobService.ts:864`). The run's brief gains "This run was due at 08:00; this computer was off, and 3 runs were skipped."
- **Catch up only while it still makes sense.** An occurrence missed during downtime is run only while now is closer to the missed time than to the next one. A daily 09:00 briefing opened at 15:00 runs, labelled late; opened at 22:00 it waits for tomorrow, and the automation shows "Missed Tue 09:00 (computer off)". A five-minute check never bursts after a night: its next run is within five minutes anyway. The rule applies only to downtime, never to a run a busy tick delayed.
- **Work waits; it does not wake the chat.** `work_wait({ inMinutes | at | thread | pr, why })` parks the work (shared piece 3) and it goes on in its own thread, with what it saw and its tools. Waking the chat would lose both, since the chat has no web. The work's own time and turns are the main cap; beyond that, one wait at a time, 5 minutes to 7 days each, 20 per piece of work, and waits share the bot's 30 a day with wakes. A wait is a `bot_reminders` row stored as a wake with a `work_id`, so today's timer and event checks see it (`waitingEventWakes` reads only wake rows); `deliverWake` branches on `work_id` and resumes the work instead of starting a chat turn; stopping or ending the work cancels the row in the same transaction. A resumed piece of work disturbs nobody, so it is not held at night; its report's telling is.
- **A schedule can end itself.** `schedule_done({ why })`, for a scheduled run only, removes the schedule the run belongs to and posts one line. That is how "check daily until it's under ₹5,500" ends.
- **A wake set by the chat stays as built**, with its chain of 5.
- **Small things the owner asks for.** Snooze as quick replies on a text reminder (`bots.reminders.snooze` writes a new row, no model run, works from a phone). `until` on a schedule. `say` on a schedule: a fixed line with no model run, which also works when every model is at its limit.
- **Who set it is stored, not guessed.** `bot_reminders.owner_set` and `bot.ownerAsked` are true only when the turn that set the timer was started by the owner's message or tap (shared piece 1). That is the strongest thing Mousse can know: it does not prove the owner asked for that hour, only that the bot's own follow-ups, which are wakes, never ring at night. A reminder the owner set rings at its time, at night too. One the bot set for itself is still written on time; only its telling waits.
- **Not built:** waking the computer (it needs administrator rights), keeping it awake, jitter (owners mean "at 9", and starts are already spread by slots), random times.

## 3. Lean memory and tidying

**As built.** The journal holds everything and is searched, not loaded. Every turn gets all active owner facts and notes (at most about 2,000 tokens), run notes (500), a chat summary (1,000) and the recent chat (4,000 to 8,000). That is small enough to load whole. What is missing:

- **Nothing can retire an entry.** An entry leaves only by a new version, an expiry date or Forget, and Forget redacts every journal row holding its text, the owner's original message included (`BotMemoryStore.ts:707-733`). So "merge these two" can't be done without destroying the owner's words.
- **Run notes fill and stay full.** About ten notes fit; a daily schedule fills them in ten days, and then every save fails and the old ones load into every prompt forever.
- **A quiet run leaves no cursor.** Since a run with nothing new posts nothing, "the last 3 reports" of a schedule are the last three with news, perhaps weeks old.
- **A wish over the cap is dropped silently** (`standingWish.ts:95`).
- **A correction reorders memory.** A new version gets a new `learned_at`, the pack orders by it, and the cached prefix breaks from that line on.
- **A held-back secret can be read back.** The pack's marker says `memory_read j12 shows it` (`chatSummary.ts:36`), and it does.

**Decisions**

- **"Where I left off."** `run_report` gains an optional `leftOff` (600 characters). Reports are kept in the automation runs' own database (`AutomationRuns.report`), which Forget does not reach, so the line goes through a hook to the bot's store instead: `progress:<scheduleId>` in `bot_memory_state`, with a journal row marked as written by an unattended run. Every run writes it, quiet ones too (a run that ends with `[SILENT]` makes no `run_report` call, so the instructions say to report quiet instead). Only that schedule's own next run gets the line in full, after its reports, as data; the chat keeps today's list of schedules with their next times and reads a left-off line with `bot_schedule_list` when the owner asks. Run notes stop being spent on cursors. A one-off instruction for a schedule stays the owner's own row, which the run pack already finds; the line only counts it down and cites that row ("also check X (j812): 3 digests left"). Forget clears a `progress:` value that holds a forgotten text or cites a redacted row, and removing the automation removes the key.
- **Retire without Forget.** `memory_save` gains `merges`: current entries of the same kind that the new one absorbs, each superseded in the same transaction with its text kept. An unattended run can free its own run notes this way.
- **An index of what is not loaded**, in the volatile end of the pack, at most 300 tokens: the twelve newest files in the files folder by name and date, then "and 14 more" (no content: a first line copied from the web would sit in every prompt), and "1,240 messages since 3 Oct; `memory_search` finds any of them". The rest is looked up with the tools the bot has. The instruction to spend one note per list goes.
- **Tidying is code, and narrow.** In `maintain`, when the bot is idle: expiry dates, as today, and retiring an exact duplicate (the same hash) across kinds, keeping the owner's entry over a note over a run note; within a kind, keeping an entry the owner wrote or edited by hand first, then the oldest learned date and id. Nothing else is safe to decide in code. Near duplicates are not: "Gym Tuesday 7pm, back by 9" and "Gym Wednesday 7pm, back by 9" pass today's near-duplicate test (`standingWish.ts:65-75`), and one of them is the correction. "The file a note names is gone" is not either: an entry is free text with no link to a file (`memory/schema.ts:55-70`), and with files listed in the index, notes that only point at a file stop being written.
- **A model pass is not in the first three phases.** A past date does not make a fact stale (a finished treatment still matters), so only a model can judge it, and a model can judge it wrongly. If the counters show that stale notes are a real problem, the pass is built last and small: called only on candidates code finds, for notes and run notes only, never facts about the owner; it may only retire an entry that a newer entry it cites contradicts, or set an expiry at a date written in the entry; each change is a new version with the old text kept, so "put back" works and a forgotten text stays forgotten.
- **What the owner sees:** nothing. The bot answers "what did you put away?" and "put back …" with tools it already has. The owner-facing words are "put away" and "put back", never "dreaming".
- **Repairs:** keep `learned_at` across versions; count saves refused at the cap and say so in the next chat turn ("My notes about you are full; tell me which to drop"); mask credential shapes in `memory_read` and search snippets too, and drop the pointer from the marker.

## 4. Unattended permissions

### Secrets

**As built.** The secret store (#595) is for threads: values in `<profile>/secrets/refs.json` (mode 0600), a masked card, use by name through `secret_run`, masked output. Bots have none of it (`BOT_OFFERABLE_APP_TOOLS`, `manifest.ts:199`). Four things are wrong today, before any bot secret exists:

1. **The owner's environment reaches a bot's commands.** Claude Code's sandbox denies only the three Claude variables (`harness/claude/locked.ts:67`); any `GITHUB_TOKEN`, `OPENAI_API_KEY` or `AWS_*` in Mousse's environment reaches a bot's Bash, which can print it to the model. Pi inherits the provider's key too.
2. **A background command runs outside every sandbox**, by design and as documented (it needs the network and the owner's sign-ins for `gh run watch`). So it reaches what the owner's account can, the secrets file included, and the end of its output goes into the bot's next turn.
3. **Any chat turn can start one**, a wake's turn included (`appTools/bots.ts:930` checks only the lane). A wake's turn has just read a command's output or a pull request's title, so text from outside can lead to a command that no sandbox holds.
4. **A secret pasted into the chat** is journaled, and the marker that holds it back tells the bot how to read it again.

**Decisions**

- **Close these first, in phase 0.** A bot's turn on the owner's entry starts from the locked environment plus the sign-in variables, not the owner's whole environment (`ClaudeSubscriptionProviderService.ts:2839-2842`; Bash inherits the Claude Code process's environment, so that is where it is fixed), with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Sandboxed Bash has no network, so `gh` and `aws` never worked there and little breaks. A background command starts only in a turn the owner's own message started. Held-back secrets stay held back in `memory_read` and search.
- **No secret where commands are not held.** On Pi, on Windows and on Linux without bubblewrap, a bot's commands run as the owner. There a bot that may run commands is not offered a secret, and a bot that holds a secret is not offered "run commands"; each is refused in plain words that name the other. Before the first bot secret (phase 3), a background command of a bot that holds a secret runs in the same sandbox as Bash on Linux and macOS (this needs `@anthropic-ai/sandbox-runtime`, which Mousse does not ship yet), or is refused. What stays a promise is said in the last part of this section.
- **A bot holds a name; Mousse holds the value.** The checklist's "outside proxy" is, in the first version, a tool Mousse runs: `secret_fetch({ secret, method, path, query?, headers?, body? })`. The bot never writes the value anywhere: Mousse adds it, in the one place fixed when the secret was saved.
- **A secret is bound to more than a host**, when it is saved:
  - an `https` origin (host and port) and nothing else;
  - where the value goes: one header, in a fixed format. Never the address, never the body;
  - for a service Mousse knows (Stripe, GitHub, Notion, OpenAI and the like, from a table), the paths it may reach. The card names the service, and the owner never reads a host name; for a service Mousse does not know, the card shows the host;
  - whether it may change anything: "read only" (GET and HEAD; anything else is refused) or "may change things" (anything else asks first, every time).
- **The request is made so that the binding holds.** Mousse resolves the host, refuses a private or loopback address, and connects to the address it checked, so a second lookup can't move it. It follows no redirect: the bot gets the redirect back as the answer. The value is cut from errors and logs. The response is masked and framed as data; masking is a second line, since an address that echoes a request back could return the value in a form no mask knows. A GET is not proof that nothing changes; the known services' path lists narrow that, and for an unknown host it is a risk the card's "read only" does not remove.
- **Asking is an ask.** The secret card is an escalation in the bot chat: durable, one per name, counted with the ask caps. A run that lacks the secret is refused and carries on, as with any ask. The value is typed on the computer that holds the bot; a phone shows "Type this on the computer that runs Kai."
- **Not covered:** command-line tools and SDK scripts. Those wait for Claude Code's masked variables (a per-session sentinel that its sandbox proxy swaps for the real value on listed hosts only), on Linux and macOS, in phase 4.

### Asks first

**As built.** A permission is all or nothing per kind: once the grant holds a tool, the bot never asks again (`authority/botAuthority.ts:94-114`). `ask_owner`'s "yes" grants nothing and binds no arguments.

**Decisions**

- **A third level beside allowed and not allowed: asks first.** It is stored in the grant beside the allowed tool, so About, Remove and approval work unchanged.
- **Mousse decides what asks first, and when it can't tell, it asks.** An MCP tool that says it is read-only does not ask. One with no hints does not ask when its name starts with a reading word (get, list, search, read, find, fetch, show, describe, query, count). Every other MCP tool asks. `secret_fetch` asks for anything but a read, when the secret may change things at all. MCP tools and `secret_fetch` exist only in work and runs, so a chat turn never meets a card of this kind.
- **Mousse holds the call and runs it.** The deferred tool call of Claude Code was considered and rejected: it works only when a turn makes a single call, only in one runtime, and needs sessions kept on disk. The calls worth holding are ones Mousse already runs itself (`callForBot`, the app-tool registry). So Mousse stores the exact call in `bot_actions`, the work parks as `approval` without a run slot, and on **Send** Mousse makes the stored call and the work goes on with its result.
- **What a held call is bound to**, so that Send does exactly what the card showed and does it once:
  - **One row per call.** The row is unique on the activation, its dispatch and the runtime's tool call id, so a call the runtime makes again returns the same row and the same card.
  - **The arguments as they will be sent** are kept exactly, apart from the masked copy the card and the journal show, and are cut down to the masked copy once the call has settled.
  - **What it was approved against:** a digest of those arguments, the MCP server as installed and the tool's schema, the bot's grant revision, the schedule's revision if a schedule asked, and the limit of the device that started the work.
  - **Send is a compare-and-set.** It names the row and the digest the card showed. It is refused, and the card redrawn, when the row has expired, was withdrawn, or any of those bindings has changed since ("This changed since you saw it"). A phone's Send names them too, so a stale phone can never approve a different email.
  - **Run once.** `open → approved → running` is committed before the call; then `done`, `failed` or `uncertain`. A call left `running` by a restart becomes `uncertain`, is never made again, and the bot is told to check first. A tool that takes an idempotency key is given the row's.
  - **Withdrawn with what it belongs to**, in the same transaction: a Stop of the work, a Forget of the card or of the message that asked for the work, the removal of the schedule, the removal of the tool or the grant, the deletion of the bot.
- **The card** is drawn by Mousse from the stored arguments and is complete: every recipient, the account it goes from, attachments by name, the whole text behind a fold. The bot's sentence is secondary and marked as the bot's. It has **Send** and **Not now**, and there is never a default yes. Afterwards it reads "Sent · 09:14", "Not sent", "Expired · not sent" or "Couldn't tell if it went through".
- **How long a card is good for counts from when it was posted**, never from when the owner was told, so holding a banner at night cannot make an old action live longer. Work's cards are good for 48 hours. A schedule's card is good for one gap of its schedule, and at least an hour. Telling is separate: the first nudge counts from when the owner was told, at most two, and not at night. Expiry fires on the engine's timer (shared piece 4), and Send checks it once more.
- **A scheduled run waits too.** It parks like work, so a sequence (draft, send, record) stays whole. An occurrence that falls while a run of its schedule is parked, or still finishing after its card expired, is skipped with today's reason ("the bot is waiting for your answer"). So while a card waits unanswered, a schedule runs at most about once an hour, even one set to every minute, and its left-off line lets the next run catch up. An expired card becomes a quiet line, "Expired · not sent", and expired lines of one schedule in a row fold into one, so after a night of hourly runs the owner finds one card and one line, not six cards.
- **No "Always allow this".** Work the owner asks for in the chat asks each time: the owner is there. The earlier drafts of this plan had a broad Always, then one limited to destinations approved before; both were dropped, because a place the owner approved once can be a shared folder or a mailing list, and what is sent there can be shaped by what the work has read.
- **One automation may be let to do one thing alone, in one place** (phase 3). The owner asks for it in their own turn ("let the scan sorter file things without asking"), and the answer is an ask in the ask's look: "Let ‘Sort new scans’ upload to your Scans folder in Drive without asking?" · Allow · Not now, on the computer only. What is stored is that automation, that tool, and the place as named arguments with their exact values, taken from a call the owner has already approved. A later call from that automation to that tool with those values runs; anything else asks. A tool with no argument Mousse can read as a place can't be let alone.
- **Caps where the calls are made.** Every call in these classes, held or let alone, writes a `bot_actions` row. Over 20 an hour per tool or 100 a day per bot, a call that would run alone becomes a card: "Kai has uploaded 20 files this hour. Upload this one too?"
- **From a phone:** Send and Not now, from any device that reaches the bot. A notification names the action, never its content.

### What asks first does not cover

Said plainly, because a card that seems to cover everything is worse than none.

- **Commands, where no sandbox holds them.** On Pi, on Windows and on Linux without bubblewrap, a bot that may run commands can do anything the owner's account can, card or no card. That is today's "run commands" there, and this plan does not change it; it only refuses secrets to such a bot (above) and puts the choice to the owner (open question 1).
- **The bot's browser.** Whatever the owner signed the bot's browser in to, the bot can act on there, and Mousse can't tell a click that reads from one that buys.
- **What is sent.** An automation let alone always goes to the same place, but what it puts there can be shaped by what it read, and a shared place is read by everyone it is shared with.
- **The owner's threads.** Starting, messaging and stopping a thread keep today's rule: one permission, only in a turn the owner's own message started, with no card per thread (`docs/bots.md`, Use your threads, "The risk that remains").

## 5. Telling

**As built.** A bot's message and telling class are written in one transaction. The service releases unread rows through `bots.tell`, folds nearby reports, caps sounds, and catches up when a window opens. `bots.message` remains the chat push and the compatibility path for older windows. Quiet hours are off unless configured. Configured quiet hours hold soon bot tellings and question follow-ups, follow the owner’s last reporting device zone, and silence personal automation banners without holding them. The phone has no push at all: it learns of a message only while the app is open. Verified defects are listed under Repairs.

**Decisions**

- **The row is the record; only the telling is paced, and it is kept in the service from the start.** An earlier draft held banners in the app's main process first, in memory; that was dropped, since a restart would lose them and the next phase would replace it. Holding or folding messages themselves would reorder the chat, hide an ask the owner could answer now, and let devices disagree. So nothing is ever queued in the chat, and there is no "while you were away" row.
- **Three classes**, decided in the post's transaction from who started the turn (shared piece 1):

  | Class | What | In quiet hours |
  |---|---|---|
  | now | a reminder or line the owner set for that time (`owner_set`, `ownerAsked`); replies, asks and questions in an owner-started chat turn | rings |
  | soon | reports at or above Tell me; asks, approvals, questions and errors from runs nobody is watching; wake replies; nudges | held unless the owner is active or the bot can wake them; still soon, folded and sound-capped |
  | later | below Tell me; "waiting for internet"; "Sent" lines; dropped-run lines | never rings; counted in the fold |

  Service lines (a wake's "Following up", "You let Kai use the browser") tell nothing. A failed run always tells, whatever Tell me says, so the strictest level never hides something the owner has to repair.
- **"Active" replaces "waiting".** A telling breaks quiet hours when the owner was active on any device in the last 15 minutes. Mousse measures that, so nothing a bot read can fake it. The service runs apart from the app's windows and today sees only what reaches it (a message sent, a tap, a chat marked read); window focus and system idle time exist only in the app. So the app reports them through a new optional method, `app.presence({ activeAt, timeZone })`, at most once a minute while active, and the phone uses the same method in phase 4. Work asked for at 21:30 that ends at 00:30 does not ring; "tell me when it's done, even at night" marks that one piece of work.
- **Quiet hours are off unless the owner sets them.** The service telling foundation (B11) holds nothing at night; B14 adds configured quiet hours and reads a bot’s “can wake me” wish. What was held is released as one fold at the end of quiet hours or the first time the owner is back, whichever comes first: "While you were away: Ledger needs you · Scout 2 updates". On a laptop that slept all night nothing ran and nothing was held: missed schedules catch up on opening the lid, and their reports arrive while the owner is there, as one ordinary banner ("Scout, Ledger · 4 messages"). A late catch-up report never counts as now.
- **Outside quiet hours:** the first telling goes at once; others within two minutes fold into the same banner; at most one sound per bot every 10 minutes and six per profile an hour.
- **Two wishes, not a settings page.** *Quiet hours* (for the profile, with "can wake me" on a bot or an automation as the exception) and *Tell me* (the same four levels as an automation's, now also on the bot, for work reports, wake replies and errors). "Only tell me if it's urgent" sets the bot and its automations to Needs you. The bot sets them with `telling_set`, callable only in a turn the owner's own message started, so nothing a bot read can make it ring at night. The wish is a setting, not a memory entry: the wish fallback counts a `telling_set` call as handled, and the pack's situation shows the line About shows.
- **Messages to anyone else are not the outbox's.** An email or a post through an MCP tool is an action: it asks first or it runs, and the caps sit with the actions. No hold until morning, no undo window.
- **An automation a person made is quiet, not held, during the same quiet hours.** The service marks its end event while the owner is away; `notifyAutomationRun` shows the usual banner without sound, including failures, subject to the owner’s banner settings. It is never counted in the morning fold: the Automations inbox and system notification list remain its records. No new stored state is added for automation telling. Threads the owner started stay as they are.
- **The dock badge** counts bots with an open ask, approval or question, chat questions included (today's needs-you state leaves those out, `projection.ts:514`).
- **Phone push comes with Mousse ID** (phase 4): the computer is the only sender; the push is sealed to the device, so the server sees a device, an urgency and a size, never a bot's name or text; the phone waits while the owner is at the computer; seen on one device ends it on the others.

## Data model

`bots.db` is at v11. Phase 1 writes its columns; v11 reserves storage for phases 2 and 3 without new behavior. Older builds already refuse a newer one, so each phase that needs a migration starts with one small PR that carries all of it.

| Version | Phase | Change |
|---|---|---|
| none | 0, and all of memory | `bot_memory_state` keys (`progress:<scheduleId>`, `draft:<activationId>`, cap counters, the create request's key); values in existing columns (`external`, `superseded`); `missed` inside `trigger_json` |
| v10 | 1 | `bot_reminders.snoozed_from`, nullable `bot_reminders.owner_set` (no default; NULL means set before v10 and preserves existing reminder behavior); `bot_messages.tell`, `tell_at`, `told_at` with a partial index on `(bot_id, tell_at)`; `bot_registry.tell_json` |
| v11 | 2 and 3 | STRICT table `bot_actions` (below); nullable text `bot_reminders.work_id`, NULL for existing rows and current writers. No masked search index; that is deferred beyond v11. |
| v12 | 4 | tables `bot_telling_devices` and `bot_events`; `bot_reminders.local_at`, `zone` |

`bot_actions`: `id`, `call_key` (unique: activation, dispatch, tool call id), `bot_id`, `activation_id`, `lane`, `kind` (`mcp`, `secret_fetch`), `target_json`, `exec_args` (exact; cleared when settled), `args_json` (masked, for the card and the journal), `args_digest`, `binding_json` (the server as installed, the tool's schema digest, the grant revision, the schedule's revision, the device limit), `place_json`, `card_json`, `bot_note`, `status` (`open`, `approved`, `declined`, `expired`, `withdrawn`, `running`, `done`, `failed`, `uncertain`), `result_json`, `message_id`, `next_at`, `nudges`, `expires_at`, `answered_at`, `answered_device`, `created_at`, `ran_at`; indexed by `(status, next_at)`, `(bot_id, status)` and `(activation_id)`.

All `bot_actions` columns are TEXT except `nudges` (INTEGER, NOT NULL, default 0). `id` is the primary key. `call_key`, `bot_id`, `activation_id`, `lane`, `kind`, `target_json`, `args_json`, `args_digest`, `binding_json`, `status` and `created_at` are NOT NULL: each call needs its identity, target, masked arguments, approval binding, state and creation time. `lane` is checked as `chat` or `run`; `kind` and `status` are checked against the sets above. Checks require `exec_args` to be NULL outside `open`, `approved` and `running`, and an `open` card to have `expires_at`. Other fields are nullable: exact arguments are cleared on settlement; place, card and bot note need not exist for counted calls; result, message, follow-up, expiry, answer and execution fields exist only when applicable. There are no foreign keys. Only the 30-day purge deletes actions; withdrawal when their work or cards end is defined by the later approval implementation. Memory export includes a masked `actions.jsonl`, excluding `exec_args`; whole-database migration copies include the table automatically.

Outside `bots.db`: `ScheduledJob.bot` gains `ownerAsked` and `say`, and in phase 3 `onlyIfChanged` (its state is in `bots.db`); the grant gains the asks-first level and, in phase 3, an automation's exception (automation, tool, place); a secret's record gains the bots that use it and its binding (a request for one is an ordinary escalation row whose permission names the secret, so `bots.db` needs nothing for it); the profile's settings gain `notifications.quietHours`.

## Phases

Each phase ships on its own and leaves bots working. The order is: what is unsafe or wrong today, then what makes a bot continuous and calm, then approvals, then the things that need approvals to exist.

**Phase 0: repairs and containment.** No migration, nothing new to see.

- Containment: a bot's turn starts without the owner's environment; a background command starts only in a turn the owner's message started; held-back secrets stay held back in `memory_read` and search; facts about the owner are saved only in a turn the owner's message or tap started.
- Journal: outside text in requests is marked as data, with the one-time pass over older rows.
- Starts: creating a bot survives a crash; `work_start` has a stable key; a message joins a turn only from the same device and limit.
- Telling: pass the run's level to `tellMeNotifies` (`BotEngine.ts:695`; today a run that reports Needs you is silent under the strictest Tell me, and an FYI run rings under the default); no banner for service lines (every wake rings twice today); the "dropping scheduled runs" line keyed by the owner's local day.
- Timers: tell a late run it is late; the half-gap rule; run a schedule that falls in the skipped hour of a clock change; read "at 9" in the zone the bot is shown; notice a wake from sleep (a 10 s timer that compares the clock with the time it expected, since the service has no system resume event) and check what is due at once.
- Memory: keep `learned_at`; say when a wish did not fit; refuse a wake brief over 2,000 characters instead of cutting it.

**Phase 1: continuity and calm** (v10, in the phase's first PR).

- The unsent draft.
- `leftOff`; `merges`; `nextDueAt` and "is this bot idle?"; retiring exact duplicates; the files index.
- Snooze and who set a timer; `until` and `say`; `schedule_done`; pull request wakes on checks and reviews.
- The file-changed check on Pi. The dock badge.
- Telling, in the service: classes, release, the fold, sound caps, tellings for a closed window.
- Quiet hours that follow the owner: `app.presence`, the owner's zone, one `quietHoursFor`, automations included.
- The owner's wishes: `telling_set`, Tell me on the bot, "can wake me", the About line.

**Phase 2: waiting and approving** (v11, in the phase's first PR).

- One park path, with the schedule's skip check counting a parked run.
- `work_wait`.
- Asks first, built behind a switch that is off and turned on when the whole of it is in: the engine and the held call's contract, the card, a scheduled run that parks, the phone.

**Phase 3: what needs approvals first.**

- One automation let to do one thing alone, with the caps.
- Secrets for bots: background commands held or refused for a bot with a secret; the secret card and its binding; `secret_fetch`; the paste line.
- `onlyIfChanged`.
- Only if the counters show a need: the small model pass over notes.

**Phase 4: beyond this computer** (v12; needs changes in Mousse ID and the phone app).

- One sealed envelope through Mousse ID, held for a device: pushes to a phone, and requests from outside for a computer that is off.
- Masked variables for Claude Code commands.
- Reminders that follow the owner's zone; timers that move with a bot (#778).

## What phases 0 and 1 built

Both phases are on `master`. Each item was one pull request, reviewed on its own, and phase 1 was then checked as a whole. The sections above still describe the design; where the code ended up different, this section is right.

**Phase 0** (issue #1288). Built as planned except:

- **A bot's clean environment** (#1294) keeps variables by family, not by an exact list: Claude Code's own configuration, and the cloud variables of the six routes it can sign in through. Google's and Azure's are narrowed to the exact sign-in names. Exact lists kept missing variables that a sign-in needs.
- **`work_start`'s stable key** (#1296) is the chat activation plus a digest of the request, since the runtime's tool call id turned out to be random on one route. Starting the same work again after it failed or was stopped gets a new attempt.
- **Held-back secrets in search** (#1292) are classified in SQL before results are sorted and cut, so a hidden word cannot decide which rows are returned. A hidden word can still weigh on the order of two ordinary results that nearly tie; closing that needs a second search index (open question 8).
- **The owner's zone and wake from sleep** (#1303) is narrower than planned: "at 9" was already read in the zone the bot is shown, so only a test was added, plus the watchdog that notices a wake from sleep.
- **A schedule in the skipped hour of a clock change** (#1301) is written and reviewed but not merged. It reverses a behaviour the configuration docs describe as deliberate (a skipped time does not run), so it waits for the owner's decision.

**Phase 1** (issue #1312). Built as planned except:

- **Quiet hours are off until the owner sets them.** An unrequested 22:00 to 08:00 hold was removed before the phase began, and nothing holds a message at night for an owner who never asked.
- **A person's own automation that ends in quiet hours is not held.** Its banner is shown without sound and is not counted in the morning banner. The runs ledger records when a run ended, not whether it was announced, so a morning count could repeat after a restart; no new stored state was added for it.
- **An exception to quiet hours changes only when a message is told, never its class.** A message let through (the owner is active, or the bot or automation can wake them) still folds with its neighbours and is under the sound caps.
- **"Is this bot idle?" is not "nothing waits on the owner".** A bot whose only open thing is a chat question is idle. Code that must not act behind the owner's back checks both; memory tidying does.
- **Forget and combined memory entries** (#1315, after five review rounds). Forget takes the entry, the entries that absorbed it at any version, and absorbed entries that are still put away. An entry the owner had put back is left alone. Forget follows entries and exact copies; words a bot typed again into another entry are that entry's.
- **Tidying** (#1330) keeps, among exact copies, the entry of the highest kind (about the owner, then a note, then a run note), then one the owner edited, then the oldest. A later call that names a copy is refused and pointed at the kept entry.
- **One reply for joined messages** (#1319): a turn that pauses while it holds the first answer keeps it unsent until the owner presses Continue or Stop.
- **On Pi, a stale file change is refused** (#1323), with two rules the plan did not have: a file read in pages counts as read whole when the pages cover it unchanged from start to end, and a file over 2 MiB is versioned by its metadata. Neither Claude Code nor Codex refuses a stale overwrite; the plan had assumed Claude Code did.
- **Removing a schedule** withdraws its waiting runs; a run already executing ends with its report at its next wall, with no card (#1318, #1329). The plan had not said what happens to runs of a removed schedule.
- **Older app windows** on a newer service announce a bot's messages as before, one banner each. An old and a new app attached to one service at once announce a message twice.
- **Added by the end-of-phase check** (#1333): the markers that stop a schedule's ending line and its fixed line repeating survive "forget history" and go with their schedule; the changelog and the instructions no longer tell a bot there are no quiet hours, or to save "don't ping me at night" as memory.

**Not verified in either phase:** real sleep and wake; process isolation of the sandbox; macOS and Windows; live models and GitHub; how desktop banners look, sound and respond to a click; the phone app and other computers through the bridge.

## Open questions

1. **Commands where no sandbox holds them** (Pi, Windows, Linux without bubblewrap). A bot with "run commands" there can do anything the owner's account can, in a run nobody is watching too, and no card can hold it. The review behind this version would switch commands off in runs nobody started on those computers. That would end every scheduled bot that runs a script on Windows. Recommended: keep them, since the owner allowed it for that bot and can switch it off for the whole computer; refuse secrets to such a bot; and make the "run commands" ask say, on those computers, that it is the owner's whole account.
2. **A background command starts only in the owner's own turn.** This narrows what #1214 shipped: a wake's turn can no longer start one, so "the tests failed, run them again" becomes work, which runs in the sandbox. Recommended: yes.
3. **No "Always" at all for work the owner asks for.** An owner who has a bot send ten emails in a sitting taps Send ten times. Recommended: yes for now; the cards are the product, and letting one automation act alone covers the unattended case.
4. **The owner's threads stay outside asks first**, as today. A card on every thread a bot starts would undo the hidden quick threads the product just gained. Recommended: leave it, and keep the computer's switch.
5. **Quiet hours for threads too?** Bots and automations follow them from phase 1. Recommended: threads when asked for.
6. **How long a card is good for:** 48 hours for work; for a schedule, one gap and at least an hour, which slows a faster schedule to about once an hour while its card waits. Both are constants.
7. **A fixed line every hour rings in quiet hours.** A schedule's fixed line and a reminder the owner set are told at once, at any hour, because the owner asked for that time. A fixed line set for every hour therefore rings all night, and the way out is to change when it runs. Recommended: keep it; the alternative is that a repeating fixed line waits like other messages and only a one-off reminder rings.
8. **A search index over masked text.** It would stop a held-back word weighing on the order of two ordinary search results that nearly tie (#1292's review found no case where it changed the order in 36 layouts). It needs every journal row of every bot indexed again. Left out of v11. Recommended: not until there is a case.

## What this plan leaves out

A rules engine for "whenever X, do Y"; embeddings or a knowledge graph for memory; extracting facts from every message; rewriting the chat summary with a model; waking or keeping awake the computer; a settings page for notifications; a broad "always allow"; a card for what a bot does in its browser or in commands no sandbox holds; holding or undoing messages a bot sends to other people; secrets for command-line tools before phase 4; anything that runs while the computer is off.

## Related work

Checked on 15 Nov 2026 against open pull requests and issues. Nothing open does part of this. #595 (secrets for agents) has landed for threads and phase 3 extends it to bots. #778 (automations can't move between computers) is the same contract as moving a bot's timers, in phase 4. #1217 (a bot's background threads crowd the sidebar) is beside this plan. The Teams plans (#867, #868, #871) reserve `owner` and `placement` on a bot's definition; nothing here uses them.

## How this was decided

Five researchers, one per capability, each read the code at `0bfd7f476` and outside sources, and wrote a proposal. In a second round each read the other four and answered the points where they met; in a third each checked this document against the code.

What the second round changed:

- **Inbox:** the collect window became the unsent draft; standing triggers were dropped for a check in front of a schedule; pending events moved from `jobs.json` to `bots.db`; the claim that an event's text is never journaled turned out false and became the data-frame fix.
- **Timers:** a follow-up from work became work that waits, not a wake of the chat; the half-gap rule was limited to downtime; who set a timer is stored when it is set.
- **Memory:** the model pass shrank to dates and contradictions, called only when code finds a candidate; the files index lost first lines; the dialog gained one line instead of a group.
- **Permissions:** a scheduled run parks for an approval instead of having its action run later outside the run; expiry counts from when the owner is told; a hold-until-morning for outward messages was dropped.
- **Telling:** three tables became four columns; three kinds of wish became two; "the owner is waiting" became "the owner is active"; the morning summary became "the first time the owner is back".

What the third round changed (some of it later undone by the review below):

- **Inbox:** the unsent draft gets its own key, since the activation's result is overwritten; the page check moved in front of the activation, so an unchanged page leaves no run in the automation's list; a changed page reaches the run as a file, since no runtime takes a tool result in a first prompt.
- **Timers:** saved times stay on the computer's clock and only quiet hours follow the owner's last device; a wait is stored as a wake row so today's event checks see it; a parked scheduled run was found not to be skipped by today's check.
- **Memory:** code retires only exact duplicates, since today's near-duplicate test would retire a correction; Forget must reach the left-off line; rows captured before the frame fix need a one-time pass.
- **Permissions:** "Always never covers a new destination" was added against the lead's first rule, which a forwarded-invoice email would have beaten; a schedule keeps one card, replaced in place; the bot's own `confirm` call was left out; sandboxing background commands was moved before secrets instead of refusing them now.
- **Telling:** the app's main process can't tell what started a row, so the event carries it in phase 1; the service can't see window focus, so the app reports it through negotiated presence in phase 1; a person's automations follow quiet hours too; a laptop's catch-up is an ordinary banner, not "while you were away".

Not agreed by everyone: the timers researcher would park a scheduled run only when its schedule's gap is an hour or more, and run a faster schedule's stored action outside its run. The plan keeps one behaviour (open question 6).

What an independent review changed (GPT-6.1-Sol, against `2e8a5b9ca`, after the three rounds):

- **Approvals:** "Always allow this" is gone, in both forms the plan had tried; only one automation can be let to do one thing in one place, and that comes a phase later. A held call got a full contract: one row per call, exact arguments kept apart from the masked copy, a compare-and-set Send that names what the card showed, and withdrawal with whatever it belongs to. A card's life counts from its posting, not from when the owner was told. The owner's threads were taken out of asks first: they keep today's rule.
- **Secrets:** a secret is bound to an origin, a fixed place for its value and, for known services, paths; the request connects to the address it checked and follows no redirect. A bot whose commands no sandbox holds gets no secret. What no card covers (commands without a sandbox, the browser, what is sent) is said in one place.
- **Containment moved to phase 0:** a background command starts only in the owner's own turn, and facts about the owner are saved only in a turn the owner started.
- **Inbox:** "every start commits with its source" was false for creating a bot and for a reminder's work, and "one worker" is one chat turn and three runs per bot; both are now said as they are, and creating a bot is repaired. The page check got a full protocol and moved to phase 3.
- **Memory:** retiring "a note whose file is gone" was dropped (no link exists to decide it); the model pass left the first three phases; the Memory dialog's line was dropped; the left-off line is loaded only for its own schedule.
- **Telling:** the temporary hold in the app's main process was cut; telling is durable from its first PR. A failed run always tells.
- **The interface:** tool names left About; a card has two buttons.

Not taken from that review: switching commands off in unattended runs where no sandbox holds them (open question 1), and an approval for what a bot does in its browser, for which no bounded mechanism exists yet.
