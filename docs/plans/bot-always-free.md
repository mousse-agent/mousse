# Bots that stay free while they work

A bot should feel like a person who works for you. You give them work and they say "on it". While the work runs you can keep talking to them: ask how it's going, add a detail, change your mind, or ask something unrelated. They tell you when it's done, and their answer points at the message it answers. They never ask for the keys to your house just to keep a shopping list.

This plan changes how a personal bot is built under that rule. None of the new parts adds a setting or a screen. Bots made by earlier builds keep working.

## What was wrong (measured on master at a14ab617e)

- **Busy means deaf.** The chat lane runs one activation at a time on the home thread, and that activation does all the work, up to an hour. A second message waits behind it. "Add AA batteries" waited 20.7 s behind a 22 s web search; a long job would make it wait the whole hour.
- **No partial answer.** The owner sees "working…" and then one reply when the whole job is done.
- **Replies don't say what they answer.** Two replies in a row don't show which message each one answers.
- **No one-off reminders.** A bot schedule only repeats. "Remind me in 7 minutes" became the cron `42 18 10 11 *`, which also fires every 10 November.
- **Asks nobody needed.**
  - The first-message prompt tells a new bot to ask for a permission at once. Every new bot asked for "use files on this computer" just to keep notes in its own files folder.
  - `web_fetch` and `web_search` are neutral tools, but `heldAlready` looks for them in `tools`, while the starter grant keeps them in `appTools`. So the bot was asked to "read web pages" when it already could.
- **Lists not kept.** The chat context is cleared at every message, and the bot did not save the lists it promised to keep. It dropped an item within ten minutes.

## The model: a front desk and its work

### 1. The chat is the front desk

A chat turn talks, decides and hands off. It only gets tools that answer in a moment:

| Kept in a chat turn | Moved to work |
|---|---|
| memory | `web_search`, `web_fetch` |
| schedules | the browser |
| reminders | `shell` |
| the work tools (below) | |
| `escalate` | |
| set_profile, set_depth, use_model | |
| the file tools | |
| the automation tools | |

- `compileBotThread` narrows the chat lane's tools, so this is enforced by structure, not left to the prompt.
- An ask still happens in the chat: the bot asks for a permission there before it hands work off.
- A chat turn now takes one model call or a few local tool calls, so the queue behind it is seconds long.

### 2. Work runs beside the chat

The chat turn hands work off with `work_start({ title, brief })`.

- `work_start` inserts a run-lane activation with the trigger `{ kind: 'work', input: brief, title, replyTo, from }` and returns at once. The bot then says something like "On it, I'll tell you when it's done."
- **Its own thread.** Each piece of work is a run-lane activation on a thread of its own (`bot:<id>:act:<activationId>`), as scheduled runs already are. The run engine, receipts, unknown-call gate, supervisor, internet wait and usage-limit handling all apply unchanged.
- **Up to three at once.** A bot may run up to 3 run-lane activations at a time (scheduled runs count too). Later ones queue, and a full queue says so.
- **Tools.** Work gets the bot's full grant. It does not get the work tools, so work can't start work. A missing permission behaves as in any run: the call is refused, one ask card appears in the chat, and the work carries on and says what it skipped.
- **Ending.** When work ends, its report is posted in the chat, replying to the owner's message that started it, and it notifies the owner as a run report does.
- **The other work tools.**
  - `work_list` shows what is running: title, how long it has run, its live activity, and its last few reports.
  - `work_stop({ workId })` stops one piece of work.
  - `work_note({ workId, note })` passes a note from the owner to running work. The note is kept on the activation. When the work's current turn ends, the engine continues the same thread with the note (`continueWith`, `ownerText`) instead of finishing. So the report includes the change. If the note changes the task completely, the bot stops the work and starts new work.
- **Context.** The chat pack's situation lists the work in progress ("Working on: Vacuum comparison, 2 min, searching the web"), so a chat turn can answer "how's it going?" without a tool call. The chat window already holds the reports of finished work.

### 3. Replies say what they answer

- **Storage.** `bot_messages.reply_to` holds a message id (bots.db v6, a nullable column; the usual `bots.db.pre-v6` copy is made first).
- **What a bot message points at.**
  - a chat reply: the owner's message that started its activation;
  - a work report: the message that asked for the work;
  - a reminder: the message that asked for it.
- **What the owner sees.** A bot message shows a small quote of the message it answers: author and first line. Clicking the quote scrolls to that message. The quote appears only when the answered message is not directly above, so plain back-and-forth looks as it does today.
- **The owner can reply to a bot message.** Hover → Reply puts a quote above the composer. `bots.chat.send` carries `replyTo`, and the bot's input starts with `(Replying to your message: "…")`.

### 4. Reminders

`remind({ at, text })` keeps a one-off reminder, and `remind({ at, work })` starts work at that time.

- **Storage.** Each reminder is a row in `bot_reminders` (v6): the time, the text or the work brief, `reply_to`, and its status.
- **Timing.** The engine arms one timer for the next due reminder and arms it again at startup.
- **When it's due.**
  - A text reminder posts the text as a bot message at once, with no model call, and notifies the owner.
  - A work reminder starts work.
- **Missed reminders.** A reminder missed while Mousse was off is delivered at the next start, with its time ("Reminder from 14:30: …").
- **Managing them.** `reminder_list` and `reminder_cancel` list and cancel them. About → Runs lists them beside schedules.
- **Repeats.** Repeating things stay schedules.

### 5. Trust without prompts

- A bot never asks before the owner wants something. The creation turn's prompt no longer asks for permissions. An `escalate` in an activation with no owner request (the creation turn) is answered "Ask when the owner wants something that needs it", and no card is made.
- What a bot already holds never raises a card: the neutral web tools are found in `appTools`.
- An ask for an MCP tool in the chat is refused at once, as in a run, because no bot can hold one.
- The bot's own files folder, memory, schedules, reminders and work need no permission, and the instructions say so.
- Mousse's own data stays closed whatever the grant.

### 6. Instructions

The base instructions are rewritten around the front desk:

- Answer in seconds.
- Hand anything longer to work and say so in one line.
- Keep lists and plans in memory, and update them when they change.
- Answer only what was asked, with no narration of your own thinking.
- Use the work list when asked how something is going.

## The UI

- **Above the composer:** one line per piece of work, with a spinner, its title, how long it has run, and Stop.
- **Working state.**
  - The chat header's "is working…" line and the composer's Stop follow only the chat lane.
  - The sidebar row reads "Working on 2 things" while only work runs.
- Reply quotes on messages; Reply on hover.

## Bugs fixed on the way

- Settings → Bot model never saved: `botModel` was missing from `asSettingsPartial`'s allowlist.
- A message sent while a chat waits on an ask could go unanswered when the continuation didn't start. It now starts a turn of its own.

## Not in this change

- Live steering of a running work turn (the note waits for the current turn).
- MCP servers for bots.
- Grant defaults (for example the bot's own browser without an ask). These are worth a separate look once this lands.
