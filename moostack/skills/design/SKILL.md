---
name: design
description: Turn a large goal with no plan yet into an architecture that lasts. Use before slice when the work is a new subsystem, a replacement for one, or a change to how parts of the system talk to each other. It produces a design document and a decision; it does not implement.
---

# Design

A workaround is what you get when the first idea that fits the current code is built. A design that lasts comes from stating the problem without a solution in it, comparing shapes that really differ, running the facts each one depends on, and deciding once. This is the one stage where slow is fast: a wrong shape is paid for in every slice after it.

Skip this skill when the current shape is sound and only lacks a feature. Go to [slice](../slice/SKILL.md).

## 1. State the problem without a solution

Write, from the request and the code:

- **Who cannot do what today**, in one or two sentences.
- **The flows a person goes through**, step by step, with the failure and undo paths: pairing, signing in, recovering, removing. Internals are designed to serve these, so they come first.
- **The rules that must hold**, five to ten checkable sentences ([slice](../slice/SKILL.md) section 1).
- **What is fixed and what is free**: what must stay compatible, what may be deleted, which platforms, what is out of scope.

Ask the human only what no code or run can answer: product choices, what may break, what is out of scope.

## 2. Read what exists

- The code for this area on the default branch, through an explorer subagent when it is large.
- Earlier attempts and work in flight: [check-related-work](../check-related-work/SKILL.md).
- Why the current shape is what it is: the PRs and issues that made it.

Then write, in one or two sentences, what is wrong at the root. "Transport, identity and pairing live in one layer, so none can be tested alone." If the honest answer is "nothing", stop and go to slice.

## 3. Get options that differ

Two or three options that differ in shape: where each piece of state lives, which part owns it, where the boundaries are. One of them is always the smallest change to the current design. Each option gives the shape, what it makes easy, what it makes hard, what it costs to undo, the facts it depends on, and the thin slice it would build first.

**Most designs:** write the options yourself.

**Really big work** gets independent proposals. That means work on the scale of a new engine: more than about ten slices, or a protocol, storage format or security boundary that will be costly to change once it ships.

- Two or three proposers, each from a different model family, each write their own full proposal. They run in parallel, so this costs the time of one. The human names the families; if they have not, ask once in one line and reuse the answer.
- Every proposer gets the same brief: sections 1 and 2 with pointers to the code, and nothing else. No other proposal, no favourite of yours, no hint at an answer.
- You write none of them. Add one yourself only when no proposal is the smallest change to the current design.
- Then compare side by side. Where they agree is probably right; where they differ is the decision to make. Two proposals that differ only in detail are one option. Do not blend them yet: a blend of three shapes is usually a fourth that nobody thought through.

## 4. Run the unknowns

Each alternative rests on facts: "a browser worker can hold this key", "SSH stdio can carry the stream". List them. For every fact that would kill an option if false, write a throwaway spike that runs and answers yes or no. Spikes live in a scratch branch or a `spikes/` folder and never ship. Do not decide on a guess you could have run.

## 5. Decide, and say why

Show the human the options side by side with your recommendation first, and, for really big work, ask in the same message for the yes to the council in section 7. This is the one point to stop and wait for an answer. Taking a part from one proposal into another is fine once a shape is chosen, when the reason is written down.

Before recommending, hold the choice against these:

- Every piece of state has one owner.
- The rules are kept by structure (a type, one module, a state machine), not by every caller remembering.
- The next two features you already know are coming fit without moving a boundary. Name them.
- Each part can be replaced or deleted on its own.
- No compatibility layer without the slice that removes it.

Signs of a workaround: a flag or special case added at call sites, state kept in two places, a rule that holds only if callers behave, or "temporary" with no removal planned.

Record the decision in the document: what was chosen, what was rejected and why, and what would make it worth revisiting.

## 6. Plan the proof

- **The thin slice.** The smallest path through every layer of the chosen design that a person can run end to end. It is the first slice built and it proves the boundaries.
- **A check per phase.** One command that shows the phase works. What cannot be checked without hardware, an account or a second machine is listed as not checked, never assumed.

## 7. Hand off

The chosen design, written up with its decision and proof plan, gets read once before it is built on.

- **Really big work** goes to a [council](../council/SKILL.md): one round, with the yes the human gave at the decision. The reviewers check the design against the code; they do not propose a new one.
- **Other designs**, and really big ones when the human says no to a council, get one read by someone who did not write it ("Reviewing a plan" in [review](../review/SKILL.md)).

After the findings are answered, the document goes in `docs/plans/<name>.md`, merged as a documentation PR and linked from the tracking issue. Then [slice](../slice/SKILL.md) cuts it. When a later slice shows the design was wrong, change the document first, then the code.
