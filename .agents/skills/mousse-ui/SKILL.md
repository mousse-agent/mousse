---
name: mousse-ui
description: Mousse's UI/UX principles for designing or reviewing any renderer surface (settings pages, dialogs, menus, lists, pickers). Use before building or restyling UI in src/renderer, and when judging whether a screen is "slop".
---

# Mousse UI

Mousse should feel calm, intentional and quietly lit. Every element earns its place; anything that does not change a decision or carry information is removed. When in doubt, take something away.

The concrete tokens and per-rule CSS live in the comment at the top of `src/renderer/styles/settings.css`. This skill is the reasoning behind them; apply it everywhere, not only in Settings.

## 1. Intent before layout

- **Every control must be intentional.** Before adding or keeping a setting, check that something reads it (`rg` the key) and that a sensible default would not serve nearly everyone. Remove dead settings, debug knobs and duplicates of controls that exist elsewhere.
- **One decision, one control.** Provider + model + effort + speed is one choice: one model picker. A policy with an on/off and a number is one select ("Never / After 7 / 30 / 90 days").
- **A page must deserve to exist.** A page with one setting is merged into the page it belongs to (Notifications → General, Context → Agents). A page that restates the build (an update channel you cannot really choose) is removed; keep only the action ("Check for updates").
- **Show only what the user has.** List added providers, installed models, own skills. The catalog of what could be added lives behind an action ("Add provider", "Get more models") in a picker or dialog the user opens, picks from and closes.
- **Progressive disclosure is for the genuinely rare.** One "Advanced" disclosure per page at most. Things people commonly change (chat titles) are never hidden.

## 2. Say less

- **Never state the implied.** No "This device · <name>" when there is one device and no choice; no "runs on this computer" on every row of a dialog about local models; no description that restates its heading; no "Read-only" when a group heading already says where items come from.
- **Context only when there is a choice or ambiguity.** If a selector would have one option, show nothing.
- **Let styling carry state, not sentences.** A dimmed row is disabled; a green / amber / red status word or dot says ready / needs attention / failed; exact wording goes in the tooltip or aria-label.
- **One line of copy, plain words.** No policy essays, no jargon ("orchestrator", "registry", "expose", "RNNoise"), no word repeated across rows. Errors are actionable.
- **No placeholder chatter.** Never show "Loading settings…": render the shell immediately and show a small, delayed (≈160ms) custom loader only where data is pending. Empty states are one muted line.

## 3. Hierarchy

- **Type scale (one, everywhere):** page title 17/600 · section heading 16/600 · heading subtitle 13/400 secondary · row title 13.5/400 · row description and control text 12.5/400, quieter than a subtitle. A heading must never look like a row.
- **Grouping by distance (Gestalt proximity):** space above a section (32) ≫ heading to first row (8); a description sits closer to its title (4) than to the next row.
- **One row anatomy:** text left, one control right, vertically centred, hairline divider between rows, none after the last.
- **One readable column** (~720px): text left edges and control right edges line up down the page.
- **One spacing scale** (4 / 8 / 12 / 16 / 24 / 32 / 48). Every gap has a token, and therefore a reason.

## 4. Surfaces and the specular identity

- **Lighting, not boxes.** Mousse's identity is specular light from above: `--ui-specular` (top inner glint + dark bottom lip), `--ui-sheen`, `--ui-glint` in `polish.css`. Raised things are lit, not outlined.
- **One subtle surface per group, nothing else.** A group's rows sit on one barely lifted surface with no border; its only outline is a very mild specular edge. It must be discernible over the page, but never strongly separated from it.
- **Never nest.** No container inside a container. Expanded rows and sub-rows stay on their group's surface; a sub-group is a sibling surface; a disclosure is not a surface.
- **No cards for their own sake**, no icons inside cards, no padding without a reason, no gradients beyond the app sheen, no coloured glows.
- **Dialogs** are the surface. Compact: tight, token-based padding, no divider under the header or above the footer. A title only when the content does not already name the task (a "Create skill / Upload package" choice needs no "Add skill" title); keep an `aria-label`. Close is a 28px icon button. Inside, the same group/row anatomy without inner surfaces. No intro paragraph unless it changes a decision. No footer button that duplicates the close button.
- **Compact by default.** Icon and label share a line (icon left of the title, not stacked above it); a title and its subtitle sit tight (2–4px); option tiles are one-row choices, not tall cards. Every gap must be explainable.

## 5. Colour and icons

- **Colour means identity, state or status. Never decoration.**
  - Identity: one categorical hue per nav item, shown only at icon scale (tinted nav tile, that page's heading icons).
  - State: the accent fills an "on" switch and tints the selected nav row. Do not spread the lilac accent; one accent-filled primary action per screen at most, and usually none (neutral buttons).
  - Status: success / warning / danger on status words or a small dot by the name, never next to a switch.
- **Icons wherever they can replace or clarify text**, not only where strictly necessary: nav items, logos that identify a row, section-heading icons (bare, 15px, all-or-none per page), and **icon-only buttons for common actions** (download, cancel, delete, retry, refresh, edit, add, copy, open, more) with a tooltip and aria-label. Keep a text label only where the action is uncommon, destructive-and-final, or ambiguous as an icon. Use one icon family (Hugeicons), consistent sizes (14px in controls, 15px in headings).
- **When a page hue collides with a status colour** (e.g. a green page hue next to success green), use the accent for that page's action icons so status colours keep one meaning.
- **A touch of colour on icons is welcome** in small doses: the accent or the page hue on a row's primary action icon, success green on an "installed/connected" check, the accent on a progress ring. Never colour a whole row, block of text or surface.
- **Selection is a filled background** (plus the shared specular top light). Never side or edge bars.

## 6. Controls

- **Same height for every control** (28px), same radius, same text size. Switches are a light 28×16 track.
- **On/off is always the shared `Switch`** in a row (title left, switch right), never a native checkbox. The only checkbox allowed is an explicit consent in a destructive flow, and it must still be themed. Every control must actually work: verify it toggles and saves.
- **One dropdown language** for every menu (custom `ui/Select`, the model menu, context menus): themed raised surface, compact rows, neutral hover, checkmark or neutral raised fill for the selected item, never an accent tint, never the OS-drawn native popup.
- **Buttons** are neutral (`.settings-btn`) by default; common actions are icon buttons (`.settings-icon-btn`, 28px square, tooltip required); destructive actions confirm.
- **Search fields** are soft-filled, borderless, with a leading icon and a clear button.
- **Data viz:** no bars for unbounded counts (show the number, compact units); a small ring gauge only for a true ratio; never render an indicator for zero or missing data.

## 7. Lists

- **Deduplicate** by name; show the copy in effect and mention other sources in its one description line.
- **Separate what the user owns from what was discovered.** Items from other apps go in a collapsed "From other apps · N" sub-group without controls.
- **Status near the name**, actions in a "…" menu, the one primary control on the right.

## 8. Process

- Read the relevant references before inventing: NN/g (proximity, progressive disclosure), Apple HIG, Fluent 2, Material 3, and the app's own `polish.css` tokens.
- Build on the shared primitives in `src/renderer/components/settings/` (`SettingsGroup`, `SettingsRow`, `Segmented`, `Switch`, `SettingsAdvanced`, `SettingsSearch`) and `ui/Select`, `ui/Modal`. Extend a primitive rather than restyling one page.
- Verify by looking: capture the visible Mousse window with `%TEMP%\mousse-shots\shot.ps1`, or render the real CSS in a headless browser for dark, light and high contrast.
- Before calling a screen done, ask of every element: does it change a decision or carry information? If not, remove it.
