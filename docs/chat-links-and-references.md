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

An agent's reply (a thread's or a bot's) draws every thread link as a chip: the thread's title (or the link's own text, when it has some), and its live status from the thread list (Working, Waiting, Needs you, Paused, Done, Archived; nothing for a quiet thread). A click switches the main view to that thread in the same window; the window's thread history records the switch, so Back returns to the thread with the chip. The chip also says when the thread cannot be reached. One this window does not list says why, and a click repeats it in a toast instead of opening anything; a listed thread whose computer is not connected still opens, as its sidebar row does, with what it last said:

| The window | The chip says |
|---|---|
| Lists the thread | Its title and status |
| Lists it, but its computer is not connected, or stopped sharing its threads | Its title, and "<computer> is offline" or "is not sharing" |
| Does not list it, and the id names a computer that is not connected (or unknown), or stopped sharing | "A thread on another computer", and why |
| Does not list it otherwise | "A thread", struck through, "Deleted" |

Only links become chips. A thread id written in prose, or a link inside inline code or a code block, stays text.

When an agent starts a thread with `thread_create`, Mousse writes a note on the agent's thread with a `launchedThread` field (`ChatMessage.launchedThread`), drawn as "Started", the new thread's chip, and the model, mode and place it chose. The new thread shows "Started by an agent in «title»" at its top (`ThreadStartedByBar`), whose title opens the launching thread; a launcher that is no longer listed is named without a link.

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

Project/thread metadata paths must be resolved in the daemon for the active profile. Use `ChatReferenceMetadataResolver`: thread references point to `ThreadDataStore.getThreadDir(id)/meta.json`; project references point to the active profile's actual `projects.json`. Renderer code must not infer profile storage paths. The composer resolves these references before attachment and again before send; a profile/thread change invalidates an in-flight result.

Pill activation is resource-first: projects open the Files view, threads select their chat, terminals select their owning thread/view/session, agent references (from older versions) open their owning thread, browser references open an internal browser tab, and only file references dispatch `mousse:open-file`.
