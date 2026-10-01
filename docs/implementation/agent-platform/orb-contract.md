# Liquid Glass Orb component contract

The root coordinator implemented the orb, palette design, appearance controls and visual fixture. Implementation workers must consume these components without changing the orb or its design. Report issues to the root coordinator.

Import `OrbAppearanceEditor` from `src/renderer/components/orb/OrbAppearanceEditor`. Pass the draft visual metadata as `value`, a callback that copies `{ ...appearance }` into the draft visual record, the current agent `name`, its short `description`, and optional `readOnly` / `active`. The component performs no persistence or execution calls. Publish/save controls belong to the Agent Editor. Appearance edits must retain the execution revision.

Use `LiquidGlassOrb` with `compact` for static list thumbnails. Supply `label` only where the surrounding text does not already name the agent; otherwise the decorative orb is hidden from assistive technology. `active={false}` suspends motion for a retained but hidden editor route. Intersection and document visibility also suspend animation.

`normalizeOrbAppearance(unknown)` validates imported metadata before producing CSS variables: six named palettes or two to four hex colors, finite unit-range luminance/translucency/motion, a boolean parallax preference and a bounded deterministic seed. Never insert arbitrary imported CSS or SVG. Invalid/old metadata falls back to Aurora.

The desktop parent provides a definite available height and a `1fr 1fr` grid at 1100 CSS pixels and above. Place the identity component in the left cell; make only the right settings cell scroll. Header/actions sit above both cells. Below 1100 pixels the parent switches to one outer scroll region; the identity component supplies its compact internal composition. Reuse `tests/fixtures/agent-platform/orb-preview.tsx` as a layout example, not as the production editor implementation.

Run `npm run test:orb`. The runner starts a loopback-only Vite fixture on an ephemeral port and a hidden, sandboxed Electron renderer with separate test userData; no model/provider/browser account is involved. Evidence appears in `.mousse-dev/orb-evidence`. The fixture checks palette changes, wrapping keyboard arrows, reduced motion, equal desktop halves, stacked narrow layout, horizontal overflow and forced-color fallback. It also saves dark/light/controls/narrow/high-contrast screenshots for visual review.

Initial visual review corrected an overlap on shorter editor windows and narrow-grid text alignment. Actual Agent Editor save/restart behavior is part of A02/E2E-01, not established by this fixture.
