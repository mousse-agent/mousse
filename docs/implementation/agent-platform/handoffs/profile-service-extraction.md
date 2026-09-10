# Profile service composition prerequisites

Root continuation after `91e5bbe`. `MmsProfileServices` contains the existing personal service graph and never acquires/releases an installation lease or initializes/stops shared provider authentication. `MousseMainService` remains the compatibility facade and sole owner of shared providers and the installation lease. Existing startup behavior is preserved; multiple profiles are not yet enabled.

`MousseConfigStore.loadInstallation` persists infrastructure and unknown top-level fields without personal defaults. `loadProfile(profileRoot, installationConfig)` persists personal sections and reads shared MMS/features live. Personal writes on the installation store and prototype-polluting dotted paths are rejected. These scoped constructors are for post-migration composition; the current default startup still uses the legacy full config until migration and protocol binding land together.

Channel pairing now captures the store root. Thread trash operations capture profile roots and reject trash-path escapes, including symlink chains; strict personal mode also checks original thread-data containment. WorktreeManager captures the shared installation worktree root, which remains separate from personal transcript roots.

Validation: typecheck passed; 86 tests across seven focused files passed (profile-store injection, channel behavior, thread trash, owner lease, local protocol, thread mutation, Plus service integration). The local protocol checks include authenticated request flow, event replay, disconnect during turn, backpressure, and ownership cleanup.

Remaining before profile activation: scoped questions and modes in Orchestrator/LlmClient; managed integration constructor contexts; migration startup; runtime cache and connection binding; profile-filtered event replay; profile switcher and presentation state; real per-profile Plus login isolation and truthful auth responses; browser partitions. `shared.personal` currently disables repository legacy transcript discovery and inherited channel environment credentials, but it is an internal composition option rather than a completed profile runtime.
