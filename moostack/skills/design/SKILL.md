---
name: design
description: Turn a large goal with no plan yet into an architecture that lasts. Use before slice when the work is a new subsystem, a replacement for one, or a change to how parts of the system talk to each other. Three levels set how many independent proposals are made and who picks. It produces a design document and a decision; it does not implement.
---

# Design

A workaround is what you get when the first idea that fits the current code is built. A design that lasts comes from stating the problem without a solution in it, comparing shapes that really differ, running the facts each one depends on, and deciding once. This is the one stage where slow is fast: a wrong shape is paid for in every slice after it.

Skip this skill when the current shape is sound and only lacks a feature. Go to [slice](../slice/SKILL.md).

## Pick the level

The level follows what the choice costs to undo, not how much code it is. Use the highest level any part reaches.

| Level | For | Who proposes | How it is decided |
|---|---|---|---|
| 1 | A design inside one area that is cheap to undo | You, two or three options | The human picks |
| 2 | A design that crosses areas, a new subsystem, or a replacement for one | Two proposers from different model families, and a third when the two disagree on shape | A rubric and one outside judge, then the human picks |
| 3 | A protocol, storage format or security boundary that is costly to change once it ships | Three proposers from different model families | A [council](../council/SKILL.md) judges them against the rubric and names the winner; a split goes to the human |

When the human names a level, use it. Otherwise say the level and why in one line. Levels 2 and 3 spend usage on other models, so wait for the go, and ask in that same line for the model families and, at level 3, the yes to the council. Reuse those answers for the rest of the design.

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

## 3. Write the rubric

Before any proposal exists, write the criteria the design will be judged on. Every design is held to these five:

- Every piece of state has one owner.
- The rules are kept by structure (a type, one module, a state machine), not by every caller remembering.
- The next two features you already know are coming fit without moving a boundary. Name them.
- Each part can be replaced or deleted on its own.
- No compatibility layer without the slice that removes it.

At levels 2 and 3, add up to three criteria this problem needs, each one a reader can grade, such as "a phone that was offline for a week recovers without a second device". Proposers never see the rubric; it belongs to whoever judges.

## 4. Get options that differ

Each option gives the shape (where each piece of state lives, which part owns it, where the boundaries are), what it makes easy, what it makes hard, what it costs to undo, the facts it depends on, and the thin slice it would build first. The smallest change to the current design is always one of the options.

- **Level 1:** write two or three options yourself.
- **Levels 2 and 3:** each proposer writes a full proposal alone. They run in parallel, so this costs the time of one. Every proposer gets the same brief: sections 1 and 2 with pointers to the code, and nothing else. No other proposal, no favourite of yours, no hint at an answer. You write none of them; add one yourself only when no proposal is the smallest change.

Read every proposal to the end, then:

- **They agree on the shape:** take it. That is strong agreement, and no judge is needed.
- **Two proposers disagree on the shape (level 2):** add the third proposer.
- **They solve different problems:** the brief was unclear. Fix sections 1 and 2 and run again. Never average proposals.

## 5. Run the unknowns

Each option rests on facts: "a browser worker can hold this key", "SSH stdio can carry the stream". List them. For every fact that would kill an option if false, write a throwaway spike that runs and answers yes or no. Spikes live in a scratch branch or a `spikes/` folder and never ship. Do not decide on a guess you could have run.

## 6. Judge and decide

Proposals are labelled A, B and C before anyone judges them, with no word of who wrote which. Each criterion is marked met, partly met or not met, with the reason. There is no overall number.

- **Level 1:** mark your options against the rubric and show them to the human with your recommendation first. The human picks.
- **Level 2:** one judge marks the proposals against the rubric. The judge is a fresh subagent that wrote no proposal, from a model family other than yours when one is available. Mark them yourself as well, then compare. Where you and the judge differ, one of you is biased or a criterion was vague: reread both reasons before recommending. Show the human the options, both sets of marks and your recommendation first. The human picks.
- **Level 3:** the council judges. Both members get the labelled proposals, the rubric and the spike results, mark every criterion with proof for any claim about the code, and name the proposal they would build. When both name the same one, that is the decision; tell the human and go on. When they differ, show the human each side in two lines and wait. One round.

Nobody deliberates. Proposers do not read each other's proposals and judges do not confer, because a group that talks tends to settle on a blend that nobody designed.

## 7. Graft, and record the decision

The chosen proposal is the base. Walk the others once for what is worth keeping, usually one or two things each, and fold them in by hand with the reason. Do not blend shapes: the result must still read as one design.

Signs of a workaround to remove before recording: a flag or special case added at call sites, state kept in two places, a rule that holds only if callers behave, or "temporary" with no removal planned.

Record in the document: what was chosen, what was rejected and why, the marks, and what would make it worth revisiting.

## 8. Plan the proof

- **The thin slice.** The smallest path through every layer of the chosen design that a person can run end to end. It is the first slice built and it proves the boundaries.
- **A check per phase.** One command that shows the phase works. What cannot be checked without hardware, an account or a second machine is listed as not checked, never assumed.

## 9. Hand off

- **Levels 1 and 2:** the finished document gets one read by someone who did not write it ("Reviewing a plan" in [review](../review/SKILL.md)).
- **Level 3:** the council has read the proposals. It reads the finished document again only when grafting changed the shape.

The document goes in `docs/plans/<name>.md`, merged as a documentation PR and linked from the tracking issue. Then [slice](../slice/SKILL.md) cuts it. When a later slice shows the design was wrong, change the document first, then the code.
