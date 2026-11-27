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
3. **Right-click** (or the menu key): Pin/Unpin, Mark read/unread, Mute notifications, Hide (kept on this computer and work while the bot's computer is offline; see "Read state" for Mark read); About, Rename, Change look, Pause/Resume, Make private, Delete. Copy reference is left for later: references resolve only threads and projects today (`chatReferences.resolve`). A row also shows a pin button on hover, as thread rows do.
4. **A remote bot works like a local one:** live chat with replies streaming in, files and images both ways, asks and cards, Stop, reactions, its applets and its live browser view.
5. **The bot's computer goes offline:** its bots stay listed from the last copy, greyed, the face dozing under a moon (idle bots already sleep with a "z"; the moon tells the two apart), the badge struck through. The chat opens read-only; Send and every action that needs the bot's computer are disabled with "<Computer> is offline". Nothing is queued. When the computer is back, the chat goes live again.
6. **Notifications:** another computer's bot notifies here as a local bot does, with the same grouping, sound limits and withdrawal once read, unless the bot is muted here.
7. **New bot:** "Lives on" offers each computer where this one has Full bot access. When the owner has more than one device, New bot has a Devices step (below).
8. **Losing access:** when the bot's computer lowers this device to Off, or takes it off the bot's Devices, the bot leaves the list here with its copy, marks and notifications. A message still queued from here is not delivered (existing: "Not delivered: the device it came from can no longer reach me."). An open chat says the bot is no longer there.

An illustrative mockup of the list, filter, offline row and menu was agreed in the planning chat; the real rows reuse `BotRow`, `BotFace` and `ComputerBadgeView`.

## Access: two checks, both on the bot's computer

### Bot access per device

A setting on each device's row in Settings → Devices on the computer that holds the bots, separate from thread access:

| Level | The device may |
|---|---|
| **Off** | See none of this computer's bots. Every bot call from it answers as for a bot that is not there. |
| **Use** | List and open the bots it reaches; read the chat, files, cards and memory; send messages and files; answer questions and approve a held action within the bot's existing permissions; Stop; react; snooze a reminder; mark read; open its applets; watch its browser. It changes nothing about how the bot is set up. |
| **Full** | Everything this computer's own window can, except the few calls kept to that window (below): rename, look, instructions, pause/resume, grant or revoke permissions (answering an ask is a grant), model and rows, schedules, cancel reminders, edit or forget memory, clear the chat, reset, delete, take over the browser, change the bot's Devices, and make new bots here. |

- **Full bot access never widens thread access.** Granting a bot a permission that runs threads in Full access ("Use your threads", or any permission marked as needing Full access) also needs the device's thread ceiling here to be Full access (`limitOf(context) === 'full'`, as today). A device at Full bot access with a lower ceiling can grant everything else.
- **Kept to this computer's window** (level `local`): exporting memory to a folder (`bots.memory.export`, and answering an `export_memory` ask), and opening the browser in its own window (`bots.browser.window`). Local calls keep their client checks: `bots.permissions.set` and `bots.devices.*` still refuse the command line and agents on this computer.
- The access presets set it with their other switches: View and chat and Work on threads give **Use**, Full control gives **Full**. It can be changed on its own, which shows the preset as Custom. The bot level is not one of the fields that decide Full control elsewhere (`accessPresetOf` for remote updates, `roleForLevel` for the engine grant role): lowering a Full control device's bot level changes nothing about its threads, updates or connection.
- The speech methods (`speech.*`), classed with bot chat today, keep their current rule under a class of their own; they do not follow the bot level.
- A new device starts at **Use**. With each bot's Devices starting at this computer only (below), a new device still reaches no bot until the owner adds it.
- It replaces the on/off "Bots on this computer" switch (`net_node_policy.bots`) and the computer-wide "Share bots with other devices" switch. Setting every device to Off is what Share bots off did.
- The bot's own permissions and the rules its creator gave it always hold, whatever the level. A turn started from another device is still held to that device's thread permission ceiling here (`BotOwnerTurn.limit`).

### Which devices reach a bot

Each bot's Devices choice (About → Devices) stays the second check: the devices that see this bot at all.

- **A new bot reaches only its own computer.** When the owner has more than one device, New bot has a Devices step to tick others. About changes it later.
- **A bot made from another computer** ("Lives on: Mac mini" chosen on the PC) also reaches the device that made it, ticked and locked in the step, so its maker is never shut out. The Devices step lists the target computer's devices, returned by `bots.model.choices` for that computer (device ids are each computer's own).
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
| Pin, hide, mute and "marked unread" for every bot | The viewing computer | `bot-marks.json` in the profile, keyed by bot ref |
| Read state (how far the owner has read) | The bot's computer | `readSeq` in `bots.db`, as today, for every device |
| Notifications for remote bots | The viewing computer | `RemoteBotTellings`, using the same folding and caps as `BotTellings` |
| Views | Renderer | `botsStore` keyed by bot ref: a plain id is local, `<node>:<botId>` is remote. The same views for both |

### One method table

Each row of `BOT_METHODS` names the method, its level (`use`, `full` or `local`, for the few that only this computer's window may call, such as opening the browser in its own window), an optional check run before the call, and an optional result shaping (no local paths; no instance ids below Full). Three things are generated from it:

- the local registration (`registerPersonalBotMethods`, `registerBotDeviceMethods`, `registerBotBrowserMethods`);
- the remote registration for phones and other computers (`remoteBotMethods`, through its one wrapper);
- the methods' rows in `METHOD_ACCESS`, and the engine's allowlist entries.

A table test fails when a bot method has no level. Adding a bot feature is adding one row, and phones and other computers get it under the same rule.

Every row names its bot. `bots.actions.answer` gains a required `botId` (the remote form already has it), so the gate can check the bot before anything runs. `bots.chat.file` replaces the phone's `bots.chat.attachment` for every device: any file from the bot's files folder, up to 25 MiB, read in pages of 40 KiB, with its own small pool of reads apart from the routed large-read slots.

### Read state

The bot's computer owns how far the owner has read, as today. Opening a remote bot's chat calls `bots.chat.markRead` there (level Use), and the bots feed carries each bot's `readSeq`, so reading on any device clears the unread count and withdraws notifications on every other. "Mark unread" is a flag in `bot-marks.json` on the device that set it, for local and remote bots alike; it shows a dot until the chat is opened there and never changes `bots.db`.

### One gate

Every remote bot call, stream open and saved-result lookup goes through the `remoteBotMethods` wrapper on the bot's computer, before admission and again as it runs:

1. the device's bot level against the row's level;
2. the bot's Devices list;
3. for a chat turn, the device's thread permission ceiling.

A failure in 1 or 2 for a bot the device can't reach answers as for a bot that is not there (`stream_unknown`). The viewing side only hides buttons; the bot's computer decides.

### Feeds and streams

- **The bots feed** (`bridge.bots.open`, one private stream per reader): the bots that reader reaches, each with its summary, live chip, `readSeq` and telling metadata (latest message id and sequence, how loudly to tell, open attention ids for withdrawal). `bots` leaves the threads lists stream.
- **Bot streams stand apart from thread sharing.** Today every private stream needs thread sharing ("Work on threads") and, on the first Bridge transport, the `settings` capability: `NetEngineService.assertReadable`, `NetService` releasing private streams when thread sharing turns off, and `NodeStreamAuthority.canRead`. The bot stream kinds are admitted and kept by the bot level alone (and the `read` capability), and are released when the bot level drops to Off.
- **A bot's stream** (`bridge.bot.open`, per reader and bot, held by an `AttachedBots` lease while a window shows the chat): `bots.message`, `bots.changed`, `bots.activity` and live reply text, throttled. Bot streams have their own small limit, apart from thread streams, and bot calls never take the slots for large routed reads (except the paged file read), so a bot's chat never waits behind thread traffic.
- **The live browser view** gets its own engine stream (label `mousse.botview`), opened by the viewer while it shows the browser. mousse-net streams carry any number of bytes (a picture spans many 64 KiB frames); the 64 KiB limit is on Mousse's own messages. Two lists of labels need the new one: `ENGINE_LABELS` in Mousse and the helper's own list in mousse-net, which resets any other label, so this needs a small mousse-net change and a new pinned engine commit. The editor tunnel (`mousse.tunnel`) is the model. The sender keeps only the newest picture: when credit runs short it skips stale ones. Nothing is stored or retried.
- **Browser levels.** Use: `bots.browser.get`, `watch`, `unwatch`. Full: `hold`, `send`, `open`, `close`. A remote hold is released when its device disconnects, when the device's bot level drops below Full, or when the device loses the bot.
- **The engine carries bots.** The bot rows and the two bot streams join `ENGINE_OWNER_METHODS`, and `NetEngineService` admits reader-bound private streams for them. The allowlist's note that bots are not carried was a deferral, now due.

### Calls from the viewing computer

A `BotRouter` beside `ThreadRouter` takes a call with a qualified bot id from a window (never from the command line or an agent) and sends it to that computer over the routed client:

- **Reads** wait at most 4 s, as remote automations do, then answer from the copy, marked stale.
- **Writes** to an offline computer fail at once with `computer_offline`; nothing is queued. A lost reply shows "May not have been sent · Retry", and Retry sends the same request id.
- **Files sent to a bot** are staged ahead of `bots.chat.send` through a bot staging row (`bots.stage`, level Use) in the bot table, not `routed.stage`: that one belongs to the routed family, needs thread sharing and the `settings` capability, and is cleaned up only by the thread routes. The 25 MiB limit stands. A staged file is consumed by the send, and dropped when the send fails, after its deadline, or when the device's bot level drops to Off. The bot's computer writes it into the bot's files folder; the window never names a path there.
- **Pictures and files from a bot** come through a paged `bots.chat.file` row confined to the bot's files folder (images checked by their first bytes, never SVG).
- **Applets** use `bots.applets.get`, `state.get` and `state.save` rows that name the bot and the reply; the bot's computer checks the reply belongs to that bot. They do not go through the thread routes, which would get around bot access.

Opening the app or the Chats tab reads only memory and the copy on disk; it never waits on another computer.

### The flows through it

- **Offline.** The registry keeps the last feed snapshot and marks the computer offline; the rows grey, chats open from `RemoteBotChats`, and actions that need the bot's computer are disabled. On reconnect the feed and any open bot stream reattach and the chat reloads.
- **Losing access.** The bot's computer pushes the reader's bots feed without the bot, ends its bot and browser streams, and withdraws queued messages (`withdrawQueued`). The viewing computer drops the row, the chat copy, the marks and any notification shown. A refusal of the whole feed (level Off) drops every bot of that computer, not a row marked "not shared". If the bot's computer is offline when access is lost, the viewing computer learns when it returns; what a device already received can't be taken back (as today).
- **Notifications.** `RemoteBotTellings` reacts only to live feed changes, never to a start, a reconnect or a copy loaded from disk, and applies mute and hide here. A `readSeq` that passes a notified message withdraws it.
- **New bot elsewhere.** `bots.model.choices` and `bots.create` take a target computer; the model list and the device list are that computer's own, and the maker is always included.

## What goes away

- The "Share bots with other devices" switch and the boolean "Bots on this computer" switch (replaced by the bot level).
- The "All my devices" reach mode (replaced by an explicit list).
- `RemoteBotsPort` and the hand-written handlers in `remoteBotMethods`, the two `KEYS` tables (`RemoteBots.ts`, `registerMethods.ts`) and the hand-written bot rows in `METHOD_ACCESS`: all generated from `BOT_METHODS`.
- The `bots_chat` and `bots_manage` access classes (replaced by the levels; `speech.*` gets a class of its own).
- The refusal of every remote caller in `bots.devices.*` and `bots.permissions.set` (replaced by the Full level; local callers other than the window are still refused).
- `bots` in the threads lists stream (replaced by the bots feed).
- `bots.chat.attachment` (replaced by `bots.chat.file`).
- Polling for remote rows; local bots keep `useBotsPolling` until it is replaced separately.

`withHiddenBots` stays as it is: a computer serving a thread can't know whether the reader reaches a bot that lives on a third computer, so it keeps naming such a bot "a bot".

## How this was decided

Design level 2. Two proposals were written alone from the same brief: A (Gemini 4 Neon) and B (Claude Opus 5.5). A fresh Gemini 4 Neon that wrote neither judged them against a rubric written first, and the planning agent marked them too.

**A** put desktop bot calls on the routed thread path (`ROUTED_METHODS`, `OwnerRoutes`) and kept the phone table as it was. **B** made one bot table for both and its own router and streams. Both used qualified bot ids, the lists stream, a viewing-side copy and local marks.

| Criterion | A (judge / planner) | B (judge / planner) |
|---|---|---|
| 1. One owner per state | partly / partly: local read marks split from `bots.db` | partly / partly: same; fixed above by keeping all read state in `bots.db` |
| 2. Rules kept by structure | partly / partly | partly / met: the judge counted facts about the code still to change (engine allowlist, staging class) |
| 3. Phones (#2023) and later bot features fit | not met / not met: two tables for ever | met / met |
| 4. Parts replaceable alone | partly / partly: a bot exception in `OwnerRoutes`, thread checks changed in three places | met / met |
| 5. No compatibility layer without its removal | not met / not met | not met / not met: a phone shim; removed above, since phones follow the levels and no older build is kept |
| 6. Use without Full; setup only with Full; one place | partly / partly: the right tiers, but the phone table at `bots_manage` was a way around them | not met / not met: answering asks and taking over the browser below Full; fixed above by A's tiers |
| 7. Offline copy, nothing queued, no trace after access is lost | partly / partly | partly / partly: both kept rows marked "not shared" on refusal; fixed above |
| 8. Never waits on another computer; bot chat never behind threads | partly / partly: 1 MiB stream frames can't cross | partly / partly: pictures as stream records can't cross; fixed above by the `mousse.botview` stream |

The judge and the planner both chose **B**, grafting from A its strict two levels for using and setting up a bot, and its telling metadata and live reply text on the feed. The owner then made bot access its own setting per device instead of borrowing thread access, and made each bot's Devices an explicit list that starts at its own computer. One read of the finished document by a fresh reviewer then added: Full bot access never widening thread access, the calls kept to the window, bot staging and bot streams standing apart from thread sharing, read state owned by the bot's computer, the mousse-net label change, and the maker's place in a bot made elsewhere.

**Rejected:**

- **A as a whole:** two tables for ever, and thread routing bent to fit bots.
- **The smallest change** (point the desktop at the phone table as it stands): keeps bot access tied to thread access and the thread lists.
- **A level per bot per device:** more than the owner asked for. Each bot's Devices list already narrows it per bot.

**Worth revisiting** if owners want a device to use some bots and set up others (a level per bot), or if the bots feed grows large enough that one snapshot per change costs too much.

## Unknowns to run first

Each is a throwaway spike that answers yes or no before the slice that needs it:

1. With `mousse.botview` added to the helper's labels, can that stream carry ~60 KB pictures at 5 per second, newest only, without slowing RPCs and thread streams on the same session?
2. Does `NetEngineService` admit a reader-bound private stream of a bot kind with thread sharing off, with reach checked on every read?
3. Can `bots.stage` reuse the blob path under `routed.stage` (`BridgeArtifacts`) with its own admission and cleanup, or does it need its own store?
4. Does `bridge.access.mine` (or its replacement) tell the caller its bot level on each computer?

## Slices

Each slice ends with one check. What needs two computers is checked on the PC and the Mac mini; it is listed as not checked until then.

1. **Access.** The bot level per device in place of the two switches, set by the presets; each bot's Devices as an explicit list starting at its own computer, with the update rule above; the Devices step in New bot. `BOT_METHODS` with levels, a bot named on every row (`botId` on `bots.actions.answer`), the thread-ceiling rule for Full-access grants and the `local` rows, generating the local and remote registrations and `METHOD_ACCESS`; `speech.*` on its own class; phones follow it. *Check:* the table test, and gate tests for Off, Use and Full against every row, including a Full device with a lower thread ceiling.
2. **Thin slice, end to end.** The bots feed; `RemoteBotRegistry` with its copy; `BotRouter` with fast failure when offline; `bridge.bot.open` with `AttachedBots`; bot streams admitted apart from thread sharing; read state through `bots.chat.markRead`; `RemoteBotChats`; the merged list with the badge and offline state; a remote chat in text, read-only when offline. The engine allowlist entries. *Check:* tests that a lost reach drops the row and the copy; the PC opens and chats with a Mac bot.
3. **Marks, filter and menu.** `bot-marks.json`, pin, hide, mute, marked unread, the filter and the right-click menu. *Check:* store tests for order and filter.
4. **Notifications.** Telling metadata on the feed and `RemoteBotTellings`. *Check:* tests that a start or reconnect tells nothing and mute holds.
5. **Files and images.** `bots.stage` and staged sends, and `bots.chat.file` in place of `bots.chat.attachment`. *Check:* a picture sent from the PC shows on the Mac and back.
6. **Setup from another computer.** The Full rows, About and the menu from a remote device, and New bot "Lives on". *Check:* gate tests; making a bot on the Mac from the PC.
7. **Applets.** The bot-scoped applet rows. *Check:* a bot's applet opens on the PC.
8. **Browser view.** The `mousse.botview` label in mousse-net's helper (a mousse-net PR and a new pinned engine commit) and in `ENGINE_LABELS`; the stream; watching at Use, taking over at Full, holds released as above. *Check:* spike 1's numbers, and watching a Mac bot's browser from the PC.
