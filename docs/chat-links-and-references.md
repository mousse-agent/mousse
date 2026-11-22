# Chat links and references

## File links emitted by agents

Use this canonical Markdown target to open a file in Mousse's **Files** view:

```text
mousse-file://open?path=<URL-encoded-path>&line=<1-based-line>&column=<1-based-column>
```

Example:

```markdown
[Open the parser](mousse-file://open?path=C%3A%5Cwork%5Capp%5Csrc%5Cparser.ts&line=42&column=7)
```

`line` and `column` are optional. Paths may be absolute Windows/POSIX paths or paths relative to the active project. Mousse also recognizes common agent output such as `src/parser.ts#L42C7` and `C:\work\app\src\parser.ts:42:7`. File activation is delivered through:

```ts
window.dispatchEvent(new CustomEvent('mousse:open-file', {
  detail: { path, line, column, threadId, projectId }
}))
```

## Thread links

A link to a Mousse thread uses this target:

```text
mousse://thread/<threadId>
mousse://thread/<node>:<threadId>
```

The second form names a thread of another of the user's computers by its node id (`nod_…`) and its id there, as the merged lists do (`src/shared/threadRef.ts`). `parseThreadLink` in `src/shared/threadLink.ts` is the one parser. The thread tools (`thread_create`, `thread_list`, `thread_search`, …) return the link as `link`, so an agent can put it in its reply, bare, as `<…>` or as `[text](mousse://thread/<id>)`.

An agent's reply (a thread's or a bot's), and a person's sent message, draws every thread link as a chip in place, in the flow of the text: the thread's title (or the link's own text, when it has some), and its live status from the thread list (Working, Waiting, Needs you, Paused, Done, Archived; nothing for a quiet thread). A click switches the main view to that thread in the same window; the window's thread history records the switch, so Back returns to the thread with the chip. The chip also says when the thread cannot be reached. One this window does not list says why, and a click repeats it in a toast instead of opening anything; a listed thread whose computer is not connected still opens, as its sidebar row does, with what it last said:

| The window | The chip says |
|---|---|
| Lists the thread | Its title and status |
| Lists it, but its computer is not connected, or stopped sharing its threads | Its title, and "<computer> is offline" or "is not sharing" |
| Does not list it, and the id names a computer that is not connected (or unknown), or stopped sharing | "A thread on another computer", and why |
| Does not list it otherwise | "A thread", struck through, "Deleted" |

Only links become chips. A thread id written in prose, or a link inside inline code or a code block, stays text.

When an agent starts a thread with `thread_create`, Mousse writes a note in the agent's thread's record with a `launchedThread` field (`ChatMessage.launchedThread`): the new thread, and the model, mode and place it chose. The chat does not show the note, because the agent's reply names and links the new thread; agents that read the thread (`thread_read`) see it. The new thread shows "Started by an agent in «title»" at its top (`ThreadStartedByBar`), whose title opens the launching thread; a launcher that is no longer listed is named without a link.

HTTP(S) links open in a new Mousse built-in browser tab. Unsafe and unsupported schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `mailto:`, and `tel:`) are not navigated.

## Drag references

Internal drag sources use MIME type `application/x-mousse-reference` with JSON:

```ts
{
  kind: 'file' | 'project' | 'thread' | 'terminal' | 'browser' | 'agent',
  title: string,
  path?: string,
  threadId?: string,
  projectId?: string,
  tabId?: string,       // terminal/browser tab
  sessionId?: string,   // terminal/agent PTY
  url?: string,         // browser (HTTP(S) or about:blank)
  agentId?: string,
  cwd?: string,
  // metadataPath is daemon-produced; drag sources must not fabricate it
}
```

The composer validates this untrusted payload, displays a removable blue titled link, and permits an attachment-only send. References are persisted per profile/thread. Sent messages contain a hidden, reconstructable reference block plus human-readable path/session context for the model.

Project/thread references are resolved in the daemon for the active profile with `ChatReferenceMetadataResolver`: a thread reference gets the thread's live title and no file path; a project reference points to the active profile's actual `projects.json`. A thread of another computer (a qualified id) is not resolved here. Renderer code must not infer profile storage paths. The composer resolves these references before attachment and again before send; a profile/thread change invalidates an in-flight result.

## Thread references

Right-click a thread wherever it shows (a sidebar row, a Nest row, a subagent card, a thread chip, a thread a bot started) and choose **Copy reference**: it copies the thread's link, `mousse://thread/<id>` (with `<node>:` for a thread of another computer). Pasting it into a composer inserts the link as text at the caret, in the line being typed, like any other paste; the sent message draws it as the thread's chip in place (`promptSegments`), and the agent gets the link in the text and reads it with its thread tools. Dragging a sidebar thread onto the composer adds a thread pill instead.

The agent gets the thread by reference, never its transcript. In a thread chat, a pill goes into the message's `[Mousse references]` block as the thread's title, `Link` and `Thread ID`, and a line telling the agent to read it with `thread_read`, as far as the request needs:

| `thread_read` view | Holds |
|---|---|
| `summary` | Title, project, model, status, when its last turn completed, its linked pull request, how many messages; none of its content |
| `recent` | Its last turns (3 by default, `turns` up to 10): each prompt, one line per step before the final answer, and the final answer, trimmed; `fromIndex` says where to page the full messages from |
| `messages` | The full transcript, paged |

In a bot chat, a pasted link stays where it was pasted, and each pill is sent as the thread's link on a line of its own, which the chat draws as the thread's chip; the bot reads it the same way with "use your threads", and asks for that permission without it.

The usual reach applies to every view. A private thread can be referenced only from a private thread, and a bot is never given a private thread; the composer refuses one with one line, and a refused paste is not inserted (`pastedThreadRefusal`). A bot reads a subagent as far as it reaches the thread that started it. A thread of another computer is read there, as that computer allows.

Pill activation is resource-first: projects open the Files view, threads select their chat, terminals select their owning thread/view/session, agent references (from older versions) open their owning thread, browser references open an internal browser tab, and only file references dispatch `mousse:open-file`.
