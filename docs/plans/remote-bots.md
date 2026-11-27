# Bots on your other computers

The desktop app lists, opens and uses the personal bots that live on the owner's other computers, as it does its own. Access to bots becomes a setting of its own per device, apart from access to threads. Phones follow the same rules (#2023).

**Status:** design, decided. Nothing built yet. Tracking issue #2030. Written against `origin/master` at `2fc894c23` (27 Nov 2026); find code by name, not line. Terms are the [glossary](../GLOSSARY.md)'s; how bots work today is in [`docs/bots.md`](../bots.md). Mousse is on nightly builds, so this plan keeps no compatibility with older builds: every computer and phone runs the same version.

## The problem

The Bots list in the desktop app shows only the bots on that computer. A bot made on the Mac can't be opened, chatted with or set up from the PC, even when both are linked through Bridge.

At the root, bot calls are tied to the local service. The desktop bot store talks only to its own daemon. The remote bot surface (`RemoteBots.ts`) is a separate method table shaped for phones, so each new bot feature is added twice. Its access borrows from thread access: a device's bot rights come from "Work on threads" and "Full control", and the bots of a computer travel inside its threads lists. Switching thread sharing off hides that computer's bots too.

## What the person sees

The look follows the Threads tab: the same rows, badge and filter.

1. **One Bots list** in the Chats tab: the bots of every computer that lets this one reach them, pinned first, then by latest activity. A bot on another computer has the server badge that thread rows of other computers use ("Lives on Mac mini" on hover). This computer's bots have none.
2. **Filter** beside +: by computer (All, This computer, each other computer) and by state (All bots, Needs me, Working, Hide offline). Show hidden brings hidden bots back, faded. A dot on the button marks an active filter.
3. **Right-click** (or the menu key): Pin/Unpin, Mark read/unread, Mute notifications, Hide (these four are kept on this computer and work while the bot's computer is offline); About, Rename, Change look, Pause/Resume, Copy reference, Make private, Delete. A row also shows a pin button on hover, as thread rows do.
4. **A remote bot works like a local one:** live chat with replies streaming in, files and images both ways, asks and cards, Stop, reactions, its applets and its live browser view.
5. **The bot's computer goes offline:** its bots stay listed from the last copy, greyed, the face dozing under a moon (idle bots already sleep with a "z"; the moon tells the two apart), the badge struck through. The chat opens read-only; Send and every action that needs the bot's computer are disabled with "<Computer> is offline". Nothing is queued. When the computer is back, the chat goes live again.
6. **Notifications:** another computer's bot notifies here as a local bot does, with the same grouping, sound limits and withdrawal once read, unless the bot is muted here.
7. **New bot:** "Lives on" offers each computer where this one has Full bot access. When the owner has more than one computer, New bot has a Devices step (below).
8. **Losing access:** when the bot's computer lowers this device to Off, or takes it off the bot's Devices, the bot leaves the list here with its copy, marks and notifications. A message still queued from here is not delivered (existing: "Not delivered: the device it came from can no longer reach me."). An open chat says the bot is no longer there.

An illustrative mockup of the list, filter, offline row and menu was agreed in the planning chat; the real rows reuse `BotRow`, `BotFace` and `ComputerBadgeView`.

## Access: two checks, both on the bot's computer

### Bot access per device

A setting on each device's row in Settings → Devices on the computer that holds the bots, separate from thread access:

| Level | The device may |
|---|---|
| **Off** | See none of this computer's bots. Every bot call from it answers as for a bot that is not there. |
| **Use** | List and open the bots it reaches; read the chat, files, cards and memory; send messages and files; answer questions and approve a held action within the bot's existing permissions; Stop; react; snooze a reminder; open its applets; watch its browser. It changes nothing about how the bot is set up. |
| **Full** | Everything this computer's own window can: rename, look, instructions, pause/resume, grant or revoke permissions (answering an ask is a grant), model and rows, schedules, cancel reminders, edit or forget memory, clear the chat, reset, delete, take over the browser, change the bot's Devices, and make new bots here. |

- The access presets set it with their other switches: View and chat and Work on threads give **Use**, Full control gives **Full**. It can be changed on its own, which makes the preset Custom, as any other switch does.
- A new device starts at **Use**. With each bot's Devices starting at this computer only (below), a new device still reaches no bot until the owner adds it.
- It replaces the on/off "Bots on this computer" switch (`net_node_policy.bots`) and the computer-wide "Share bots with other devices" switch. Setting every device to Off is what Share bots off did.
- The bot's own permissions and the rules its creator gave it always hold, whatever the level. A turn started from another device is still held to that device's thread permission ceiling here (`BotOwnerTurn.limit`).

### Which devices reach a bot

Each bot's Devices choice (About → Devices) stays the second check: the devices that see this bot at all.

- **A new bot reaches only its own computer.** When the owner has more than one device, New bot has a Devices step to tick others. About changes it later.
- **The list is explicit.** "All my devices" goes away: a device linked later reaches no existing bot until the owner adds it to that bot.
- **Existing bots on update:** a bot set to "All my devices" becomes a list of the devices linked at that moment, so no one loses access they had and new devices start outside.
- A device left out finds no such bot (unchanged): in no list, and every call answers as for a bot that is not there.

## The shape

| Piece | Owner | Where |
|---|---|---|
| A bot's state: definition, chat, asks, memory, files, browser, applets, Devices | The bot's computer | `bots.db`, the files folder, `device-access.json` (as today) |
| Each device's bot level | The bot's computer | `net_node_policy`, a `bots` level in place of the boolean |
| The one bot method table | Shared code | `BOT_METHODS` in `src/shared/bots/personal/methods.ts` |
| Remote bots' rows and their copy on disk | The viewing computer | `RemoteBotRegistry`, fed by each computer's bots feed |
| A remote bot's chat copy, for offline reading | The viewing computer | `RemoteBotChats`: newest ~200 messages per bot, capped in total; text and card data only |
| Pin, hide and mute for every bot; read marks for remote bots | The viewing computer | `bot-marks.json` in the profile, keyed by bot ref. A local bot's read state stays in `bots.db` |
| Notifications for remote bots | The viewing computer | `RemoteBotTellings`, using the same folding and caps as `BotTellings` |
| Views | Renderer | `botsStore` keyed by bot ref: a plain id is local, `<node>:<botId>` is remote. The same views for both |

### One method table

Each row of `BOT_METHODS` names the method, its level (`use`, `full` or `local`, for the few that only this computer's window may call, such as opening the browser in its own window), an optional check run before the call, and an optional result shaping (no local paths; no instance ids below Full). Three things are generated from it:

- the local registration (`registerPersonalBotMethods`, `registerBotDeviceMethods`, `registerBotBrowserMethods`);
- the remote registration for phones and other computers (`remoteBotMethods`, through its one wrapper);
- the methods' rows in `METHOD_ACCESS`, and the engine's allowlist entries.

A table test fails when a bot method has no level. Adding a bot feature is adding one row, and phones and other computers get it under the same rule.

### One gate

Every remote bot call, stream open and saved-result lookup goes through the `remoteBotMethods` wrapper on the bot's computer, before admission and again as it runs:

1. the device's bot level against the row's level;
2. the bot's Devices list;
3. for a chat turn, the device's thread permission ceiling.

A failure in 1 or 2 for a bot the device can't reach answers as for a bot that is not there (`stream_unknown`). The viewing side only hides buttons; the bot's computer decides.

### Feeds and streams

- **The bots feed** (`bridge.bots.open`, one private stream per reader): the bots that reader reaches, each with its summary, live chip and telling metadata (latest message id and sequence, how loudly to tell, open attention ids for withdrawal). It is separate from the threads lists, so thread sharing and bot access no longer depend on each other. `bots` leaves the threads lists stream.
- **A bot's stream** (`bridge.bot.open`, per reader and bot, held by an `AttachedBots` lease while a window shows the chat): `bots.message`, `bots.changed`, `bots.activity` and live reply text, throttled. Bot streams have their own small limit, apart from thread streams, and bot calls never take the slots for large routed reads (except the paged file read), so a bot's chat never waits behind thread traffic.
- **The live browser view** gets its own engine channel (label `bot-view`), opened by the viewer while it shows the browser. mousse-net already carries application channels of any size (terminals use one); the 64 KiB limit applies to Mousse's own messages, not to channels. The sender keeps only the newest picture: when credit runs short it skips stale ones. Nothing is stored or retried. Input (clicks, keys) goes through the `bots.browser.send` row at Full.
- **The engine carries bots.** The bot rows and the two bot streams join `ENGINE_OWNER_METHODS`, and `NetEngineService` admits reader-bound private streams for them. The allowlist's note that bots are not carried was a deferral, now due.

### Calls from the viewing computer

A `BotRouter` beside `ThreadRouter` takes a call with a qualified bot id from a window (never from the command line or an agent) and sends it to that computer over the routed client:

- **Reads** wait at most 4 s, as remote automations do, then answer from the copy, marked stale.
- **Writes** to an offline computer fail at once with `computer_offline`; nothing is queued. A lost reply shows "May not have been sent · Retry", and Retry sends the same request id.
- **Files sent to a bot** are staged ahead of `bots.chat.send` (the 25 MiB staging limit stands). The bot's computer writes them into the bot's files folder; the window never names a path there.
- **Pictures and files from a bot** come through a paged `bots.chat.file` row confined to the bot's files folder (images checked by their first bytes, never SVG).
- **Applets** use `bots.applets.get`, `state.get` and `state.save` rows that name the bot and the reply; the bot's computer checks the reply belongs to that bot. They do not go through the thread routes, which would get around bot access.

Opening the app or the Chats tab reads only memory and the copy on disk; it never waits on another computer.

### The flows through it

- **Offline.** The registry keeps the last feed snapshot and marks the computer offline; the rows grey, chats open from `RemoteBotChats`, and actions that need the bot's computer are disabled. On reconnect the feed and any open bot stream reattach and the chat reloads.
- **Losing access.** The bot's computer pushes the reader's bots feed without the bot, ends its bot and browser streams, and withdraws queued messages (`withdrawQueued`). The viewing computer drops the row, the chat copy, the marks and any notification shown. A refusal of the whole feed (level Off) drops every bot of that computer, not a row marked "not shared". If the bot's computer is offline when access is lost, the viewing computer learns when it returns; what a device already received can't be taken back (as today).
- **Notifications.** `RemoteBotTellings` reacts only to live feed changes, never to a start, a reconnect or a copy loaded from disk, and applies mute and hide here.
- **New bot elsewhere.** `bots.model.choices` and `bots.create` take a target computer; the model list is that computer's own.

## What goes away

- The "Share bots with other devices" switch and the boolean "Bots on this computer" switch (replaced by the bot level).
- The "All my devices" reach mode (replaced by an explicit list).
- `RemoteBotsPort` and the hand-written handlers in `remoteBotMethods`, the two `KEYS` tables (`RemoteBots.ts`, `registerMethods.ts`) and the hand-written bot rows in `METHOD_ACCESS`: all generated from `BOT_METHODS`.
- The `bots_chat` and `bots_manage` access classes (replaced by the levels).
- The local-only refusals in `bots.devices.*` and `bots.permissions.set` (replaced by the Full level).
- `bots` in the threads lists stream (replaced by the bots feed).
- `withHiddenBots` naming every other computer's bot "a bot": a thread started by a bot this computer reaches can name it.
- Polling for remote rows; local bots keep `useBotsPolling` until it is replaced separately.

## How this was decided

Design level 2. Two proposals were written alone from the same brief: A (Gemini 4 Neon) and B (Claude Opus 5.5). A fresh Gemini 4 Neon that wrote neither judged them against a rubric written first, and the planning agent marked them too.

**A** put desktop bot calls on the routed thread path (`ROUTED_METHODS`, `OwnerRoutes`) and kept the phone table as it was. **B** made one bot table for both and its own router and streams. Both used qualified bot ids, the lists stream, a viewing-side copy and local marks.

| Criterion | A (judge / planner) | B (judge / planner) |
|---|---|---|
| 1. One owner per state | partly / partly: local read marks split from `bots.db` | partly / partly: same; fixed above by keeping local read state in `bots.db` |
| 2. Rules kept by structure | partly / partly | partly / met: the judge counted facts about the code still to change (engine allowlist, staging class) |
| 3. Phones (#2023) and later bot features fit | not met / not met: two tables for ever | met / met |
| 4. Parts replaceable alone | partly / partly: a bot exception in `OwnerRoutes`, thread checks changed in three places | met / met |
| 5. No compatibility layer without its removal | not met / not met | not met / not met: a phone shim; removed above, since phones follow the levels and no older build is kept |
| 6. Use without Full; setup only with Full; one place | partly / partly: the right tiers, but the phone table at `bots_manage` was a way around them | not met / not met: answering asks and taking over the browser below Full; fixed above by A's tiers |
| 7. Offline copy, nothing queued, no trace after access is lost | partly / partly | partly / partly: both kept rows marked "not shared" on refusal; fixed above |
| 8. Never waits on another computer; bot chat never behind threads | partly / partly: 1 MiB stream frames can't cross | partly / partly: pictures as stream records can't cross; fixed above by the `bot-view` channel |

The judge and the planner both chose **B**, grafting from A its strict two levels for using and setting up a bot, and its telling metadata and live reply text on the feed. The owner then made bot access its own setting per device instead of borrowing thread access, and made each bot's Devices an explicit list that starts at its own computer.

**Rejected:**

- **A as a whole:** two tables for ever, and thread routing bent to fit bots.
- **The smallest change** (point the desktop at the phone table as it stands): keeps bot access tied to thread access and the thread lists.
- **A level per bot per device:** more than the owner asked for. Each bot's Devices list already narrows it per bot.

**Worth revisiting** if owners want a device to use some bots and set up others (a level per bot), or if the bots feed grows large enough that one snapshot per change costs too much.

## Unknowns to run first

Each is a throwaway spike that answers yes or no before the slice that needs it:

1. Can an engine application channel carry ~60 KB pictures at 5 per second, newest only, without slowing RPCs and thread streams on the same session?
2. Does `NetEngineService` admit a reader-bound private stream once its kind is allowed, with reach checked on every read?
3. Does staging admit a file when the call that uses it is a bot call at Use (today `routed.stage` is classed `work`)?
4. Does `bridge.access.mine` (or its replacement) tell the caller its bot level on each computer?

## Slices

Each slice ends with one check. What needs two computers is checked on the PC and the Mac mini; it is listed as not checked until then.

1. **Access.** The bot level per device in place of the two switches, set by the presets; each bot's Devices as an explicit list starting at its own computer, with the update rule above; the Devices step in New bot. `BOT_METHODS` with levels, generating the local and remote registrations and `METHOD_ACCESS`; phones follow it. *Check:* the table test, and gate tests for Off, Use and Full against every row.
2. **Thin slice, end to end.** The bots feed; `RemoteBotRegistry` with its copy; `BotRouter` with fast failure when offline; `bridge.bot.open` with `AttachedBots`; `RemoteBotChats`; the merged list with the badge and offline state; a remote chat in text, read-only when offline. The engine allowlist entries. *Check:* tests that a lost reach drops the row and the copy; the PC opens and chats with a Mac bot.
3. **Marks, filter and menu.** `bot-marks.json`, pin, hide, mute, read marks, the filter and the right-click menu. *Check:* store tests for order and filter.
4. **Notifications.** Telling metadata on the feed and `RemoteBotTellings`. *Check:* tests that a start or reconnect tells nothing and mute holds.
5. **Files and images.** Staged sends and `bots.chat.file`. *Check:* a picture sent from the PC shows on the Mac and back.
6. **Setup from another computer.** The Full rows, About and the menu from a remote device, and New bot "Lives on". *Check:* gate tests; making a bot on the Mac from the PC.
7. **Applets.** The bot-scoped applet rows. *Check:* a bot's applet opens on the PC.
8. **Browser view.** The `bot-view` channel, watching at Use, taking over at Full. *Check:* spike 1's numbers, and watching a Mac bot's browser from the PC.
